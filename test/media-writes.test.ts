// The media library's v0.4.0 writes (job_b4acbaabf747): alt text, tags, the trash, bulk actions and
// emptying the trash, over site-api's own handler and its reference adapter. Planted: the Owner-only
// boundary (a delete, a bulk delete and an empty-trash by an Editor are refused before the site hears
// anything), a stale version (plain conflict, nothing recorded), per-file bulk reporting (a file a post
// uses is refused alone, with the post named), and a site that offers none of the writes.

import { memoryAdapter } from "@dustinedwards/site-api/testing";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { bulkMedia, emptyMediaTrash, listMedia, mediaMeta, parseMediaTags, restoreMedia, setMediaAlt, setMediaTags, trashMedia } from "~/lib/media.server";
import { requireSiteProject } from "~/lib/projects.server";
import { action as bulkRoute } from "~/routes/media.bulk";
import { action as mediaAction, loader as mediaLoader } from "~/routes/media";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const SLUG = "de-info";
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

let site: ReturnType<typeof fakeSite<ReturnType<typeof memoryAdapter>>>;
let env: Env;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const reader = await addPerson("reader@test.invalid");
  const id = await addProject(SLUG, "dustinedwards");
  await share(id, editor, "editor");
  await share(id, reader, "reader");
  site = fakeSite();
  env = connectedEnv();
  vi.stubGlobal("fetch", site.fetch);
});

async function project(email: string) {
  return requireSiteProject(env.DB, await viewerFor(email), SLUG, "read");
}
async function actor(email: string) {
  return { viewer: await viewerFor(email) };
}
async function status(run: () => Promise<unknown>): Promise<number> {
  try {
    await run();
    return 200;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}
async function contextFor(email: string) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
  context.set(viewerContext, await viewerFor(email));
  context.set(nonceContext, "n");
  return context;
}
async function seedFile(name = "river.png") {
  const item = await site.adapter.media!.upload({ bytes: PNG, contentType: "image/png", filename: name, alt: "", changeId: `seed-${name}` });
  return { ...item, version: (await site.adapter.media!.get(item.id))!.version! };
}
async function useInPost(url: string, slug = "river-post") {
  await site.adapter.content.saveDraft(slug, { source: `---\ntitle: The river\n---\nIntro.\n\n:::figure{src="${url}" alt="The river"}\n:::\n`, expectedVersion: null, changeId: `c-${slug}` });
}
const rows = async () =>
  (await testEnv.DB.prepare("SELECT id, action, item_id AS itemId, version_before AS vb, version_after AS va, person_id AS who FROM changes ORDER BY rowid").all<{ id: string; action: string; itemId: string; vb: string | null; va: string | null; who: number }>()).results;
const sitePosts = () => site.requests.filter((r) => !r.startsWith("GET"));

async function post(path: string, fields: Record<string, string | string[]>, email: string, route: "media" | "bulk" = "media") {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) form.append(k, one);
  const request = new Request(`https://carrel.test/p/${SLUG}/${path}`, { method: "POST", body: form });
  const args = { request, params: { project: SLUG }, context: await contextFor(email) } as never;
  return route === "media" ? mediaAction(args) : bulkRoute(args);
}

