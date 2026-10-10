// The append-only log of every tool call (ruling capsid/rulings/mcp-2026-10-10.md, rule 12.4):
// caller, arguments, result. The table (0012_mcp_calls.sql) refuses UPDATE and DELETE itself.
//
// The row is written after the call returns, with what the client was told. A failed write never
// changes the answer the client gets (the call already happened), and it is never silent: it goes to
// Workers Logs with the tool and the caller, so the gap in the table is itself on record.

import { drizzle } from "drizzle-orm/d1";

import { mcpCalls } from "~/db/schema";
import type { AiSession } from "~/lib/ai.server";

/** The most of the arguments and of the result a row keeps. */
const ARGUMENTS_LIMIT = 8_000;
const RESULT_LIMIT = 2_000;

/** Each long string cut to a preview, so a 500,000-character draft is logged by its start and its length. */
function shorten(args: Record<string, unknown>): { text: string; truncated: boolean } {
  let truncated = false;
  const shortened = JSON.stringify(args, (_key, value: unknown) => {
    if (typeof value === "string" && value.length > 1_000) {
      truncated = true;
      return `${value.slice(0, 1_000)}... [${value.length} characters]`;
    }
    return value;
  });
  if (shortened.length > ARGUMENTS_LIMIT) return { text: `${shortened.slice(0, ARGUMENTS_LIMIT)}... [cut]`, truncated: true };
  return { text: shortened, truncated };
}

export async function logCall(
  db: D1Database,
  session: AiSession,
  call: { tool: string; args: Record<string, unknown>; ok: boolean; result: string },
): Promise<void> {
  const args = shorten(call.args);
  try {
    await drizzle(db)
      .insert(mcpCalls)
      .values({
        personId: session.viewer.id,
        caller: session.viewer.email,
        client: session.client,
        tool: call.tool,
        arguments: args.text,
        argumentsTruncated: args.truncated,
        outcome: call.ok ? "ok" : "refused",
        result: call.result.length > RESULT_LIMIT ? `${call.result.slice(0, RESULT_LIMIT)}... [cut]` : call.result,
      })
      .run();
  } catch (error) {
    console.error(JSON.stringify({ mcp: "call-log-failed", tool: call.tool, caller: session.viewer.email, client: session.client, error: String(error) }));
  }
}
