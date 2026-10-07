// Bulk actions on the posts list: delete (the Owner's alone), tag and duplicate. Each post is its own
// write, one failing never stops the rest, every outcome is said, and every write the site carried out
// has its authorship row. The refusals (a role, a stale version, a site with no delete) are checked
// to leave the site and the record as they were.

import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VersionConflictError } from "@dustinedwards/site-api";

import { bulkApply, cleanTag, MAX_BULK } from "~/lib/bulk.server";
import { autosave, contentDeleteOffered, deleteFromSite, writeToSite } from "~/lib/content.server";
import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { action as bulkAction } from "~/routes/project.bulk";
import { memoryAdapter } from "@dustinedwards/site-api/testing";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const SLUG = "de-info";
let projectId: number;
type Site = ReturnType<typeof fakeSite<ReturnType<typeof memoryAdapter>>>;
let site: Site;
let env: Env;

const POST = (title: string, slug: string, tags: string, body = "Body.") => `---\ntitle: "${title}"\nslug: ${slug}\ndate: 2026-10-01\ntags: ${tags}\ndraft: true\nweird_key: some value: with a colon\n---\n\n${body}\n`;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const reader = await addPerson("reader@test.invalid");
  projectId = await addProject(SLUG, "dustinedwards");
  await share(projectId, editor, "editor");
  await share(projectId, reader, "reader");
  start(fakeSite());
});

function start(next: Site) {
  site = next;
  vi.stubGlobal("fetch", site.fetch);
  env = connectedEnv();
}

async function as(email: string, action: "read" | "edit" | "publish" = "read") {
  const viewer = await viewerFor(email);
  return { viewer, project: await requireSiteProject(testEnv.DB, viewer, SLUG, action) };
}

/** A post on the site, written by the Owner; `live` publishes it. */
async function seed(id: string, source: string, live = false) {
  const { viewer, project } = await as("owner@test.invalid", "publish");
  const saved = await writeToSite(env, project, viewer, id, { action: "save", source, expectedVersion: null }, site.fetch);
  if (!saved.ok) throw new Error(saved.message);
  if (live) {
    const published = await writeToSite(env, project, viewer, id, { action: "publish", expectedVersion: saved.version }, site.fetch);
    if (!published.ok) throw new Error(published.message);
  }
}

const sourceOf = (id: string) => site.adapter.store.get(id)?.doc.source;
const rows = async () => (await testEnv.DB.prepare("SELECT action, item_id AS itemId, version_before AS vb, version_after AS va, person_id AS who FROM changes ORDER BY created_at, rowid").all<{ action: string; itemId: string; vb: string | null; va: string | null; who: number }>()).results;
const writes = () => site.requests.filter((r) => !r.startsWith("GET"));

async function refusal(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
  throw new Error("expected a refusal, and the call succeeded");
}

describe("bulk delete is the Owner's alone", () => {
  it("refuses an Editor and a Reader before the site is asked anything, and changes nothing", async () => {
    await seed("one", POST("One", "one", "[a]"));
    const before = await rows();
    site.requests.length = 0;
    for (const email of ["editor@test.invalid", "reader@test.invalid"]) {
      const { viewer, project } = await as(email);
      expect(await refusal(bulkApply(env, project, viewer, { op: "delete" }, ["one"], site.fetch))).toBe(403);
      expect(await refusal(deleteFromSite(env, project, viewer, "one", site.fetch))).toBe(403);
    }
    expect(site.requests).toEqual([]);
    expect(site.adapter.store.has("one")).toBe(true);
    expect(await rows()).toEqual(before);
  });

  it("answers the endpoint's JSON 403 for an Editor who posts a delete", async () => {
    await seed("one", POST("One", "one", "[a]"));
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
    context.set(viewerContext, await viewerFor("editor@test.invalid"));
    context.set(nonceContext, "n");
    const body = new FormData();
    body.set("op", "delete");
    body.append("id", "one");
    const response = (await bulkAction({ request: new Request(`https://carrel.test/p/${SLUG}/bulk`, { method: "POST", body }), params: { project: SLUG }, context } as never)) as Response;
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Deleting posts is the Owner's step." });
    expect(site.adapter.store.has("one")).toBe(true);
  });

  it("deletes for the Owner at the version the site holds, records it, drops it from the index and keeps working drafts", async () => {
    await seed("one", POST("One", "one", "[a]"));
    await seed("two", POST("Two", "two", "[a]"));
    const { viewer, project } = await as("owner@test.invalid", "publish");
    await autosave(testEnv.DB, project, viewer, "two", { source: "my unsaved words", baseVersion: null });
    const indexed = () => testEnv.DB.prepare("SELECT COUNT(*) AS n FROM site_items WHERE item_id = 'two'").first<{ n: number }>();
    expect((await indexed())!.n).toBe(1);
    const results = await bulkApply(env, project, viewer, { op: "delete" }, ["one", "two"], site.fetch);
    expect(results.map((r) => [r.id, r.title, r.ok, r.message])).toEqual([
      ["one", "One", true, "Deleted from the site."],
      ["two", "Two", true, "Deleted from the site."],
    ]);
    expect(site.adapter.deletedContent).toEqual(["one", "two"]);
    const log = (await rows()).filter((r) => r.action === "content-delete");
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ itemId: "one", va: null, who: viewer.id });
    expect(log[0]!.vb).toBeTruthy();
    expect((await indexed())!.n).toBe(0);
    expect((await testEnv.DB.prepare("SELECT source FROM drafts WHERE item_id = 'two'").first<{ source: string }>())?.source).toBe("my unsaved words");
  });
});

