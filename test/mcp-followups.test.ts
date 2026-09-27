// The follow-ups after the overnight merges: books through MCP, draft_social_post, a reviewer's flag
// that a recheck must not withdraw, and export refused while an import marker is left in a book.

import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { exportGate, listFindings, refreshBook, requireBookProject, saveBookFile, type BookProject } from "~/lib/books.server";
import { autosave, readDraft } from "~/lib/content.server";
import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import type { Viewer } from "~/lib/people.server";
import { handleMcp } from "~/lib/mcp/server";
import { createAccount, recordPublication, setSwitches } from "~/lib/social/queue.server";
import { action as fileAction, loader as fileLoader } from "~/routes/book.file";

import { addBook, addPerson, addProject, resetDb, share, testEnv } from "./env";
import { fakeNovels } from "./novels";
import { viewerFor } from "./site";

const SLUG = "test-book";
const HEADER = "---\npov: Wade\ndate: 2024-04-12\nlocation: Harlan place\ncharacters: [Wade]\ngoal: g\nconflict: c\noutcome: o\n---\n\n";
const SCENE = "chapters/01-arrival/01-the-gate.md";

let gh: ReturnType<typeof fakeNovels>;

async function readDraftOnly(project: BookProject, viewer: Viewer, path: string) {
  return (await readDraft(testEnv.DB, project, viewer, path))?.source;
}

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const reader = await addPerson("reader@test.invalid");
  const reviewer = await addPerson("reviewer@test.invalid", { reviewer: true });
  const id = await addBook(SLUG);
  await share(id, editor, "editor");
  await share(id, reader, "reader");
  await share(id, reviewer, "reader");
  gh = fakeNovels({
    [`${SLUG}/bible/characters/wade.md`]: "---\nname: Wade\n---\n",
    [`${SLUG}/bible/places/harlan-place.md`]: "---\nname: Harlan place\n---\n",
    [`${SLUG}/${SCENE}`]: `${HEADER}Wade opened the gate.\n`,
  });
  const owner = await viewerFor("owner@test.invalid");
  await refreshBook(testEnv.DB, gh.repo, await requireBookProject(testEnv.DB, owner, SLUG, "read"));
});

async function post(email: string, body: unknown, session?: string) {
  const request = new Request("https://carrel.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(session ? { "Mcp-Session-Id": session } : {}) },
    body: JSON.stringify(body),
  });
  return handleMcp(request, testEnv, await viewerFor(email), { carrelOrigin: "https://carrel.test" });
}

async function connect(email: string, clientName = "Claude") {
  const res = await post(email, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: clientName, version: "1.0" } } });
  const session = res.headers.get("Mcp-Session-Id")!;
  return async (name: string, args: Record<string, unknown>) => {
    const r = await post(email, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, session);
    return ((await r.json()) as { result: { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> } }).result;
  };
}

