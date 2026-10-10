// A small MCP client for the tests, speaking to the real protocol layer (app/lib/mcp/server.ts)
// in either era: 2026-07-28, stateless with the per-request envelope, and the 2025-11-25 era the
// legacy shim answers. The session (the person and the AI client) is what the door would have found
// from the OAuth token; door.test.ts drives the door itself.

import { createExecutionContext } from "cloudflare:test";
import { expect } from "vitest";

import { SCOPE_READ, SCOPE_WRITE } from "~/lib/mcp/scopes";
import { handleMcp } from "~/lib/mcp/server";
import type { ToolDeps } from "~/lib/mcp/tools";

import { testEnv } from "./env";
import { viewerFor } from "./site";

export const MCP_HOST = "carrel-mcp.test";
export const MCP_URL = `https://${MCP_HOST}/mcp`;
export const MODERN = "2026-07-28";
export const LEGACY = "2025-11-25";

export type ToolCallResult = { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

type RpcMessage = { jsonrpc: "2.0"; id?: number | string | null; result?: Record<string, unknown>; error?: { code: number; message: string } };

/** The one JSON-RPC message in a response, whether the SDK answered in JSON or as one SSE event. */
export async function readMessage(response: Response): Promise<RpcMessage> {
  const text = await response.text();
  if ((response.headers.get("Content-Type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    return JSON.parse(data) as RpcMessage;
  }
  return JSON.parse(text) as RpcMessage;
}

/** A 2026-07-28 request: the protocol version travels on every request, in a header and in _meta. */
export function modernRequest(id: number, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): Request {
  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientInfo": { name: "carrel-tests", version: "1.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  return new Request(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Host: MCP_HOST, "MCP-Protocol-Version": MODERN, "Mcp-Method": method, ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

/** A 2025-era request, answered by the legacy shim. */
export function legacyRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Host: MCP_HOST, ...headers },
    body: JSON.stringify(body),
  });
}

export type Connection = {
  send: (request: Request) => Promise<Response>;
  list: () => Promise<{ name: string; description: string }[]>;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolCallResult>;
};

/**
 * An AI session for a person, as the door hands it over: the person, the client the grant was issued
 * to, and the grant's scopes (read and write unless `scopes` says otherwise). Calls go out in the
 * 2026-07-28 era unless `era` says otherwise.
 */
export async function connectAs(
  email: string,
  client = "Claude",
  opts: { env?: Env; deps?: Partial<ToolDeps>; era?: "modern" | "legacy"; scopes?: string[] } = {},
): Promise<Connection> {
  const viewer = await viewerFor(email);
  const env = opts.env ?? testEnv;
  const deps: ToolDeps = { carrelOrigin: "https://carrel.test", ...opts.deps };
  const send = (request: Request) => handleMcp(request, env, createExecutionContext(), { viewer, client, scopes: opts.scopes ?? [SCOPE_READ, SCOPE_WRITE] }, deps);
  let id = 1;
  async function rpc(method: string, params: Record<string, unknown>) {
    id += 1;
    const request =
      opts.era === "legacy" ? legacyRequest({ jsonrpc: "2.0", id, method, params }, { "MCP-Protocol-Version": LEGACY }) : modernRequest(id, method, params);
    const response = await send(request);
    if (response.status !== 200) expect.fail(`${method} answered ${response.status}: ${await response.text()}`);
    const message = await readMessage(response);
    expect(message.error, JSON.stringify(message.error)).toBeUndefined();
    return message.result!;
  }
  return {
    send,
    list: async () => (await rpc("tools/list", {})).tools as { name: string; description: string }[],
    call: async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })) as unknown as ToolCallResult,
  };
}
