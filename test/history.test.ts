// The history screens, driven through the route's loader with a real request context: a Reader may
// read all of it, nothing in it writes (to the site or to Carrel), and each comparison names the
// right two texts, older first.

import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveAiDraft } from "~/lib/ai.server";
import { autosave, writeToSite } from "~/lib/content.server";
import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { orderPair } from "~/lib/history.server";
import { hasChanges, unifiedPatch } from "~/lib/patch";
import { requireSiteProject } from "~/lib/projects.server";
import { loader as historyLoader } from "~/routes/history";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const SLUG = "de-info";
let site: ReturnType<typeof fakeSite>;
let env: Env;
let versions: string[];

const V1 = "---\ntitle: Post one\n---\nFirst words.\n";
const V2 = "---\ntitle: Post one\n---\nFirst words, revised.\n";
const V3 = "---\ntitle: Post one\n---\nFirst words, revised.\n\nA new closing paragraph.\n";

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const reader = await addPerson("reader@test.invalid");
  await addPerson("stranger@test.invalid");
  const id = await addProject(SLUG, "dustinedwards");
  await share(id, reader, "reader");
  site = fakeSite();
  vi.stubGlobal("fetch", site.fetch);
  env = connectedEnv();
  const owner = await viewerFor("owner@test.invalid");
  const project = await requireSiteProject(testEnv.DB, owner, SLUG, "publish");
  versions = [];
  let expected: string | null = null;
  for (const source of [V1, V2, V3]) {
    const saved = await writeToSite(env, project, owner, "post-one", { action: "save", source, expectedVersion: expected }, site.fetch);
    if (!saved.ok) throw new Error(saved.message);
    expected = saved.version;
    versions.push(saved.version);
  }
  site.requests.length = 0;
});

async function load(email: string, search = "") {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
  context.set(viewerContext, await viewerFor(email));
  context.set(nonceContext, "n");
  const request = new Request(`https://carrel.test/p/${SLUG}/e/post-one/history${search}`);
  return historyLoader({ request, params: { project: SLUG, item: "post-one" }, context } as never);
}

async function refusal(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
  throw new Error("expected a refusal, and the call succeeded");
}