describe("books through MCP", () => {
  it("lists a book's files with each scene's header, and reads a file with its version", async () => {
    const call = await connect("reader@test.invalid");
    const list = await call("list_book_files", { project: SLUG });
    expect(list.structuredContent).toMatchObject({ files: expect.arrayContaining([{ path: SCENE, kind: "scene", words: 4, header: expect.objectContaining({ pov: "Wade" }), openFlags: 0 }]) });
    const read = await call("read_book_file", { project: SLUG, path: SCENE });
    expect(read.structuredContent).toMatchObject({ path: SCENE, source: `${HEADER}Wade opened the gate.\n`, version: gh.files.get(`${SLUG}/${SCENE}`)!.sha });
  });

  it("PLANT: a stranger's session, and a site's slug, reach no book", async () => {
    await addPerson("stranger@test.invalid");
    expect(await (await connect("stranger@test.invalid"))("list_book_files", { project: SLUG })).toMatchObject({ isError: true });
    await addProject("a-site", "dustinedwards");
    expect(await (await connect("owner@test.invalid"))("list_book_files", { project: "a-site" })).toMatchObject({ isError: true });
  });

  it("runs the checks on text without saving or recording anything", async () => {
    const call = await connect("reader@test.invalid");
    const result = await call("check_book_text", { project: SLUG, path: SCENE, source: `${HEADER}A tapestry.\n` });
    expect(result.structuredContent).toMatchObject({ findings: [{ check: "ai-habits", excerpt: "tapestry" }] });
    const owner = await viewerFor("owner@test.invalid");
    expect(await listFindings(testEnv.DB, await requireBookProject(testEnv.DB, owner, SLUG, "read"))).toEqual([]);
  });

  it("saves an AI draft beside the person's, never over it and never to Git", async () => {
    const owner = await viewerFor("owner@test.invalid");
    const project = await requireBookProject(testEnv.DB, owner, SLUG, "read");
    await autosave(testEnv.DB, project, owner, SCENE, { source: "Dustin's own draft.", baseVersion: null });

    const saved = await (await connect("owner@test.invalid"))("save_book_draft", { project: SLUG, path: SCENE, source: `${HEADER}An AI version.\n`, note: "Tighter." });
    expect(saved.structuredContent).toMatchObject({ saved: true, basedOnVersion: gh.files.get(`${SLUG}/${SCENE}`)!.sha });
    expect(await readDraftOnly(project, owner, SCENE)).toBe("Dustin's own draft.");
    expect(gh.commits).toEqual([]);
  });

  it("PLANT: a reviewer's and a Reader's sessions cannot save a book draft", async () => {
    expect(await (await connect("reviewer@test.invalid"))("save_book_draft", { project: SLUG, path: SCENE, source: "x" })).toMatchObject({
      isError: true,
      content: [{ text: "A reviewer flags; it does not write text. Use add_book_finding." }],
    });
    expect(await (await connect("reader@test.invalid"))("save_book_draft", { project: SLUG, path: SCENE, source: "x" })).toMatchObject({ isError: true });
  });

  it("PLANT: a reviewer's flag on a book file survives the recheck a save runs, and holds export", async () => {
    const reviewer = await connect("reviewer@test.invalid", "Grok Build");
    const flagged = await reviewer("add_book_finding", { project: SLUG, path: SCENE, message: "Wade could not see the gate from the road.", excerpt: "opened the gate" });
    expect(flagged.structuredContent).toMatchObject({ flagged: true, alreadyFlagged: false });

    const owner = await viewerFor("owner@test.invalid");
    const project = await requireBookProject(testEnv.DB, owner, SLUG, "publish");
    const current = gh.files.get(`${SLUG}/${SCENE}`)!;
    const saved = await saveBookFile(testEnv.DB, gh.repo, project, owner, SCENE, { source: `${HEADER}Wade opened the old gate.\n`, expectedVersion: current.sha });
    expect(saved.ok).toBe(true);
    expect((await listFindings(testEnv.DB, project, { path: SCENE })).map((f) => [f.check, f.status])).toEqual([["review", "open"]]);
    expect(await exportGate(testEnv.DB, project)).toMatchObject({ ok: false, open: 1 });
  });

  it("PLANT: a flag on a path outside the layout is refused", async () => {
    expect(await (await connect("reviewer@test.invalid"))("add_book_finding", { project: SLUG, path: "../x.md", message: "m" })).toMatchObject({ isError: true });
  });
});

describe("AI drafts in the book editor", () => {
  it("shows them beside the text, and Use as my draft makes one the working copy", async () => {
    await (await connect("owner@test.invalid"))("save_book_draft", { project: SLUG, path: SCENE, source: `${HEADER}An AI version.\n` });
    vi.stubGlobal("fetch", gh.fetch);
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: testEnv, ctx: {} as ExecutionContext });
    context.set(viewerContext, await viewerFor("owner@test.invalid"));
    context.set(nonceContext, "n");
    const params = { project: SLUG, "*": SCENE };
    const data = (await fileLoader({ request: new Request("https://carrel.test/"), params, context } as never)) as Awaited<ReturnType<typeof fileLoader>>;
    expect(data.aiDrafts).toMatchObject([{ client: "Claude 1.0", source: `${HEADER}An AI version.\n` }]);

    const body = new FormData();
    body.set("intent", "use-ai-draft");
    body.set("draft", String(data.aiDrafts[0]!.id));
    expect(await fileAction({ request: new Request("https://carrel.test/", { method: "POST", body }), params, context } as never)).toEqual({ intent: "use-ai-draft", used: data.aiDrafts[0]!.id });
    const owner = await viewerFor("owner@test.invalid");
    expect(await readDraftOnly(await requireBookProject(testEnv.DB, owner, SLUG, "read"), owner, SCENE)).toBe(`${HEADER}An AI version.\n`);
  });
});

