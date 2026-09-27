// The browser's side of AI work: the unpublish page the email links to, the AI draft page, and
// flags in the editor. Driven through loaders and actions with a real request context.

import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { addFinding, saveAiDraft } from "~/lib/ai.server";
import { readDraft } from "~/lib/content.server";
import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { action as aiDraftAction, loader as aiDraftLoader } from "~/routes/ai-draft";
import { action as editorAction, loader as editorLoader } from "~/routes/editor";
import { action as unpublishAction, loader as unpublishLoader } from "~/routes/unpublish";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const SLUG = "de-info";
let site: ReturnType<typeof fakeSite>;
let env: Env;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const id = await addProject(SLUG, "dustinedwards");
  await share(id, editor, "editor");
  site = fakeSite();
  // The routes call the site through the global fetch, as the Worker does.
  vi.stubGlobal("fetch", site.fetch);
  env = connectedEnv();
});

async function context(email: string) {
  const c = new RouterContextProvider();
  c.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
  c.set(viewerContext, await viewerFor(email));
  c.set(nonceContext, "n");
  return c;
}

async function settle<T>(p: Promise<T>): Promise<T | Response> {
  try {
    return await p;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function published() {
  const saved = await site.adapter.content.saveDraft("post-one", { source: "---\ntitle: Post one\n---\nWords.\n", expectedVersion: null, changeId: "s" });
  await site.adapter.content.publish("post-one", { expectedVersion: saved.version, changeId: "p" });
}

async function as(email: string) {
  const viewer = await viewerFor(email);
  return { viewer, project: await requireSiteProject(testEnv.DB, viewer, SLUG, "read") };
}

describe("the unpublish page", () => {
  it("opens without changing anything, and one button returns the post to draft", async () => {
    await published();
    const params = { project: SLUG, item: "post-one" };
    const page = (await unpublishLoader({ request: new Request("https://carrel.test/"), params, context: await context("owner@test.invalid") } as never)) as Awaited<
      ReturnType<typeof unpublishLoader>
    >;
    expect(page.item).toMatchObject({ title: "Post one", status: "published" });
    expect((await site.adapter.content.get("post-one"))?.status).toBe("published");

    const done = await unpublishAction({ request: new Request("https://carrel.test/", { method: "POST" }), params, context: await context("owner@test.invalid") } as never);
    expect(done).toMatchObject({ ok: true, message: "Returned to draft. It is off the site." });
    expect((await site.adapter.content.get("post-one"))?.status).toBe("draft");
  });

  it("PLANT: an Editor cannot open it or use it", async () => {
    await published();
    const params = { project: SLUG, item: "post-one" };
    expect(((await settle(unpublishLoader({ request: new Request("https://carrel.test/"), params, context: await context("editor@test.invalid") } as never))) as Response).status).toBe(403);
    expect(
      ((await settle(unpublishAction({ request: new Request("https://carrel.test/", { method: "POST" }), params, context: await context("editor@test.invalid") } as never))) as Response).status,
    ).toBe(403);
    expect((await site.adapter.content.get("post-one"))?.status).toBe("published");
  });
});

describe("AI drafts in the browser", () => {
  it("shows an AI draft to the person whose session saved it, and Use as my draft replaces only their working copy", async () => {
    await published();
    const { viewer, project } = await as("owner@test.invalid");
    const saved = await saveAiDraft(env, project, { viewer, client: "Claude 1.0", sessionId: "s" }, "post-one", { source: "AI text.", note: "A note." }, site.fetch);
    const params = { project: SLUG, item: "post-one", id: String(saved.id) };
    const page = (await aiDraftLoader({ request: new Request("https://carrel.test/"), params, context: await context("owner@test.invalid") } as never)) as Awaited<ReturnType<typeof aiDraftLoader>>;
    expect(page.draft).toMatchObject({ client: "Claude 1.0", note: "A note.", source: "AI text." });

    const used = (await aiDraftAction({ request: new Request("https://carrel.test/", { method: "POST" }), params, context: await context("owner@test.invalid") } as never)) as Response;
    expect(used.headers.get("Location")).toBe(`/p/${SLUG}/e/post-one`);
    expect((await readDraft(testEnv.DB, project, viewer, "post-one"))?.source).toBe("AI text.");
    expect((await site.adapter.content.get("post-one"))?.source).toBe("---\ntitle: Post one\n---\nWords.\n");
  });

  it("PLANT: another person cannot see someone's AI draft", async () => {
    const { viewer, project } = await as("owner@test.invalid");
    const saved = await saveAiDraft(env, project, { viewer, client: "Claude", sessionId: "s" }, "post-one", { source: "Private." }, site.fetch);
    const params = { project: SLUG, item: "post-one", id: String(saved.id) };
    expect(((await settle(aiDraftLoader({ request: new Request("https://carrel.test/"), params, context: await context("editor@test.invalid") } as never))) as Response).status).toBe(404);
  });
});

describe("flags in the editor", () => {
  it("lists flags, and only the Owner dismisses one", async () => {
    await published();
    const reviewer = await viewerFor("owner@test.invalid");
    const { project } = await as("owner@test.invalid");
    const flag = await addFinding(testEnv.DB, project, { viewer: { ...reviewer, isReviewer: true }, client: "Grok Build", sessionId: "s" }, "post-one", { message: "Check this." });
    const params = { project: SLUG, item: "post-one" };
    const data = (await editorLoader({ request: new Request("https://carrel.test/"), params, context: await context("editor@test.invalid") } as never)) as Awaited<ReturnType<typeof editorLoader>>;
    expect(data.flags).toMatchObject([{ status: "open", message: "Check this. (from Grok Build)" }]);

    const dismiss = (email: string) => {
      const body = new FormData();
      body.set("intent", "dismiss-flag");
      body.set("flag", String(flag.id));
      return context(email).then((c) => settle(editorAction({ request: new Request("https://carrel.test/", { method: "POST", body }), params, context: c } as never)));
    };
    expect(((await dismiss("editor@test.invalid")) as Response).status).toBe(403);
    expect(await dismiss("owner@test.invalid")).toEqual({ intent: "dismiss-flag", dismissed: flag.id });
  });
});