describe("a post that cannot be deleted does not stop the others", () => {
  it("reports a missing post, a stale version and a refusal, deletes the rest, and records only what the site did", async () => {
    const adapter = memoryAdapter();
    start(fakeSite(adapter));
    for (const id of ["a", "b", "c", "d"]) await seed(id, POST(id.toUpperCase(), id, "[x]"));
    const real = adapter.content.delete!;
    adapter.content.delete = async (id, input) => {
      if (id === "b") throw new VersionConflictError("someone-else");
      if (id === "c") throw new (await import("@dustinedwards/site-api")).RefusedError("The site keeps this page.");
      return real(id, input);
    };
    const { viewer, project } = await as("owner@test.invalid", "publish");
    const results = await bulkApply(env, project, viewer, { op: "delete" }, ["a", "b", "missing", "c", "d"], site.fetch);
    expect(results.map((r) => [r.id, r.ok])).toEqual([["a", true], ["b", false], ["missing", false], ["c", false], ["d", true]]);
    expect(results.find((r) => r.id === "b")!.message).toMatch(/changed on the site while this ran/);
    expect(results.find((r) => r.id === "missing")!.message).toMatch(/does not have this post|no post with this id/);
    expect(results.find((r) => r.id === "c")!.message).toBe("The site keeps this page.");
    expect(adapter.deletedContent).toEqual(["a", "d"]);
    expect(adapter.store.has("b") && adapter.store.has("c")).toBe(true);
    expect((await rows()).filter((r) => r.action === "content-delete").map((r) => r.itemId)).toEqual(["a", "d"]);
  });

  it("says a site with no delete does not delete, deletes nothing and records nothing", async () => {
    const adapter = memoryAdapter({ contentDelete: false });
    start(fakeSite(adapter));
    await seed("one", POST("One", "one", "[a]"));
    const { viewer, project } = await as("owner@test.invalid", "publish");
    expect(await contentDeleteOffered(env, project, site.fetch)).toEqual({ offered: false, reason: "The site does not delete posts through Carrel yet." });
    const results = await bulkApply(env, project, viewer, { op: "delete" }, ["one"], site.fetch);
    expect(results).toEqual([{ id: "one", title: "one", ok: false, message: "The site does not delete posts through Carrel yet." }]);
    expect(adapter.store.has("one")).toBe(true);
    expect((await rows()).filter((r) => r.action === "content-delete")).toEqual([]);
  });

  it("offers delete where the site has it", async () => {
    const { project } = await as("owner@test.invalid", "publish");
    expect(await contentDeleteOffered(env, project, site.fetch)).toEqual({ offered: true });
  });
});

