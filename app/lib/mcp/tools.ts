// The MCP tools over posts (design section 5, "MCP tools"). Each calls the same functions the
// buttons do (content.server.ts, projects.server.ts, index.server.ts) or the AI rules on top of them
// (ai.server.ts), so a role that cannot do something in the browser cannot do it here. Each tool's
// description carries the rule that AI never rewrites Dustin's prose unasked. The books tools call
// books.server.ts as the book pages do, and draft_social_post stores a post for the social queue.
//
// NO ROLE LOGIC HERE. A tool names the project and the action it needs and calls down; the function
// it calls decides whether this person may, and refuses. Asking "is this the Owner, a reviewer, an
// editor" in this file would be a second place for the rules to live, and the first time the two
// disagreed one door would allow what the other refused. check:mcp-roles fails on it.

import { SiteApiError } from "@dustinedwards/site-api/client";

import { addFinding, aiDraftSocialPost, AiRefusal, aiPublish, itemFindings, listAiDrafts, saveAiDraft, type AiSession } from "~/lib/ai.server";
import { checkDraft, indexedFile, listFiles, listFindings, requireBookProject, saveBookAiDraft } from "~/lib/books.server";
import { readDoc, readDraft } from "~/lib/content.server";
import { searchItems } from "~/lib/index.server";
import { isBookPath } from "~/lib/novels/layout";
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
const BOOK = { type: "string", description: "The book's project slug, from list_projects (kind book)." };
const BOOK_PATH = { type: "string", description: "The file's path in the book, such as chapters/01-arrival/01-the-gate.md, from list_book_files." };

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

