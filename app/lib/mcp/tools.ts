// The MCP tools over posts (design section 5, "MCP tools"). Each calls the same functions the
// buttons do (content.server.ts, projects.server.ts, index.server.ts) or the AI rules on top of them
// (ai.server.ts), so a role that cannot do something in the browser cannot do it here. Each tool's
// description carries the rule that AI never rewrites Dustin's prose unasked. Books tools follow once
// stage 4 is merged.

import { SiteApiError } from "@dustinedwards/site-api/client";

import { addFinding, AiRefusal, aiPublish, itemFindings, listAiDrafts, saveAiDraft, type AiSession } from "~/lib/ai.server";
import { readDoc, readDraft } from "~/lib/content.server";
import { searchItems } from "~/lib/index.server";
import { visibleProjects } from "~/lib/people.server";
import { requireSiteProject } from "~/lib/projects.server";
import type { Action } from "~/lib/roles";
import { siteClient, SiteNotConnected } from "~/lib/sites.server";

export type ToolDeps = { fetcher?: typeof fetch; carrelOrigin: string };

type ToolContext = { env: Env; session: AiSession; deps: ToolDeps };

type JsonSchema = { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };

export type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
};

const RULE = "AI never rewrites Dustin's prose unasked.";
/** The most preview HTML a tool returns; a post's page is far smaller. */
const PREVIEW_LIMIT = 200_000;

const PROJECT = { type: "string", description: "The project's slug, from list_projects." };
const ITEM = { type: "string", description: "The post's id (its slug on the site), from search_items." };

function str(args: Record<string, unknown>, key: string, opts: { optional?: boolean; max?: number } = {}): string {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    if (opts.optional) return "";
    throw new AiRefusal(`${key} is required.`);
  }
  if (typeof value !== "string") throw new AiRefusal(`${key} must be a string.`);
  if (opts.max && value.length > opts.max) throw new AiRefusal(`${key} is longer than ${opts.max} characters.`);
  return value;
}

async function project(ctx: ToolContext, args: Record<string, unknown>, action: Action) {
  return requireSiteProject(ctx.env.DB, ctx.session.viewer, str(args, "project"), action);
}