describe("bulk tag", () => {
  it("changes only the tags line: the rest of the file comes back byte for byte", async () => {
    const original = POST("One", "one", "[alpha, beta]", "A paragraph.\n\nAnother, with *emphasis*.");
    await seed("one", original);
    const { viewer, project } = await as("editor@test.invalid", "edit");
    const [result] = await bulkApply(env, project, viewer, { op: "tag-add", tag: "gamma" }, ["one"], site.fetch);
    expect(result).toMatchObject({ ok: true, message: 'Added the tag "gamma".' });
    expect(sourceOf("one")).toBe(original.replace("tags: [alpha, beta]", "tags: [alpha, beta, gamma]"));
    const [removed] = await bulkApply(env, project, viewer, { op: "tag-remove", tag: "ALPHA" }, ["one"], site.fetch);
    expect(removed).toMatchObject({ ok: true, message: 'Removed the tag "ALPHA".' });
    expect(sourceOf("one")).toBe(original.replace("tags: [alpha, beta]", "tags: [beta, gamma]"));
  });

  it("is a save with its authorship row, and writes nothing for a post that already has the tag", async () => {
    await seed("one", POST("One", "one", "[alpha]"));
    const { viewer, project } = await as("editor@test.invalid", "edit");
    const before = (await rows()).length;
    site.requests.length = 0;
    const [same] = await bulkApply(env, project, viewer, { op: "tag-add", tag: "alpha" }, ["one"], site.fetch);
    expect(same).toMatchObject({ ok: true, message: 'Already tagged "alpha". Not changed.' });
    expect(writes()).toEqual([]);
    expect((await rows()).length).toBe(before);
    await bulkApply(env, project, viewer, { op: "tag-add", tag: "beta" }, ["one"], site.fetch);
    const last = (await rows()).at(-1)!;
    expect(last).toMatchObject({ action: "save", itemId: "one", who: viewer.id });
    expect(last.vb).not.toBe(last.va);
  });

  it("leaves a live post to the Owner: an Editor's tag on it is refused alone, and the others still change", async () => {
    await seed("draft-one", POST("Draft one", "draft-one", "[a]"));
    await seed("live-one", POST("Live one", "live-one", "[a]"), true);
    await seed("draft-two", POST("Draft two", "draft-two", "[a]"));
    const liveBefore = sourceOf("live-one");
    const { viewer, project } = await as("editor@test.invalid", "edit");
    const results = await bulkApply(env, project, viewer, { op: "tag-add", tag: "new" }, ["draft-one", "live-one", "draft-two"], site.fetch);
    expect(results.map((r) => [r.id, r.ok])).toEqual([["draft-one", true], ["live-one", false], ["draft-two", true]]);
    expect(results[1]!.message).toBe("Changing a live post is the Owner's step, so this one was left as it was.");
    expect(sourceOf("live-one")).toBe(liveBefore);
    expect(sourceOf("draft-one")).toContain("tags: [a, new]");
    expect(sourceOf("draft-two")).toContain("tags: [a, new]");
  });

  it("lets the Owner tag a live post", async () => {
    await seed("live-one", POST("Live one", "live-one", "[a]"), true);
    const { viewer, project } = await as("owner@test.invalid", "publish");
    const [result] = await bulkApply(env, project, viewer, { op: "tag-add", tag: "new" }, ["live-one"], site.fetch);
    expect(result!.ok).toBe(true);
    expect(site.adapter.store.get("live-one")!.doc.status).toBe("published");
  });

  it("leaves a post alone when the person has an unsaved working draft of it, so the draft is not lost", async () => {
    await seed("one", POST("One", "one", "[a]"));
    const { viewer, project } = await as("editor@test.invalid", "edit");
    await autosave(testEnv.DB, project, viewer, "one", { source: "half a sentence", baseVersion: null });
    const before = sourceOf("one");
    const [result] = await bulkApply(env, project, viewer, { op: "tag-add", tag: "new" }, ["one"], site.fetch);
    expect(result).toMatchObject({ ok: false });
    expect(result!.message).toMatch(/working draft/);
    expect(sourceOf("one")).toBe(before);
    expect((await testEnv.DB.prepare("SELECT source FROM drafts WHERE item_id = 'one'").first<{ source: string }>())?.source).toBe("half a sentence");
  });

  it("refuses a tag that would break the list, before any post is read", async () => {
    const { viewer, project } = await as("editor@test.invalid", "edit");
    site.requests.length = 0;
    for (const tag of ["", "a, b", "x]", 'say "hi"', "a:b", "x".repeat(41)]) {
      expect(await refusal(bulkApply(env, project, viewer, { op: "tag-add", tag }, ["one"], site.fetch))).toBe(400);
    }
    expect(site.requests).toEqual([]);
    expect(cleanTag("  open source ")).toBe("open source");
  });
});

