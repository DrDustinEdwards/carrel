// The one view's index: what the site lists, searched with FTS5, filtered, and kept in step with the
// site, within a bounded number of requests per run.

import { memoryAdapter } from "@dustinedwards/site-api/testing";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ftsQuery,
  MAX_BODY_FETCHES,
  REFRESH_MAX_SUBREQUESTS,
  REFRESH_SUBREQUEST_BUDGET,
  refreshIndex,
  searchItems,
  SUBREQUEST_LIMIT,
} from "~/lib/index.server";

import { addProject, resetDb, testEnv } from "./env";
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

/**
 * D1 with every call counted, as the platform counts subrequests: each statement run and each batch
 * is one. Statements are unwrapped before a batch, which D1 insists on.
 */
function countingD1(db: D1Database) {
  let calls = 0;
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (prop === "first" || prop === "run" || prop === "all" || prop === "raw") {
          return (...args: unknown[]) => {
            calls++;
            return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    real.set(proxy, stmt);
    return proxy;
  };
  const counted = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => wrap(target.prepare(query));
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          calls++;
          return target.batch(stmts.map((s) => real.get(s) ?? s));
        };
      }
      if (prop === "exec") {
        return (query: string) => {
          calls++;
          return target.exec(query);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted, calls: () => calls };
}

describe("the refresh's subrequests (Workers Paid)", () => {
  it("keeps the cap's worst case inside its budget, and the budget a tenth of the plan's limit", () => {
    expect(SUBREQUEST_LIMIT).toBe(10_000);
    expect(REFRESH_SUBREQUEST_BUDGET).toBe(1_000);
    expect(REFRESH_MAX_SUBREQUESTS).toBe(412);
    expect(REFRESH_MAX_SUBREQUESTS).toBeLessThanOrEqual(REFRESH_SUBREQUEST_BUDGET);
  });

  it("stays under the limit when every post needs its body read: counted, not assumed", async () => {
    const posts = Object.fromEntries(Array.from({ length: MAX_BODY_FETCHES + 50 }, (_, i) => [`p${String(i).padStart(3, "0")}`, `# P${i}
`]));
    const site = await seeded(posts);
    const counting = countingD1(testEnv.DB);
    const env = connectedEnv({ DB: counting.db });
    const before = site.requests.length;

    const result = await refreshIndex(env, { id: projectId, site: "dustinedwards" }, site.fetch);
    expect(result).toMatchObject({ listed: MAX_BODY_FETCHES + 50, fetched: MAX_BODY_FETCHES, pending: 50 });

    const fetches = site.requests.length - before;
    const used = fetches + counting.calls();
    // Two list pages, one read per body; two D1 calls up front and one batch per body.
    expect(fetches).toBe(2 + MAX_BODY_FETCHES);
    expect(counting.calls()).toBe(2 + MAX_BODY_FETCHES);
    expect(used).toBeLessThanOrEqual(REFRESH_MAX_SUBREQUESTS);
    expect(used).toBeLessThan(SUBREQUEST_LIMIT);
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
