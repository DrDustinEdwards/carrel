// What every MCP tool file shares (tools.ts, book-tools.ts): a tool's shape, the annotation sets, the answer
// shapes, the input limits and readers, and the two lookups every book and flag tool makes. The ruling
// of 2026-10-10 and the no-role-logic rule at the head of tools.ts hold here too.

import { addFinding, AiRefusal, type AiSession } from "~/lib/ai.server";
import { requireBookProject } from "~/lib/books.server";
import type { ProjectRole } from "~/lib/content.server";
import type { Action } from "~/lib/roles";

export type ToolDeps = { fetcher?: typeof fetch; carrelOrigin: string };

/** The session as the door found it, with the scopes its grant carries (scopes.ts) and its OAuth client id. */
export type McpSession = AiSession & { scopes: readonly string[]; clientId?: string };

/** `signal` is the request's abort signal (P11); server.ts also hands it to `deps.fetcher`, so a closed stream stops the outbound calls. */
export type ToolContext = { env: Env; session: McpSession; deps: ToolDeps; signal?: AbortSignal };

export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: false;
};

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** The structured answer's shape: the fields a client can rely on (the notice is added for outside text). */
  outputSchema: JsonSchema;
  /** The scope a call needs, declared here and never read from an annotation (site-runtime's toolScope). */
  scope: "read" | "write";
  /** All four, set honestly, so a client can confirm before acting (rule 6). */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  /**
   * The answer carries text from outside Carrel: the site's posts, the novels repository, flags and
   * drafts other sessions wrote. It goes back marked as data (rule 12.5).
   */
  outside: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
};

export const RULE = "AI never rewrites Dustin's prose unasked.";

/** Longest accepted inputs, in characters: a whole file or post, a finding's message and excerpt, a draft's note, a path or id. */
export const MAX = {
  source: 500_000,
  transcript: 500_000,
  edits: 200,
  message: 2000,
  excerpt: 1000,
  note: 500,
  path: 200,
  sources: 20,
} as const;

/** Read-only, and nothing outside Carrel changes. */
export const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const ADD_HERE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export const SET_HERE = { ...ADD_HERE, idempotentHint: true };

/** A write to the site that undoes cleanly: not destructive, repeatable, and it reaches past Carrel. */
export const WRITE_SITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** A change in a Google Doc: it reaches past Carrel, never destroys (a suggestion or comment is taken back in Docs), and repeating it adds another. */
export const WRITE_GOOGLE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
/** A Docs tool that can change Dustin's text itself (a direct write, an accept, an undo): a client confirms first. */
export const CHANGE_GOOGLE = { ...WRITE_GOOGLE, destructiveHint: true };

/** An answer's shape: the fields always present, then those that may be null or absent. */
export function shape(
  always: Record<string, unknown>,
  sometimes: Record<string, unknown> = {},
): JsonSchema {
  return { type: "object", properties: { ...always, ...sometimes }, required: Object.keys(always) };
}
export const ANY = {};
export const LIST = { type: "array" };
export const YES = { type: "boolean" };
export const ID = { type: "integer" };
export const TEXT = { type: "string" };

export const FLAGGED = shape({ flagged: YES, findingId: ID, alreadyFlagged: YES });

export const BOOK = {
  type: "string",
  description: "The book's project slug, from carrel_list_projects (kind book).",
};
export const DOC = {
  type: "string",
  description: "The file's id, from carrel_list_docs.",
};
export const BOOK_PATH = {
  type: "string",
  description:
    "The file's path in the book, such as chapters/01-arrival/01-the-gate.md, from carrel_list_book_files.",
};

export function str(
  args: Record<string, unknown>,
  key: string,
  opts: { optional?: boolean; max?: number } = {},
): string {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    if (opts.optional) return "";
    throw new AiRefusal(`${key} is required.`);
  }
  if (typeof value !== "string") throw new AiRefusal(`${key} must be a string.`);
  if (opts.max && value.length > opts.max)
    throw new AiRefusal(`${key} is longer than ${opts.max} characters.`);
  return value;
}

export async function book(ctx: ToolContext, args: Record<string, unknown>, action: Action) {
  return requireBookProject(ctx.env.DB, ctx.session.viewer, str(args, "project"), action);
}

/** Flags `itemId` on a project for the session: the same flag twice is one flag (alreadyFlagged). */
export async function flag(
  ctx: ToolContext,
  args: Record<string, unknown>,
  target: ProjectRole,
  itemId: string,
) {
  const added = await addFinding(ctx.env.DB, target, ctx.session, itemId, {
    message: str(args, "message", { max: MAX.message }),
    excerpt: str(args, "excerpt", { optional: true, max: MAX.excerpt }) || null,
  });
  return { flagged: true, findingId: added.id, alreadyFlagged: added.duplicate };
}
