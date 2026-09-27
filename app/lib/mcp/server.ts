// Carrel's MCP endpoint, inside the Worker (design decision 7: a named exception to the wrapper
// standard, because the tools call the same functions as the buttons and need no other credential).
//
// Streamable HTTP, answered in JSON: POST /mcp carries one JSON-RPC message and gets one JSON reply
// (no server-sent stream, since no tool here streams); GET is refused; DELETE ends the session. Each
// session starts at `initialize`, where the client names itself; the session id it gets back names
// that client on every later call, so the authorship record credits it. The gate has already checked
// that the request came through the AI door and who the person is.

import { and, eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { mcpSessions } from "~/db/schema";
import type { AiSession } from "~/lib/ai.server";
import type { Viewer } from "~/lib/people.server";

import { callTool, TOOLS, type ToolDeps } from "./tools";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
const LATEST = PROTOCOL_VERSIONS[0];
/** A session no one has used for this long is gone; the client starts a new one. */
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

type JsonRpcId = string | number;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: Record<string, unknown> };

const INSTRUCTIONS = [
  "Carrel is Dustin's private writing hub. These tools read his posts, save AI drafts beside his own, flag problems, preview, and (for the Owner's own sessions) publish on his instruction.",
  "Rules: AI never rewrites Dustin's prose unasked. A saved AI draft sits beside his draft and never replaces it; he decides whether to use it. Checks and reviewers flag, never decide. Publish only when Dustin has told you to, in this conversation.",
].join(" ");

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function rpcError(id: JsonRpcId | null, code: number, message: string, status = 200): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.jsonrpc === "2.0" && typeof v.method === "string" && (v.params === undefined || (typeof v.params === "object" && v.params !== null));
}

async function openSession(db: D1Database, viewer: Viewer, params: Record<string, unknown>, now: Date) {
  const info = (params.clientInfo ?? {}) as { name?: unknown; version?: unknown };
  const name = typeof info.name === "string" && info.name.trim() ? info.name.trim().slice(0, 100) : "an unnamed AI client";
  const version = typeof info.version === "string" ? info.version.slice(0, 50) : null;
  const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
  const protocol = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST;
  const id = crypto.randomUUID();
  const at = now.toISOString();
  const d = drizzle(db);
  await d.insert(mcpSessions).values({ id, personId: viewer.id, clientName: name, clientVersion: version, protocolVersion: protocol, createdAt: at, lastSeenAt: at });
  // Idle sessions are cleared as new ones open, so the table never needs a cron.
  await d.delete(mcpSessions).where(lt(mcpSessions.lastSeenAt, new Date(now.getTime() - SESSION_IDLE_MS).toISOString()));
  return { id, protocol, client: version ? `${name} ${version}` : name };
}

/**
 * The session a request names, if it belongs to this person and is still live. A session id from
 * someone else is treated as unknown: the id alone never carries identity.
 */
async function findSession(db: D1Database, viewer: Viewer, id: string | null, now: Date) {
  if (!id) return null;
  const d = drizzle(db);
  const row = await d
    .select()
    .from(mcpSessions)
    .where(and(eq(mcpSessions.id, id), eq(mcpSessions.personId, viewer.id)))
    .get();
  if (!row || Date.parse(row.lastSeenAt) < now.getTime() - SESSION_IDLE_MS) return null;
  await d.update(mcpSessions).set({ lastSeenAt: now.toISOString() }).where(eq(mcpSessions.id, id));
  return row;
}

export async function handleMcp(request: Request, env: Env, viewer: Viewer, deps: Partial<ToolDeps> & { now?: () => Date } = {}): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const sessionHeader = request.headers.get("Mcp-Session-Id");

  if (request.method === "DELETE") {
    if (sessionHeader) await drizzle(env.DB).delete(mcpSessions).where(and(eq(mcpSessions.id, sessionHeader), eq(mcpSessions.personId, viewer.id)));
    return new Response(null, { status: 204 });
  }
  if (request.method !== "POST") {
    // No server-sent stream: nothing here pushes to the client.
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, DELETE" } });
  }
  // Browsers attach an Origin; MCP clients do not. A page elsewhere must not drive these tools.
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return new Response("Forbidden", { status: 403 });

  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (Array.isArray(message)) return rpcError(null, -32600, "Batches are not supported; send one message per request.", 400);
  if (!isRequest(message)) return rpcError(null, -32600, "Invalid request", 400);
  const { id, method, params = {} } = message;

  if (method === "initialize") {
    if (id === undefined) return rpcError(null, -32600, "initialize needs an id", 400);
    const session = await openSession(env.DB, viewer, params, now);
    return json(
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: session.protocol,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "carrel", title: "Carrel", version: "0.5.0" },
          instructions: INSTRUCTIONS,
        },
      },
      200,
      { "Mcp-Session-Id": session.id },
    );
  }

  if (!sessionHeader) return rpcError(id ?? null, -32600, "Start a session with initialize first (no Mcp-Session-Id header).", 400);
  const session = await findSession(env.DB, viewer, sessionHeader, now);
  // 404 tells the client to start a new session, per the transport's rules.
  if (!session) return rpcError(id ?? null, -32001, "Session not found; initialize again.", 404);

  // Notifications and responses from the client need no answer.
  if (id === undefined) return new Response(null, { status: 202 });

  switch (method) {
    case "ping":
      return json({ jsonrpc: "2.0", id, result: {} });
    case "tools/list":
      return json({
        jsonrpc: "2.0",
        id,
        result: { tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) },
      });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      if (!TOOLS.some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const ai: AiSession = {
        viewer,
        client: session.clientVersion ? `${session.clientName} ${session.clientVersion}` : session.clientName,
        sessionId: session.id,
      };
      const result = await callTool(name, args, { env, session: ai, deps: { fetcher: deps.fetcher, carrelOrigin: deps.carrelOrigin ?? carrelOrigin(env) } });
      return json({ jsonrpc: "2.0", id, result });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Where Carrel's pages live, for links in email: the browser door, never the AI door. The var
 * CARREL_ORIGIN (in the example config) is read loosely, because a wrangler.jsonc from before stage 5
 * does not have it and its generated types would not either.
 */
export function carrelOrigin(env: Env): string {
  const configured = (env as { CARREL_ORIGIN?: string }).CARREL_ORIGIN?.trim();
  return (configured || "https://carrel.dustinedwards.info").replace(/\/+$/, "");
}
