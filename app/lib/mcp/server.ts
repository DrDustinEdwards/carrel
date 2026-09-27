// Carrel's MCP endpoint, inside the Carrel Worker (design decision 7, corrected 2026-09-27): Carrel
// has several people with different roles, so it verifies each token itself and maps the identity to
// its own people. The protocol is the official MCP SDK v2 through `agents`, stateless: no session is
// kept between requests, and a fresh server answers each one.
//
// By the time a request gets here the door (door.ts) has checked the OAuth token and found the active
// person it belongs to. This file only speaks the protocol. It holds no rule about who may do what:
// every tool calls the same functions the buttons do, and those functions refuse. check:mcp-roles
// fails the build if role logic appears in this folder.

import { fromJsonSchema, McpServer, type JsonSchemaType } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

import type { AiSession } from "~/lib/ai.server";

import { createLegacyEraHandler, isLegacyRequest } from "./legacy-era";
import { callTool, TOOLS, type ToolDeps } from "./tools";

/** The AI door's one path, on its own hostname (door.ts). */
export const MCP_ROUTE = "/mcp";

const SERVER_INFO = { name: "carrel", title: "Carrel", version: "0.6.0" } as const;

const INSTRUCTIONS = [
  "Carrel is Dustin's private writing hub. These tools read his posts, save AI drafts beside his own, flag problems, preview, and (for the Owner's own sessions) publish on his instruction.",
  "Rules: AI never rewrites Dustin's prose unasked. A saved AI draft sits beside his draft and never replaces it; he decides whether to use it. Checks and reviewers flag, never decide. Publish only when Dustin has told you to, in this conversation.",
].join(" ");

/**
 * The server factory, called per request: stateless means no instance outlives the call that made
 * it. The session (the person and the AI client, from the token) is closed over, never read from
 * the request.
 */
function buildServer(env: Env, session: AiSession, deps: ToolDeps) {
  return () => {
    const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
    for (const tool of TOOLS) {
      server.registerTool(
        tool.name,
        { title: tool.title, description: tool.description, inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType), annotations: tool.annotations },
        async (args: unknown) => callTool(tool.name, (args ?? {}) as Record<string, unknown>, { env, session, deps }),
      );
    }
    return server;
  };
}

/**
 * Routes one request to the era that can answer it. The host is pinned so a DNS-rebinding page
 * cannot reach the endpoint, and a browser Origin must be the MCP host itself.
 */
export async function handleMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  session: AiSession,
  deps: ToolDeps,
): Promise<Response> {
  const factory = buildServer(env, session, deps);
  const host = new URL(request.url).hostname;
  const options = { route: MCP_ROUTE, allowedHostnames: [host], allowedOriginHostnames: [host], corsOptions: false as const };

  // --- the one legacy call site, deletable with legacy-era.ts ---------------
  // The predicate reads the body, so it gets a clone: the handler needs the body too. (The cast only
  // drops the Workers-specific `cf` typing the SDK's signature does not know.)
  if (await isLegacyRequest(request.clone() as Request<unknown>)) {
    return createLegacyEraHandler(factory, options)(request, env, ctx);
  }
  // -------------------------------------------------------------------------

  // Everything the predicate calls false goes here, including malformed envelopes: the library's
  // documentation says the modern path owns those error answers.
  return createMcpHandler(factory, { ...options, legacy: "reject" })(request, env, ctx);
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
