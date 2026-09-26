// The one view's index: what the site lists, searched with FTS5, filtered, and kept in step with the
// site, within a bounded number of requests per run.

import { memoryAdapter } from "@dustinedwards/site-api/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { ftsQuery, MAX_BODY_FETCHES, refreshIndex, searchItems } from "~/lib/index.server";

import { addProject, resetDb } from "./env";
import { connectedEnv, fakeSite } from "./site";

let projectId: number;

beforeEach(async () => {
  await resetDb();
  projectId = await addProject("de-info", "dustinedwards");
});

async function seeded(posts: Record<string, string>, published: string[] = []) {
  const adapter = memoryAdapter();
  for (const [id, source] of Object.entries(posts)) {
    const saved = await adapter.content.saveDraft(id, { source, expectedVersion: null, changeId: "seed" });
    if (published.includes(id)) await adapter.content.publish(id, { expectedVersion: saved.version, changeId: "seed" });
  }
  return fakeSite(adapter);
}

describe("refresh", () => {
  it("indexes every item and finds one by a word in its body, not only its title", async () => {
    const site = await seeded(
      {
        "workers-caching": "---\ntitle: Caching on Workers\n---\nA note on purge tags.\n",
        "fts-notes": "---\ntitle: Search notes\n---\nPorter stemming makes searching find searches.\n",
      },
      ["workers-caching"],
    );
    const result = await refreshIndex(connectedEnv(), { id: projectId, site: "dustinedwards" }, site.fetch);
    expect(result).toEqual({ listed: 2, fetched: 2, removed: 0, pending: 0 });

    const env = connectedEnv();
    expect((await searchItems(env.DB, projectId, { q: "purge" })).map((i) => i.itemId)).toEqual(["workers-caching"]);
    expect((await searchItems(env.DB, projectId, { q: "search" })).map((i) => i.itemId)).toEqual(["fts-notes"]);
    // A prefix while typing. The porter stemmer stores "stemming" as "stem", so "stem" finds it and
    // "stemm" would not: a partial word past the stem misses until the word is complete.
    expect((await searchItems(env.DB, projectId, { q: "stem" })).map((i) => i.itemId)).toEqual(["fts-notes"]);
    expect((await searchItems(env.DB, projectId, { q: "stemming" })).map((i) => i.itemId)).toEqual(["fts-notes"]);
    expect((await searchItems(env.DB, projectId, { status: "published" })).map((i) => i.itemId)).toEqual(["workers-caching"]);
    expect(await searchItems(env.DB, projectId, { q: "nothing-like-this" })).toEqual([]);
  });

  it("reads a body again only when the item changed, and drops an item the site no longer lists", async () => {
    const site = await seeded({ a: "# A\n", b: "# B\n" });
    const env = connectedEnv();
    await refreshIndex(env, { id: projectId, site: "dustinedwards" }, site.fetch);

    const again = await refreshIndex(env, { id: projectId, site: "dustinedwards" }, site.fetch);
    expect(again.fetched).toBe(0);

    const current = site.adapter.store.get("a")!.doc.version;
    await site.adapter.content.saveDraft("a", { source: "# A\nnew words\n", expectedVersion: current, changeId: "x" });
    site.adapter.store.delete("b");
    const third = await refreshIndex(env, { id: projectId, site: "dustinedwards" }, site.fetch);
    expect(third).toMatchObject({ listed: 1, fetched: 1, removed: 1 });
    expect((await searchItems(env.DB, projectId, { q: "new words" })).map((i) => i.itemId)).toEqual(["a"]);
    expect(await searchItems(env.DB, projectId, { q: "B" })).toEqual([]);
  });

  it("reads at most MAX_BODY_FETCHES bodies per run and reports the rest as pending", async () => {
    const posts = Object.fromEntries(Array.from({ length: MAX_BODY_FETCHES + 5 }, (_, i) => [`p${String(i).padStart(2, "0")}`, `# P${i}\n`]));
    const site = await seeded(posts);
    const env = connectedEnv();
    const first = await refreshIndex(env, { id: projectId, site: "dustinedwards" }, site.fetch);
    expect(first).toMatchObject({ fetched: MAX_BODY_FETCHES, pending: 5 });
    expect(site.requests.filter((r) => r.startsWith("GET /api/carrel/v1/content/")).length).toBe(MAX_BODY_FETCHES);
    const second = await refreshIndex(env, { id: projectId, site: "dustinedwards" }, site.fetch);
    expect(second).toMatchObject({ fetched: 5, pending: 0 });
  });
});

describe("the search expression", () => {
  it("treats punctuation as text, never FTS5 syntax", () => {
    expect(ftsQuery('title:"x" OR NEAR(a b)')).toBe('"title" "x" "OR" "NEAR" "a" "b"*');
    expect(ftsQuery("---")).toBeNull();
  });

  it("returns nothing for a query with no words rather than everything", async () => {
    const env = connectedEnv();
    expect(await searchItems(env.DB, projectId, { q: "***" })).toEqual([]);
  });
});