describe("export refuses a book with import markers", () => {
  it("PLANT: names each file still holding a marker; clean, it passes", async () => {
    await gh.commitElsewhere(`${SLUG}/chapters/01-arrival/02-letter.md`, `${HEADER}Before.\n\n<!-- import: table: A table was not converted. -->\n\nAfter.\n`);
    const owner = await viewerFor("owner@test.invalid");
    const project = await requireBookProject(testEnv.DB, owner, SLUG, "publish");
    await refreshBook(testEnv.DB, gh.repo, project);
    const held = await exportGate(testEnv.DB, project);
    expect(held).toMatchObject({ ok: false });
    expect(held.ok || held.message).toBe(
      "1 file still holds an <!-- import: ... --> marker from the Word import: chapters/01-arrival/02-letter.md. Fix the text there and delete each marker before exporting.",
    );
    await gh.commitElsewhere(`${SLUG}/chapters/01-arrival/02-letter.md`, `${HEADER}Before.\n\nAfter.\n`);
    await refreshBook(testEnv.DB, gh.repo, project);
    expect(await exportGate(testEnv.DB, project)).toEqual({ ok: true });
  });
});

describe("draft_social_post", () => {
  async function socialAccount() {
    const projectId = await addProject("germomics", "dustinedwards");
    const owner = await viewerFor("owner@test.invalid");
    await createAccount(testEnv.DB, owner, { key: "germomics-bluesky", name: "Germomics", platform: "bluesky", kind: "brand", handle: "g.bsky.social", projectId });
    const row = await testEnv.DB.prepare("SELECT id FROM social_accounts").first<{ id: number }>();
    await setSwitches(testEnv.DB, owner, row!.id, { enabled: true });
    await recordPublication(testEnv.DB, projectId, { id: "ep-1", title: "Episode 1", url: "https://site.test/ep-1", summary: "" });
    return (await testEnv.DB.prepare("SELECT id FROM social_events").first<{ id: number }>())!.id;
  }

  it("stores the Owner's session's draft by event id, credited to the client", async () => {
    const eventId = await socialAccount();
    const result = await (await connect("owner@test.invalid", "Claude Code"))("draft_social_post", { event_id: eventId, text: "Episode 1 is out: https://site.test/ep-1" });
    expect(result.structuredContent).toMatchObject({ stored: true });
    expect(await testEnv.DB.prepare("SELECT source, status, created_by FROM social_posts").first()).toEqual({ source: "predrafted", status: "drafted", created_by: "Claude Code 1.0" });
  });

  it("stores by account, project and item too", async () => {
    await socialAccount();
    const result = await (await connect("owner@test.invalid"))("draft_social_post", { account: "germomics-bluesky", project: "germomics", item: "ep-2", text: "Episode 2." });
    expect(result.structuredContent).toMatchObject({ stored: true });
  });

  it("PLANT: an Editor's or a reviewer's session cannot draft social posts", async () => {
    const eventId = await socialAccount();
    for (const email of ["editor@test.invalid", "reviewer@test.invalid"]) {
      expect(await (await connect(email))("draft_social_post", { event_id: eventId, text: "x" })).toMatchObject({
        isError: true,
        content: [{ text: "Social posts are Dustin's: only his own sessions may draft them." }],
      });
    }
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM social_posts").first()).toEqual({ n: 0 });
  });
});
