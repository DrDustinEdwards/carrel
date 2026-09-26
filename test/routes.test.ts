// The editor's routes, driven through their loaders and actions with a real request context: the
// preview is private to each person and sandboxed, and a first publish asks before it acts.

import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { autosave } from "~/lib/content.server";
import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { action as editorAction } from "~/routes/editor";
import { loader as previewLoader } from "~/routes/preview";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const SLUG = "de-info";

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const reader = await addPerson("reader@test.invalid");
  await addPerson("stranger@test.invalid");
  const projectId = await addProject(SLUG, "dustinedwards");
  await share(projectId, editor, "editor");
  await share(projectId, reader, "reader");
});

async function contextFor(email: string, env: Env) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
  context.set(viewerContext, await viewerFor(email));
  context.set(nonceContext, "test-nonce");
  return context;
}

async function preview(email: string, env: Env) {
  const context = await contextFor(email, env);
  const request = new Request(`https://carrel.test/p/${SLUG}/e/post-one/preview`);
  try {
    return (await previewLoader({ request, params: { project: SLUG, item: "post-one" }, context } as never)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function post(email: string, env: Env, fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = new Request(`https://carrel.test/p/${SLUG}/e/post-one`, { method: "POST", body });
  return editorAction({ request, params: { project: SLUG, item: "post-one" }, context: await contextFor(email, env) } as never);
}

async function seedPost(site: ReturnType<typeof fakeSite>) {
  const saved = await site.adapter.content.saveDraft("post-one", { source: "---\ntitle: Site copy\n---\nOn the site.\n", expectedVersion: null, changeId: "seed" });
  return saved.version;
}

describe("the preview", () => {
  it("renders the viewer's own draft through the site, sandboxed and frameable by Carrel only", async () => {
    const site = fakeSite();
    vi.stubGlobal("fetch", site.fetch);
    const env = connectedEnv();
    const version = await seedPost(site);
    const owner = await viewerFor("owner@test.invalid");
    const project = await requireSiteProject(env.DB, owner, SLUG, "read");
    await autosave(env.DB, project, owner, "post-one", { source: "---\ntitle: Owner draft\n---\nNot on the site.\n", baseVersion: version });

    const response = await preview("owner@test.invalid", env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toMatch(/^sandbox; default-src 'none'/);
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    const html = await response.text();
    expect(html).toContain("Owner draft");
    expect(html).toContain('<base href="https://site.test/">');
  });

  it("PLANT: never shows one person's working draft to another", async () => {
    const site = fakeSite();
    vi.stubGlobal("fetch", site.fetch);
    const env = connectedEnv();
    const version = await seedPost(site);
    const editor = await viewerFor("editor@test.invalid");
    const project = await requireSiteProject(env.DB, editor, SLUG, "edit");
    await autosave(env.DB, project, editor, "post-one", { source: "---\ntitle: Editor secret\n---\nx\n", baseVersion: version });

    const html = await (await preview("reader@test.invalid", env)).text();
    expect(html).toContain("Site copy");
    expect(html).not.toContain("Editor secret");
  });

  it("PLANT: refuses a non-member with the same 404 as a missing project", async () => {
    vi.stubGlobal("fetch", fakeSite().fetch);
    expect((await preview("stranger@test.invalid", connectedEnv())).status).toBe(404);
  });

  it("explains a site that is not connected inside the frame instead of failing", async () => {
    const response = await preview("owner@test.invalid", testEnv);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("not connected");
  });
});

describe("publishing from the editor", () => {
  it("asks before a first publish, and publishes on the explicit second ask", async () => {
    const site = fakeSite();
    vi.stubGlobal("fetch", site.fetch);
    const env = connectedEnv();
    const version = await seedPost(site);

    const ask = await post("owner@test.invalid", env, { intent: "publish", expectedVersion: version, source: "---\ntitle: Site copy\n---\nOn the site.\n" });
    expect(ask).toEqual({ intent: "publish", needsConfirm: true });
    expect(site.adapter.store.get("post-one")!.doc.status).toBe("draft");

    const done = await post("owner@test.invalid", env, {
      intent: "publish",
      confirm: "first-publish",
      expectedVersion: version,
      source: "---\ntitle: Site copy\n---\nOn the site.\n",
    });
    expect(done).toMatchObject({ intent: "write", outcome: { ok: true, status: "published" } });
  });

  it("PLANT: refuses an Editor's publish from the editor, confirmed or not", async () => {
    const site = fakeSite();
    vi.stubGlobal("fetch", site.fetch);
    const env = connectedEnv();
    const version = await seedPost(site);
    await expect(
      post("editor@test.invalid", env, { intent: "publish", confirm: "first-publish", expectedVersion: version, source: "x" }),
    ).rejects.toSatisfy((thrown: unknown) => thrown instanceof Response && thrown.status === 403);
    expect(site.adapter.store.get("post-one")!.doc.status).toBe("draft");
  });
});