const changeRows = async () => (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM changes").first<{ n: number }>())!.n;

describe("reading history", () => {
  it("lists the revisions newest first for a Reader, and only reads", async () => {
    const before = await changeRows();
    const data = await load("reader@test.invalid");
    expect(data.revisions.map((r) => r.version)).toEqual([...versions].reverse());
    expect(data.revisions).toHaveLength(3);
    expect(site.requests.every((r) => r.startsWith("GET "))).toBe(true);
    expect(await changeRows()).toBe(before);
  });

  it("opens the source of an old revision", async () => {
    const data = await load("reader@test.invalid", `?version=${versions[0]}`);
    expect(data.view).toMatchObject({ kind: "source", source: V1, current: false, previous: null, newest: versions[2] });
    const newest = await load("reader@test.invalid", `?version=${versions[2]}`);
    expect(newest.view).toMatchObject({ kind: "source", source: V3, current: true, previous: versions[1], newest: null });
  });

  it("says plainly when the revision is not one the site holds", async () => {
    const data = await load("reader@test.invalid", "?version=nope");
    expect(data.view).toMatchObject({ kind: "problem", message: "The site has no such revision of this post." });
  });

  it("is answered 404 to someone with no role on the project, before the site is asked", async () => {
    expect(await refusal(load("stranger@test.invalid"))).toBe(404);
    expect(site.requests).toEqual([]);
  });
});

describe("comparing revisions", () => {
  it("sets the older revision against the newer whichever was picked first, from the site's own patch", async () => {
    const data = await load("reader@test.invalid", `?v=${versions[2]}&v=${versions[0]}`);
    expect(data.picked).toEqual([versions[0], versions[2]]);
    expect(data.view.kind).toBe("compare");
    const patch = (data.view as { patch: string }).patch;
    expect(patch).toContain("-First words.\n");
    expect(patch).toContain("+First words, revised.\n");
    expect(patch).toContain("+A new closing paragraph.\n");
    expect(site.requests).toContain("GET /api/carrel/v1/content/post-one/diff");
  });

  it("by word, hands the two revisions' texts to the word compare, older as Before", async () => {
    const data = await load("reader@test.invalid", `?v=${versions[0]}&v=${versions[1]}&by=word`);
    expect(data.view).toMatchObject({ kind: "compare", patch: null, before: { text: V1 }, after: { text: V2 } });
  });

  it("refuses one pick, the same pick twice and a pick the site does not hold, in words", async () => {
    for (const search of [`?v=${versions[0]}`, `?v=${versions[0]}&v=${versions[0]}`, `?v=${versions[0]}&v=nope`]) {
      const data = await load("reader@test.invalid", search);
      expect(data.view, search).toMatchObject({ kind: "problem", message: "Pick two different revisions to compare." });
    }
  });

  it("orders a pair by the site's list, newest first, so the older is always from", () => {
    const list = [
      { version: "c", at: "2026-10-03T00:00:00Z", author: "a", message: "" },
      { version: "b", at: "2026-10-02T00:00:00Z", author: "a", message: "" },
      { version: "a", at: "2026-10-01T00:00:00Z", author: "a", message: "" },
    ];
    expect(orderPair(list, ["c", "a"])).toMatchObject({ from: { version: "a" }, to: { version: "c" } });
    expect(orderPair(list, ["a", "c"])).toMatchObject({ from: { version: "a" }, to: { version: "c" } });
    expect(orderPair(list, ["a"])).toBeNull();
    expect(orderPair(list, ["a", "a"])).toBeNull();
    expect(orderPair(list, ["a", "z"])).toBeNull();
  });
});

describe("comparing the working draft", () => {
  async function ownDraft(source: string) {
    const owner = await viewerFor("owner@test.invalid");
    const project = await requireSiteProject(testEnv.DB, owner, SLUG, "edit");
    await autosave(testEnv.DB, project, owner, "post-one", { source, baseVersion: versions[2]! });
    return { owner, project };
  }

  it("sets the draft against the site's text with a patch built here, and the site is only read", async () => {
    await ownDraft(V3.replace("A new closing paragraph.", "A different closing paragraph."));
    const data = await load("owner@test.invalid", "?compare=site");
    expect(data.view.kind).toBe("compare");
    const patch = (data.view as { patch: string }).patch;
    expect(patch).toContain("-A new closing paragraph.\n");
    expect(patch).toContain("+A different closing paragraph.\n");
    expect(site.requests.every((r) => r.startsWith("GET "))).toBe(true);
  });

  it("says there is nothing to compare when the person has no working draft", async () => {
    const data = await load("owner@test.invalid", "?compare=site");
    expect(data.view).toMatchObject({ kind: "problem" });
    expect((data.view as { message: string }).message).toMatch(/no working draft/);
  });

  it("sets the draft against an AI draft, and a draft that is not the viewer's is not found", async () => {
    const { owner, project } = await ownDraft(V3);
    const saved = await saveAiDraft(env, project, { viewer: owner, client: "Claude Code" }, "post-one", { source: V3.replace("First words, revised.", "First words, tightened."), note: "" }, site.fetch);
    const data = await load("owner@test.invalid", `?compare=ai&ai=${saved.id}`);
    const view = data.view as { kind: string; heading: string; patch: string };
    expect(view.kind).toBe("compare");
    expect(view.heading).toContain("AI draft from Claude Code");
    expect(view.patch).toContain("-First words, revised.\n");
    expect(view.patch).toContain("+First words, tightened.\n");
    expect(await refusal(load("reader@test.invalid", `?compare=ai&ai=${saved.id}`))).toBe(404);
  });
});

describe("the local patch", () => {
  it("names both sides but one file, shows only the changed lines with context, and says nothing changed when nothing did", () => {
    const patch = unifiedPatch("post-one.md", { text: "a\nb\nc\nd\ne\nf\ng\nh\n", label: "On the site" }, { text: "a\nb\nc\nD\ne\nf\ng\nh\n", label: "Your draft" });
    expect(patch).toContain("--- post-one.md\tOn the site");
    expect(patch).toContain("+++ post-one.md\tYour draft");
    expect(patch).toContain("-d\n+D\n");
    expect(hasChanges(patch)).toBe(true);
    const same = unifiedPatch("post-one.md", { text: "same\n", label: "a" }, { text: "same\n", label: "b" });
    expect(hasChanges(same)).toBe(false);
  });
});