describe("alt text, tags, trash and restore", () => {
  it("writes each as an Editor with the version seen, and records who did it", async () => {
    const file = await seedFile();
    const editor = await project("editor@test.invalid");
    const who = await actor("editor@test.invalid");

    const alt = await setMediaAlt(env, editor, who, file.id, "The river at dusk", file.version);
    expect(alt).toMatchObject({ ok: true });
    const tags = await setMediaTags(env, editor, who, file.id, ["river", "dusk"], alt.ok ? alt.version : "");
    expect(tags.ok).toBe(true);
    const trashed = await trashMedia(env, editor, who, file.id, tags.ok ? tags.version : "");
    expect(trashed.ok).toBe(true);
    expect((await listMedia(env, editor, {})).items).toEqual([]);
    expect((await listMedia(env, editor, { trashed: "only" })).items).toMatchObject([{ id: file.id, alt: "The river at dusk", tags: ["dusk", "river"] }]);
    expect((await restoreMedia(env, editor, who, file.id, trashed.ok ? trashed.version : "")).ok).toBe(true);
    expect((await listMedia(env, editor, { tag: "dusk" })).items).toHaveLength(1);

    const editorId = (await viewerFor("editor@test.invalid")).id;
    expect((await rows()).map((r) => [r.action, r.itemId, r.who === editorId])).toEqual([
      ["media-alt", file.id, true],
      ["media-tags", file.id, true],
      ["media-trash", file.id, true],
      ["media-restore", file.id, true],
    ]);
    expect((await rows())[0]).toMatchObject({ vb: file.version, va: alt.ok ? alt.version : "x" });
  });

  it("refuses a Reader before the site hears anything, and records nothing", async () => {
    const file = await seedFile();
    const reader = await project("reader@test.invalid");
    const who = await actor("reader@test.invalid");
    site.requests.length = 0;
    expect(await status(() => setMediaAlt(env, reader, who, file.id, "x", file.version))).toBe(403);
    expect(await status(() => trashMedia(env, reader, who, file.id, file.version))).toBe(403);
    expect(await status(() => bulkMedia(env, reader, who, "trash", [{ id: file.id, version: file.version }]))).toBe(403);
    expect(sitePosts()).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("says a stale version plainly, changes nothing and records nothing", async () => {
    const file = await seedFile();
    const editor = await project("editor@test.invalid");
    const who = await actor("editor@test.invalid");
    await setMediaAlt(env, editor, who, file.id, "first", file.version);
    const stale = await setMediaAlt(env, editor, who, file.id, "second", file.version);
    expect(stale).toMatchObject({ ok: false, conflict: true, message: expect.stringContaining("changed on the site") });
    expect((await site.adapter.media!.get(file.id))!.alt).toBe("first");
    expect(await rows()).toHaveLength(1);
  });

  it("answers the page's form with the conflict, and refuses a tag the site would not spell", async () => {
    const file = await seedFile();
    await post("media", { intent: "set-alt", id: file.id, version: file.version, alt: "first" }, "editor@test.invalid");
    expect(await post("media", { intent: "set-alt", id: file.id, version: file.version, alt: "second" }, "editor@test.invalid")).toMatchObject({ intent: "set-alt", ok: false, conflict: true });
    const fresh = (await site.adapter.media!.get(file.id))!.version!;
    expect(await post("media", { intent: "set-tags", id: file.id, version: fresh, tags: "Good Tag, bad/tag" }, "editor@test.invalid")).toMatchObject({ ok: false, message: expect.stringContaining("cannot be a tag") });
    expect(parseMediaTags("River, good tag,river")).toEqual({ ok: true, tags: ["river", "good-tag"] });
  });
});

describe("PLANT: only the Owner deletes for good or empties the trash", () => {
  it("refuses an Editor's bulk delete and empty-trash before the site hears anything, and the files stay", async () => {
    const a = await seedFile("a.png");
    const trashed = await trashMedia(env, await project("owner@test.invalid"), await actor("owner@test.invalid"), a.id, a.version);
    expect(trashed.ok).toBe(true);
    const editor = await project("editor@test.invalid");
    const who = await actor("editor@test.invalid");
    const before = await rows();
    site.requests.length = 0;

    expect(await status(() => bulkMedia(env, editor, who, "delete", [{ id: a.id }]))).toBe(403);
    expect(await status(() => emptyMediaTrash(env, editor, who))).toBe(403);
    expect(await status(() => post("media", { intent: "empty-trash", confirm: "empty" }, "editor@test.invalid"))).toBe(403);
    expect(await (await post("media/bulk", { op: "delete", item: `${a.id}\t` }, "editor@test.invalid", "bulk") as Response).status).toBe(403);
    expect(sitePosts()).toEqual([]);
    expect(site.adapter.mediaStore.has(a.id)).toBe(true);
    expect(site.adapter.deleted).toEqual([]);
    expect(await rows()).toEqual(before);
  });

  it("lets the Owner empty the trash only after confirming, then deletes what the site lets go and records each file", async () => {
    const gone = await seedFile("gone.png");
    const used = await seedFile("used.png");
    await useInPost(used.url);
    const owner = await project("owner@test.invalid");
    const who = await actor("owner@test.invalid");
    await trashMedia(env, owner, who, gone.id, gone.version);
    await trashMedia(env, owner, who, used.id, used.version);

    expect(await post("media", { intent: "empty-trash" }, "owner@test.invalid")).toEqual({ intent: "empty-trash", needsConfirm: true });
    expect(site.adapter.deleted).toEqual([]);

    const done = await post("media", { intent: "empty-trash", confirm: "empty" }, "owner@test.invalid");
    expect(done).toMatchObject({ intent: "empty-trash", ok: true, deleted: [gone.id], refused: [{ id: used.id, usedBy: [{ id: "river-post", title: "The river" }] }], more: false });
    expect(site.adapter.mediaStore.has(used.id)).toBe(true);
    const deletes = (await rows()).filter((r) => r.action === "media-delete");
    expect(deletes).toMatchObject([{ itemId: gone.id }]);
    // The site numbers files by their place in the trash it lists, refused ones included: the used file is first (newest), this one second.
    expect(deletes[0]!.id).toMatch(/-2$/);
  });
});

describe("bulk actions report each file", () => {
  it("trashes the fresh file, leaves the stale one, and records only what was done", async () => {
    const a = await seedFile("a.png");
    const b = await seedFile("b.png");
    const editor = await project("editor@test.invalid");
    const who = await actor("editor@test.invalid");
    await setMediaAlt(env, editor, who, b.id, "moved on", b.version); // b is now stale for anyone holding the old version
    const results = await bulkMedia(env, editor, who, "trash", [
      { id: a.id, version: a.version },
      { id: b.id, version: b.version },
      { id: "uploads/missing.png", version: "m99" },
    ]);
    expect(results.map((r) => [r.id, r.ok])).toEqual([[a.id, true], [b.id, false], ["uploads/missing.png", false]]);
    expect(results[1]!.message).toContain("changed on the site");
    expect((await rows()).filter((r) => r.action === "media-trash").map((r) => r.itemId)).toEqual([a.id]);
    expect((await listMedia(env, editor, {})).items.map((i) => i.id)).toEqual([b.id]);
  });

  it("names the post that blocks a bulk delete, deletes the rest, and tags in bulk", async () => {
    const free = await seedFile("free.png");
    const used = await seedFile("used.png");
    await useInPost(used.url);
    const owner = await project("owner@test.invalid");
    const who = await actor("owner@test.invalid");

    const tagged = await bulkMedia(env, owner, who, "add-tags", [{ id: free.id, version: free.version }, { id: used.id, version: used.version }], ["spring", "river"]);
    expect(tagged.every((r) => r.ok)).toBe(true);
    expect((await listMedia(env, owner, { tag: "spring" })).items).toHaveLength(2);

    const results = await bulkMedia(env, owner, who, "delete", [{ id: free.id }, { id: used.id }]);
    expect(results.find((r) => r.id === free.id)).toMatchObject({ ok: true });
    expect(results.find((r) => r.id === used.id)).toMatchObject({ ok: false, usedBy: [{ type: "post", id: "river-post", title: "The river" }] });
    expect(site.adapter.deleted).toEqual([free.id]);
    expect((await rows()).filter((r) => r.action === "media-delete").map((r) => r.itemId)).toEqual([free.id]);
  });

  it("answers the endpoint's JSON: a bad action and a bad tag are 400, and a good one lists every file", async () => {
    const a = await seedFile("a.png");
    expect(((await post("media/bulk", { op: "burn", item: a.id }, "editor@test.invalid", "bulk")) as Response).status).toBe(400);
    expect(((await post("media/bulk", { op: "add-tags", item: `${a.id}\t${a.version}`, tags: "no/good" }, "editor@test.invalid", "bulk")) as Response).status).toBe(400);
    const ok = (await post("media/bulk", { op: "trash", item: `${a.id}\t${a.version}` }, "editor@test.invalid", "bulk")) as Response;
    expect(await ok.json()).toMatchObject({ results: [{ id: a.id, ok: true }] });
  });
});

describe("a site that offers none of the writes", () => {
  beforeEach(() => {
    site = fakeSite(memoryAdapter({ mediaWrites: false }));
    vi.stubGlobal("fetch", site.fetch);
  });

  it("is told so by its meta, so the page shows no alt, tag, trash or selection tools", async () => {
    expect((await mediaMeta(env, await project("owner@test.invalid")))!.offers).toEqual({ alt: false, tags: false, trash: false });
    await seedFile();
    const data = (await mediaLoader({ request: new Request(`https://carrel.test/p/${SLUG}/media?view=trash`), params: { project: SLUG }, context: await contextFor("owner@test.invalid") } as never)) as { offers: unknown; view: string; items: unknown[] };
    expect(data.offers).toEqual({ alt: false, tags: false, trash: false });
    expect(data.view).toBe("library"); // no Trash view to open
    expect(data.items).toHaveLength(1);
  });

  it("answers a write that arrives anyway with 'not offered', not a crash", async () => {
    const file = await seedFile();
    const editor = await project("editor@test.invalid");
    expect(await trashMedia(env, editor, await actor("editor@test.invalid"), file.id, "m1")).toMatchObject({ ok: false, message: "This site does not offer that." });
    expect(await rows()).toEqual([]);
  });
});

describe("the page's loader", () => {
  it("offers the writes the site has, lists the trash on its own view, and filters by tag", async () => {
    const a = await seedFile("a.png");
    const b = await seedFile("b.png");
    const owner = await project("owner@test.invalid");
    const who = await actor("owner@test.invalid");
    await setMediaTags(env, owner, who, a.id, ["river"], a.version);
    await trashMedia(env, owner, who, b.id, b.version);
    const load = async (query: string, email = "owner@test.invalid") =>
      (await mediaLoader({ request: new Request(`https://carrel.test/p/${SLUG}/media${query}`), params: { project: SLUG }, context: await contextFor(email) } as never)) as {
        offers: unknown;
        view: string;
        items: { id: string }[];
        trashFiles: { id: string }[];
        tag: string;
        tagInvalid: boolean;
      };
    const library = await load("");
    expect(library.offers).toEqual({ alt: true, tags: true, trash: true });
    expect(library.items.map((i) => i.id)).toEqual([a.id]);
    const trash = await load("?view=trash");
    expect(trash).toMatchObject({ view: "trash", items: [{ id: b.id }], trashFiles: [{ id: b.id }] });
    expect((await load("?tag=river")).items.map((i) => i.id)).toEqual([a.id]);
    expect((await load("?tag=nothing")).items).toEqual([]);
    expect(await load("?tag=Not%20a/tag")).toMatchObject({ tag: "", tagInvalid: true });
    // An Editor sees the trash but is not handed the list that names every file for the empty-trash confirm.
    expect((await load("?view=trash", "editor@test.invalid")).trashFiles).toEqual([]);
  });
});