export const TOOLS: Tool[] = [
  {
    name: "list_projects",
    title: "List projects",
    description: `The projects this person can see, with their role on each. ${RULE}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (_args, ctx) => ({ projects: await visibleProjects(ctx.env.DB, ctx.session.viewer) }),
  },
  {
    name: "search_items",
    title: "Search posts",
    description: `Lists a site's posts from Carrel's index, optionally searched by words in the title or text and filtered by status or kind. ${RULE}`,
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        q: { type: "string", description: "Words to search for." },
        status: { type: "string", enum: ["draft", "scheduled", "published"] },
        kind: { type: "string" },
      },
      required: ["project"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) => {
      const p = await project(ctx, args, "read");
      const status = str(args, "status", { optional: true });
      if (status && !["draft", "scheduled", "published"].includes(status)) throw new AiRefusal("status is draft, scheduled or published.");
      const items = await searchItems(ctx.env.DB, p.id, {
        q: str(args, "q", { optional: true, max: 200 }) || undefined,
        status: (status || undefined) as "draft" | "scheduled" | "published" | undefined,
        kind: str(args, "kind", { optional: true, max: 50 }) || undefined,
      });
      return { items };
    },
  },
  {
    name: "read_item",
    title: "Read a post",
    description: `Reads a post as the site holds it (its Markdown source and version), with Dustin's own working draft if he has one, the AI drafts saved beside it, and its flags. ${RULE}`,
    inputSchema: { type: "object", properties: { project: PROJECT, item: ITEM }, required: ["project", "item"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) => {
      const p = await project(ctx, args, "read");
      const item = str(args, "item");
      const [doc, draft, aiDrafts, flags] = await Promise.all([
        readDoc(ctx.env, p, item, ctx.deps.fetcher),
        readDraft(ctx.env.DB, p, ctx.session.viewer, item),
        listAiDrafts(ctx.env.DB, p, ctx.session.viewer, item),
        itemFindings(ctx.env.DB, p, item),
      ]);
      if (!doc && !draft) throw new AiRefusal(`There is no post ${item} on the site and no draft of it in Carrel.`);
      return { site: doc, dustinsDraft: draft, aiDrafts, flags };
    },
  },
  {
    name: "save_draft",
    title: "Save an AI draft",
    description: `Saves a draft of a post written by you, as a new AI draft beside Dustin's own. It never replaces his draft or the site's text, and it is never published; Dustin reads it in Carrel and decides whether to use it. ${RULE} Save a draft only when he asked for one.`,
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        item: ITEM,
        source: { type: "string", description: "The whole post, in the site's Markdown with its frontmatter." },
        note: { type: "string", description: "One line for Dustin on what this draft changes and why." },
      },
      required: ["project", "item", "source"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (args, ctx) => {
      const p = await project(ctx, args, "read");
      const saved = await saveAiDraft(ctx.env, p, ctx.session, str(args, "item"), { source: str(args, "source", { max: 500_000 }), note: str(args, "note", { optional: true, max: 500 }) }, ctx.deps.fetcher);
      return { saved: true, aiDraftId: saved.id, basedOnVersion: saved.baseVersion, where: "Beside Dustin's draft in Carrel's editor, under AI drafts." };
    },
  },
  {
    name: "preview",
    title: "Preview a post",
    description: `The site's own rendering of a post, as HTML: the given source, or else Dustin's working draft, or else the site's text. ${RULE}`,
    inputSchema: {
      type: "object",
      properties: { project: PROJECT, item: ITEM, source: { type: "string", description: "Markdown to render instead of the saved text." } },
      required: ["project", "item"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) => {
      const p = await project(ctx, args, "read");
      const item = str(args, "item");
      const source =
        str(args, "source", { optional: true, max: 500_000 }) ||
        (await readDraft(ctx.env.DB, p, ctx.session.viewer, item))?.source ||
        (await readDoc(ctx.env, p, item, ctx.deps.fetcher))?.source;
      if (!source) throw new AiRefusal("There is nothing to preview yet.");
      const html = await siteClient(ctx.env, p.site, ctx.deps.fetcher).preview({ id: item, source });
      return { html: html.length > PREVIEW_LIMIT ? `${html.slice(0, PREVIEW_LIMIT)}\n<!-- truncated -->` : html };
    },
  },
  {
    name: "get_checks",
    title: "Get a post's flags",
    description: `The flags on a post from checks and reviewers, open and dismissed. An open flag holds publish until Dustin fixes the text or dismisses it. ${RULE}`,
    inputSchema: { type: "object", properties: { project: PROJECT, item: ITEM }, required: ["project", "item"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) => {
      const p = await project(ctx, args, "read");
      const flags = await itemFindings(ctx.env.DB, p, str(args, "item"));
      return { open: flags.filter((f) => f.status === "open").length, flags };
    },
  },
  {
    name: "add_finding",
    title: "Flag a problem",
    description: `Flags a problem in a post for Dustin: a factual claim with no source, a continuity slip, a sentence that says something other than it means. A flag is a question for him, never a decision; quote the words it concerns. Reviewers flag, they never write text. ${RULE}`,
    inputSchema: {
      type: "object",
      properties: {
        project: PROJECT,
        item: ITEM,
        message: { type: "string", description: "What the problem is, in a sentence or two." },
        excerpt: { type: "string", description: "The words in the post the flag is about, quoted exactly." },
      },
      required: ["project", "item", "message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args, ctx) => {
      const p = await project(ctx, args, "read");
      const added = await addFinding(ctx.env.DB, p, ctx.session, str(args, "item"), {
        message: str(args, "message", { max: 2000 }),
        excerpt: str(args, "excerpt", { optional: true, max: 1000 }) || null,
      });
      return { flagged: true, findingId: added.id, alreadyFlagged: added.duplicate };
    },
  },
  {
    name: "publish",
    title: "Publish a post (Owner only)",
    description: `Publishes a post as it stands on the site at expected_version, on Dustin's explicit instruction in this conversation and only then. Only Dustin's own sessions may publish; a shared person's or a reviewer's never can. It is refused while any flag on the post is open. No text travels with it: it publishes what Dustin saved, never your draft. Carrel records "published by <this client> on Dustin's instruction" and emails him a link to unpublish. ${RULE}`,
    inputSchema: {
      type: "object",
      properties: { project: PROJECT, item: ITEM, expected_version: { type: "string", description: "The site's version of the post, from read_item, so an older version is never published by mistake." } },
      required: ["project", "item", "expected_version"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async (args, ctx) => {
      // Refused on the role before anything else is read, as the button is.
      const p = await project(ctx, args, "read");
      const result = await aiPublish(ctx.env, p, ctx.session, str(args, "item"), str(args, "expected_version", { max: 200 }), {
        fetcher: ctx.deps.fetcher,
        carrelOrigin: ctx.deps.carrelOrigin,
      });
      if (!result.ok) throw new AiRefusal(result.message);
      return { published: true, version: result.version, changeId: result.changeId, dustinEmailed: result.emailed };
    },
  },
];

/** Runs a tool. Every refusal comes back as a tool error the client can read, never as a protocol failure. */
export async function callTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name)!;
  try {
    const value = (await tool.run(args, ctx)) as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
  } catch (error) {
    let message: string;
    if (error instanceof AiRefusal) message = error.message;
    else if (error instanceof Response) message = error.status === 404 ? "Not found, or not shared with this person." : "Forbidden: this person's role does not allow that.";
    else if (error instanceof SiteNotConnected) message = `The site is not connected: ${error.detail}`;
    else if (error instanceof SiteApiError && error.body) message = `The site refused: ${error.body.message}`;
    else {
      console.error(JSON.stringify({ mcp: "tool-failed", tool: name, error: String(error) }));
      message = "The tool failed unexpectedly. Check the post in Carrel before trying again.";
    }
    return { content: [{ type: "text", text: message }], isError: true };
  }
}
