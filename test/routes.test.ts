// The editor's routes, driven through their loaders and actions with a real request context: the
// preview is private to each person and sandboxed, and a first publish asks before it acts.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { autosave } from "~/lib/content.server";
import { requireSiteProject } from "~/lib/projects.server";
import { action as editorAction, loader as editorLoader } from "~/routes/editor";
import { loader as previewLoader } from "~/routes/preview";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, routeContext, settle, viewerFor } from "./site";

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

const contextFor = (email: string, env: Env) => routeContext(env, email);

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

/** The seeded post, opened in the editor by the owner, as a publish from the editor needs. */
async function openedByOwner(site: ReturnType<typeof fakeSite>) {
  const env = connectedEnv();
  await seedPost(site);
  await editorLoader({ request: new Request(`https://carrel.test/p/${SLUG}/e/post-one`), params: { project: SLUG, item: "post-one" }, context: await contextFor("owner@test.invalid", env) } as never);
  return env;
}

describe("the preview", () => {
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
    const env = await openedByOwner(site);

    const ask = await post("owner@test.invalid", env, { intent: "publish" });
    expect(ask).toEqual({ intent: "publish", needsConfirm: true });
    expect(site.adapter.store.get("post-one")!.doc.status).toBe("draft");

    const done = await post("owner@test.invalid", env, { intent: "publish", confirm: "first-publish" });
    expect(done).toMatchObject({ intent: "write", outcome: { ok: true, status: "published" } });
  });

  it("publishes under the date the person gave (A4), and makes a preview link as long as the site allows (E2)", async () => {
    const site = fakeSite();
    const sent: Record<string, unknown>[] = [];
    // TODO site-api 0.19: the fake site declares previewLinkHours and makes the link itself.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path.endsWith("/preview-links")) {
        sent.push((await request.json()) as Record<string, unknown>);
        return Response.json({ token: "a".repeat(43), url: "https://site.test/preview/aaa", expiresAt: "2030-01-31T00:00:00.000Z" });
      }
      const answer = await site.fetch(request);
      if (!path.endsWith("/meta")) return answer;
      const meta = (await answer.json()) as { capabilities: object };
      return Response.json({ ...meta, capabilities: { ...meta.capabilities, previewLinks: true, ...(sent.length > 0 ? {} : { previewLinkHours: { max: 720 } }) } });
    });
    const env = await openedByOwner(site);

    const done = await post("owner@test.invalid", env, { intent: "publish", confirm: "first-publish", publishedAt: "2024-05-01T09:00:00.000Z" });
    expect(done).toMatchObject({ intent: "write", outcome: { ok: true, status: "published" } });
    expect(site.adapter.store.get("post-one")!.doc.publishedAt).toBe("2024-05-01T09:00:00.000Z");
    expect(await settle(post("owner@test.invalid", env, { intent: "publish", confirm: "first-publish", publishedAt: "2999-01-01T00:00:00.000Z" }))).toSatisfy((r: unknown) => r instanceof Response && r.status === 400);

    // A month where the site says it keeps one (v0.19.0), and at most a week, under the old name, where it does not.
    expect(await post("owner@test.invalid", env, { intent: "preview-link", hours: "720" })).toMatchObject({ intent: "preview-link", link: { ok: true, url: "https://site.test/preview/aaa" } });
    await post("owner@test.invalid", env, { intent: "preview-link", hours: "720" });
    expect(sent.map(({ changeId: _, ...rest }) => rest)).toEqual([
      { id: "post-one", expiresInHours: 720, actor: { name: "owner" } },
      { id: "post-one", hours: 168, actor: { name: "owner" } },
    ]);
  });

  it("PLANT: refuses an Editor's publish from the editor, confirmed or not", async () => {
    const site = fakeSite();
    vi.stubGlobal("fetch", site.fetch);
    const env = connectedEnv();
    await seedPost(site);
    await expect(
      post("editor@test.invalid", env, { intent: "publish", confirm: "first-publish" }),
    ).rejects.toSatisfy((thrown: unknown) => thrown instanceof Response && thrown.status === 403);
    expect(site.adapter.store.get("post-one")!.doc.status).toBe("draft");
  });
});
