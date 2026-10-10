// Every kind the site reports, end to end through the routes: a non-post kind lists under its own
// kind and filter, opens, saves, previews, publishes and shows its revisions exactly as a post does,
// and a data kind the site will not write stays out of the lists and, if reached, shows the site's
// own refusal. Carrel has no per-kind code; the kinds and paths come from the site.

import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { refreshIndex } from "~/lib/index.server";
import { action as editorAction, loader as editorLoader } from "~/routes/editor";
import { loader as historyLoader } from "~/routes/history";
import { loader as previewLoader } from "~/routes/preview";
import { loader as projectLoader } from "~/routes/project";

import { addPerson, addProject, resetDb } from "./env";
import { connectedEnv, fakeSite, kindedAdapter, viewerFor } from "./site";

const SLUG = "de-info";
const OWNER = "owner@test.invalid";
let projectId = 0;

beforeEach(async () => {
  await resetDb();
  await addPerson(OWNER, { owner: true });
  projectId = await addProject(SLUG, "dustinedwards");
});

async function contextFor(env: Env) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
  context.set(viewerContext, await viewerFor(OWNER));
  context.set(nonceContext, "test-nonce");
  return context;
}

async function settled<T>(run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function seeded() {
  const site = fakeSite(kindedAdapter());
  vi.stubGlobal("fetch", site.fetch);
  const env = connectedEnv();
  const put = async (id: string, source: string, publish: boolean) => {
    const saved = await site.adapter.content.saveDraft(id, { source, expectedVersion: null, changeId: `seed-${id}` });
    if (publish) await site.adapter.content.publish(id, { expectedVersion: saved.version, changeId: `seed-pub-${id}` });
  };
  await put("a-post", "---\ntitle: A post\n---\nWords.\n", true);
  await put("draft-post", "---\ntitle: A draft post\n---\nNot yet.\n", false);
  await put("phage.acorn15", "---\ntitle: Acorn15\nhost: Gordonia\n---\nA cluster DJ phage.\n", true);
  await put("roster.2017", "---\ntitle: 2017 cohort\nyear: 2017\n---\n", true);
  await put("procedure.coi-primers", "---\ntitle: COI primers\n---\nThe PCR protocol.\n", true);
  await refreshIndex(env, { id: projectId, site: "dustinedwards" });
  return { site, env };
}

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return body;
};

describe("every kind the site reports", () => {
  it("lists each writing kind under its own kind, and the kind filter narrows to it", async () => {
    const { env } = await seeded();
    const context = await contextFor(env);
    const all = (await projectLoader({ request: new Request(`https://carrel.test/p/${SLUG}`), params: { project: SLUG }, context } as never)) as Awaited<ReturnType<typeof projectLoader>>;
    expect(all.kinds).toEqual(["phage", "post", "procedure", "roster"]);
    const byId = Object.fromEntries(all.items.map((i) => [i.itemId, i]));
    expect(byId["phage.acorn15"]).toMatchObject({ kind: "phage", path: "/research/phages#acorn15", status: "published" });
    expect(byId["roster.2017"]).toMatchObject({ kind: "roster", path: "/teaching/phage-discovery#year-2017" });
    expect(byId["procedure.coi-primers"]).toMatchObject({ kind: "procedure", path: "/research/protocols/coi-primers" });
    expect(byId["draft-post"]).toMatchObject({ kind: "post", status: "draft", path: null });

    const phages = (await projectLoader({ request: new Request(`https://carrel.test/p/${SLUG}?kind=phage`), params: { project: SLUG }, context } as never)) as Awaited<ReturnType<typeof projectLoader>>;
    expect(phages.items.map((i) => i.itemId)).toEqual(["phage.acorn15"]);
  });

  it("opens, saves, previews, publishes and shows the history of a non-post kind", async () => {
    const { env, site } = await seeded();
    const id = "phage.acorn15";
    const params = { project: SLUG, item: id };
    const url = `https://carrel.test/p/${SLUG}/e/${id}`;

    const opened = (await editorLoader({ request: new Request(url), params, context: await contextFor(env) } as never)) as Awaited<ReturnType<typeof editorLoader>>;
    expect(opened.title).toBe("Acorn15");
    expect(opened.path).toBe("/research/phages#acorn15");
    // Links written in the editor go to each item's own address on the site, a draft post to where the site's posts live.
    expect(opened.linkTargets.map((t) => t.href).sort()).toEqual([
      "/research/protocols/coi-primers",
      "/teaching/phage-discovery#year-2017",
      "/writing/a-post",
      "/writing/draft-post",
    ]);

    const source = "---\ntitle: Acorn15\nhost: Gordonia terrae\n---\nA cluster DJ phage, found in 2015.\n";
    const saved = await editorAction({ request: new Request(url, { method: "POST", body: form({ intent: "save", source, expectedVersion: opened.version! }) }), params, context: await contextFor(env) } as never);
    expect(saved).toMatchObject({ intent: "write", outcome: { ok: true, action: "save", status: "published" } });
    const version = (saved as { outcome: { version: string } }).outcome.version;

    const previewed = (await settled(async () => previewLoader({ request: new Request(`${url}/preview`), params, context: await contextFor(env) } as never))) as Response;
    expect(previewed.status).toBe(200);
    expect(await previewed.text()).toContain("found in 2015");

    const published = await editorAction({ request: new Request(url, { method: "POST", body: form({ intent: "publish", source, expectedVersion: version }) }), params, context: await contextFor(env) } as never);
    expect(published).toMatchObject({ intent: "write", outcome: { ok: true, action: "publish", status: "published" } });
    expect((await site.adapter.content.get(id))?.source).toContain("found in 2015");

    const history = (await historyLoader({ request: new Request(`${url}/history`), params, context: await contextFor(env) } as never)) as { revisions: unknown[] | null };
    expect(history.revisions?.length).toBe(4);
  });

  it("keeps a data kind out of the lists, and shows the site's own refusal if one is written", async () => {
    const { env, site } = await seeded();
    // The site's import puts registry rows in place directly; Carrel never wrote them.
    await env.DB.prepare("INSERT INTO site_items (project_id, item_id, kind, title, status, synced_at) VALUES (?, 'equipment.heat-block', 'equipment', 'Heat block', 'published', '2026-10-10T00:00:00Z')").bind(projectId).run();
    const context = await contextFor(env);
    const listed = (await projectLoader({ request: new Request(`https://carrel.test/p/${SLUG}`), params: { project: SLUG }, context } as never)) as Awaited<ReturnType<typeof projectLoader>>;
    expect(listed.kinds).not.toContain("equipment");
    expect(listed.items.map((i) => i.itemId)).not.toContain("equipment.heat-block");

    const params = { project: SLUG, item: "equipment.heat-block" };
    const written = await editorAction({
      request: new Request(`https://carrel.test/p/${SLUG}/e/equipment.heat-block`, { method: "POST", body: form({ intent: "save", source: "---\nname: Heat block\n---\n", expectedVersion: "" }) }),
      params,
      context: await contextFor(env),
    } as never);
    expect(written).toMatchObject({ intent: "write", outcome: { ok: false, reason: "refused", message: "The site's equipment entries are edited in the site's repository, not through Carrel." } });
    expect(await site.adapter.content.get("equipment.heat-block")).toBeNull();
  });
});
