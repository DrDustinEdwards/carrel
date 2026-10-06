// Work waiting on a person that the site does not know yet: an AI draft for a new slug is listed in
// the project's Posts, opens in the editor and previews as the AI draft; an indexed post carries a
// count of AI drafts waiting. All of it private to the person the drafts belong to.

import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveAiDraft } from "~/lib/ai.server";
import { autosave } from "~/lib/content.server";
import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { refreshIndex } from "~/lib/index.server";
import { requireSiteProject } from "~/lib/projects.server";
import { titleOf } from "~/lib/waiting.server";
import { loader as editorLoader } from "~/routes/editor";
import { loader as previewLoader } from "~/routes/preview";
import { loader as projectLoader } from "~/routes/project";

import { addPerson, addProject, resetDb, share } from "./env";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const SLUG = "de-info";
let site: ReturnType<typeof fakeSite>;
let env: Env;
let projectId: number;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  projectId = await addProject(SLUG, "dustinedwards");
  await share(projectId, editor, "editor");
  site = fakeSite();
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

async function aiDraft(email: string, item: string, source: string) {
  const viewer = await viewerFor(email);
  const project = await requireSiteProject(env.DB, viewer, SLUG, "edit");
  await saveAiDraft(env, project, { viewer, client: "Claude" }, item, { source });
}

async function list(email: string, query = "") {
  const request = new Request(`https://carrel.test/p/${SLUG}${query}`);
  return (await projectLoader({ request, params: { project: SLUG }, context: await context(email) } as never)).items;
}

const NEW_POST = "---\ntitle: A desk apart\n---\nWords for a new post.\n";

describe("the project's Posts list", () => {
  it("lists an AI draft for a post the site does not have, and its editor opens", async () => {
    await aiDraft("owner@test.invalid", "a-desk-apart", NEW_POST);
    const items = await list("owner@test.invalid");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ itemId: "a-desk-apart", title: "A desk apart", status: "draft", isNew: true, aiDrafts: 1 });

    const page = await editorLoader({ params: { project: SLUG, item: "a-desk-apart" }, context: await context("owner@test.invalid") } as never);
    expect(page.source).toBe("");
    expect(page.aiDrafts).toHaveLength(1);
  });

  it("includes it under the Draft filter and the search, and leaves it out of Published and a kind", async () => {
    await aiDraft("owner@test.invalid", "a-desk-apart", NEW_POST);
    expect(await list("owner@test.invalid", "?status=draft")).toHaveLength(1);
    expect(await list("owner@test.invalid", "?q=desk")).toHaveLength(1);
    expect(await list("owner@test.invalid", "?q=elephant")).toHaveLength(0);
    expect(await list("owner@test.invalid", "?status=published")).toHaveLength(0);
    expect(await list("owner@test.invalid", "?kind=post")).toHaveLength(0);
  });

  it("lists a draft of the person's own for a new post too", async () => {
    const owner = await viewerFor("owner@test.invalid");
    const project = await requireSiteProject(env.DB, owner, SLUG, "edit");
    await autosave(env.DB, project, owner, "mine", { source: "---\ntitle: Mine\n---\nx\n", baseVersion: null });
    const items = await list("owner@test.invalid");
    expect(items[0]).toMatchObject({ itemId: "mine", title: "Mine", isNew: true, ownDraft: true, aiDrafts: 0 });
  });

  it("marks an indexed post that has AI drafts waiting, with the count", async () => {
    const saved = await site.adapter.content.saveDraft("post-one", { source: "---\ntitle: Post one\n---\nOn the site.\n", expectedVersion: null, changeId: "s" });
    expect(saved.version).toBeTruthy();
    await refreshIndex(env, { id: projectId, site: "dustinedwards" });
    await aiDraft("owner@test.invalid", "post-one", "A better take.");
    await aiDraft("owner@test.invalid", "post-one", "Another take.");
    const items = await list("owner@test.invalid");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ itemId: "post-one", isNew: false, aiDrafts: 2 });
  });

  it("PLANT: shows nobody else's AI drafts, and the editor of one still answers 404", async () => {
    await aiDraft("editor@test.invalid", "a-desk-apart", NEW_POST);
    expect(await list("owner@test.invalid")).toHaveLength(0);
    await expect(editorLoader({ params: { project: SLUG, item: "a-desk-apart" }, context: await context("owner@test.invalid") } as never)).rejects.toMatchObject({ status: 404 });
  });
});

describe("the preview of an AI-draft-only post", () => {
  it("renders the AI draft through the site, labelled as an AI draft", async () => {
    await aiDraft("owner@test.invalid", "a-desk-apart", NEW_POST);
    const request = new Request(`https://carrel.test/p/${SLUG}/e/a-desk-apart/preview`);
    const response = (await previewLoader({ request, params: { project: SLUG, item: "a-desk-apart" }, context: await context("owner@test.invalid") } as never)) as Response;
    const html = await response.text();
    expect(html).toContain("A desk apart");
    expect(html).toContain("AI draft from Claude. It is not your draft and it is not on the site.");
  });

  it("still says there is nothing to preview when there is no AI draft either", async () => {
    const request = new Request(`https://carrel.test/p/${SLUG}/e/none/preview`);
    const response = (await previewLoader({ request, params: { project: SLUG, item: "none" }, context: await context("owner@test.invalid") } as never)) as Response;
    expect(await response.text()).toContain("There is nothing to preview yet.");
  });
});

describe("titleOf", () => {
  it("reads a plain or quoted frontmatter title, and nothing when there is none", () => {
    expect(titleOf("---\ntitle: Plain\n---\nx")).toBe("Plain");
    expect(titleOf('---\ntitle: "Quoted: yes"\n---\nx')).toBe("Quoted: yes");
    expect(titleOf("No frontmatter\ntitle: nope")).toBe("");
  });
});