describe("bulk duplicate", () => {
  it("makes a new draft with an unused id, a copy title and its own slug, created fresh, and leaves the original alone", async () => {
    const original = POST("The original", "orig", "[a, b]", "Words.");
    await seed("orig", original, true);
    const { viewer, project } = await as("editor@test.invalid", "edit");
    const [first] = await bulkApply(env, project, viewer, { op: "duplicate" }, ["orig"], site.fetch);
    expect(first).toMatchObject({ ok: true, copyId: "orig-copy" });
    const [second] = await bulkApply(env, project, viewer, { op: "duplicate" }, ["orig"], site.fetch);
    expect(second).toMatchObject({ ok: true, copyId: "orig-copy-2" });
    expect(sourceOf("orig")).toBe(original);
    expect(sourceOf("orig-copy")).toBe(original.replace('title: "The original"', 'title: "The original (copy)"').replace("slug: orig", "slug: orig-copy"));
    expect(sourceOf("orig-copy-2")).toContain('title: "The original (copy 2)"');
    expect(site.adapter.store.get("orig-copy")!.doc.status).toBe("draft");
    const created = (await rows()).filter((r) => r.itemId === "orig-copy");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ action: "save", vb: null, who: viewer.id });
  });

  it("sets draft: true on a copy of a live post, and adds the key when the post lacks one", async () => {
    await seed("live", POST("Live", "live", "[a]").replace("draft: true", "draft: false"), true);
    await seed("bare", "---\ntitle: Bare\n---\n\nBody.\n");
    const { viewer, project } = await as("editor@test.invalid", "edit");
    await bulkApply(env, project, viewer, { op: "duplicate" }, ["live", "bare"], site.fetch);
    expect(sourceOf("live-copy")).toContain("draft: true");
    expect(sourceOf("live-copy")).not.toContain("draft: false");
    expect(sourceOf("bare-copy")).toBe("---\ntitle: \"Bare (copy)\"\ndraft: true\n---\n\nBody.\n");
  });

  it("skips an id that a working draft or an AI draft already uses, and one the site already holds", async () => {
    await seed("orig", POST("Orig", "orig", "[a]"));
    await seed("orig-copy", POST("Taken on the site", "orig-copy", "[a]"));
    const { viewer, project } = await as("editor@test.invalid", "edit");
    await autosave(testEnv.DB, project, viewer, "orig-copy-2", { source: "a draft only in Carrel", baseVersion: null });
    const [result] = await bulkApply(env, project, viewer, { op: "duplicate" }, ["orig"], site.fetch);
    expect(result).toMatchObject({ ok: true, copyId: "orig-copy-3" });
  });

  it("reports a post the site does not have and one with no frontmatter, and copies the rest", async () => {
    await seed("plain", "No frontmatter here.\n");
    await seed("good", POST("Good", "good", "[a]"));
    const { viewer, project } = await as("editor@test.invalid", "edit");
    const results = await bulkApply(env, project, viewer, { op: "duplicate" }, ["ghost", "plain", "good"], site.fetch);
    expect(results.map((r) => [r.id, r.ok])).toEqual([["ghost", false], ["plain", false], ["good", true]]);
    expect(results[1]!.message).toMatch(/no frontmatter/);
    expect(site.adapter.store.has("plain-copy")).toBe(false);
  });
});

describe("what a request may carry", () => {
  it("refuses a Reader, nothing chosen and too many posts, and never sends an id that could not be one", async () => {
    const reader = await as("reader@test.invalid");
    expect(await refusal(bulkApply(env, reader.project, reader.viewer, { op: "duplicate" }, ["one"], site.fetch))).toBe(403);
    const { viewer, project } = await as("editor@test.invalid", "edit");
    expect(await refusal(bulkApply(env, project, viewer, { op: "duplicate" }, [], site.fetch))).toBe(400);
    expect(await refusal(bulkApply(env, project, viewer, { op: "duplicate" }, Array.from({ length: MAX_BULK + 1 }, (_, i) => `p-${i}`), site.fetch))).toBe(400);
    site.requests.length = 0;
    const results = await bulkApply(env, project, viewer, { op: "duplicate" }, ["../etc", "a b"], site.fetch);
    expect(results.every((r) => !r.ok && /not a post id/.test(r.message))).toBe(true);
    expect(site.requests).toEqual([]);
  });
});