async function book(ctx: ToolContext, args: Record<string, unknown>, action: Action) {
  return requireBookProject(ctx.env.DB, ctx.session.viewer, str(args, "project"), action);
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

  // ---------- books (stage 4), through the same functions as the book pages

  {
    name: "list_book_files",
    title: "List a book's files",
    description: `A book's chapters, scenes, bible and outline files from Carrel's index of the writing repository, with each scene's header and open flags. ${RULE}`,
    inputSchema: { type: "object", properties: { project: BOOK }, required: ["project"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) => {
      const b = await book(ctx, args, "read");
      const [files, open] = await Promise.all([listFiles(ctx.env.DB, b), listFindings(ctx.env.DB, b, { status: "open" })]);
      return {
        files: files.map((f) => ({
          path: f.path,
          kind: f.kind,
          words: f.words,
          header: f.meta.kind === "scene" ? f.meta.header : undefined,
          openFlags: open.filter((o) => o.path === f.path).length,
        })),
      };
    },
  },
  {
    name: "read_book_file",
    title: "Read a book file",
    description: `A scene, bible entry or outline file as the index last had it from Git, with its version, its flags and the AI drafts saved beside it. ${RULE}`,
    inputSchema: { type: "object", properties: { project: BOOK, path: BOOK_PATH }, required: ["project", "path"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) => {
      const b = await book(ctx, args, "read");
      const path = str(args, "path", { max: 200 });
      const [file, flags, aiDrafts] = await Promise.all([
        indexedFile(ctx.env.DB, b, path),
        listFindings(ctx.env.DB, b, { path }),
        listAiDrafts(ctx.env.DB, b, ctx.session.viewer, path),
      ]);
      if (!file) throw new AiRefusal(`There is no ${path} in this book's index. List the files, or ask Dustin to refresh the book from Git.`);
      return { path, source: file.source, version: file.sha, flags, aiDrafts };
    },
  },
  {
    name: "check_book_text",
    title: "Run the checks on text",
    description: `Runs the checks on save (header, continuity, timeline, world rules, AI habits, voice) on the given text for a book file, without saving or recording anything. The checks flag; Dustin decides. ${RULE}`,
    inputSchema: {
      type: "object",
      properties: { project: BOOK, path: BOOK_PATH, source: { type: "string", description: "The whole file, header included." } },
      required: ["project", "path", "source"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, ctx) => {
      const b = await book(ctx, args, "read");
      return { findings: await checkDraft(ctx.env.DB, b, str(args, "path", { max: 200 }), str(args, "source", { max: 500_000 })) };
    },
  },
  {
    name: "save_book_draft",
    title: "Save an AI draft of a book file",
    description: `Saves your version of a book file as a new AI draft beside Dustin's own. It never replaces his draft and is never committed to Git; he reads it in Carrel's editor and decides. ${RULE} Save one only when he asked for it.`,
    inputSchema: {
      type: "object",
      properties: {
        project: BOOK,
        path: BOOK_PATH,
        source: { type: "string", description: "The whole file, header included." },
        note: { type: "string", description: "One line for Dustin on what this draft changes and why." },
      },
      required: ["project", "path", "source"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (args, ctx) => {
      const b = await book(ctx, args, "read");
      const saved = await saveBookAiDraft(ctx.env.DB, b, ctx.session, str(args, "path", { max: 200 }), {
        source: str(args, "source", { max: 500_000 }),
        note: str(args, "note", { optional: true, max: 500 }),
      });
      return { saved: true, aiDraftId: saved.id, basedOnVersion: saved.baseVersion, where: "Beside Dustin's draft in the book file's editor, under AI drafts." };
    },
  },
  {
    name: "add_book_finding",
    title: "Flag a problem in a book file",
    description: `Flags a problem in a book file for Dustin: a continuity slip, a timeline error, a sentence that says something other than it means. A flag is a question, never a decision; quote the words. It holds export until Dustin fixes the text or dismisses it. ${RULE}`,
    inputSchema: {
      type: "object",
      properties: {
        project: BOOK,
        path: BOOK_PATH,
        message: { type: "string", description: "What the problem is, in a sentence or two." },
        excerpt: { type: "string", description: "The words the flag is about, quoted exactly." },
      },
      required: ["project", "path", "message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (args, ctx) => {
      const b = await book(ctx, args, "read");
      const path = str(args, "path", { max: 200 });
      if (!isBookPath(path)) throw new AiRefusal(`${path} is not a file in the novels layout.`);
      const added = await addFinding(ctx.env.DB, b, ctx.session, path, {
        message: str(args, "message", { max: 2000 }),
        excerpt: str(args, "excerpt", { optional: true, max: 1000 }) || null,
      });
      return { flagged: true, findingId: added.id, alreadyFlagged: added.duplicate };
    },
  },

  // ---------- social (stage 9)

  {
    name: "draft_social_post",
    title: "Draft a social post (Owner only)",
    description: `Stores a drafted social post for one account and one piece, for Carrel to lint and send when the piece is live (or now, if it already is). Name the event id Carrel gave you, or the account key, project and item. It never posts anything itself, and there is no reply. Only Dustin's own sessions may draft posts. ${RULE}`,
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "integer", description: "The event id from the routine's list of waiting items." },
        account: { type: "string", description: "The account key, such as germomics-bluesky, when there is no event id." },
        project: PROJECT,
        item: { type: "string", description: "The piece's id in that project." },
        text: { type: "string", description: "The post, in the account's voice, announcing the piece and linking it." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (args, ctx) => {
      const text = str(args, "text", { max: 2000 });
      const eventId = args.event_id;
      let result;
      if (eventId !== undefined) {
        if (typeof eventId !== "number" || !Number.isInteger(eventId)) throw new AiRefusal("event_id must be a whole number.");
        result = await aiDraftSocialPost(ctx.env.DB, ctx.session, { eventId, text });
      } else {
        const p = await project(ctx, args, "read");
        result = await aiDraftSocialPost(ctx.env.DB, ctx.session, { accountKey: str(args, "account", { max: 80 }), projectId: p.id, itemId: str(args, "item", { max: 200 }), text });
      }
      return { stored: true, postId: result.postId, next: "Carrel lints it and, by the account's switch, queues it or holds it for Dustin's approval once the piece is live." };
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
