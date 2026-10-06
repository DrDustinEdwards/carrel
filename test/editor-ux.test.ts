// The editor and AI draft screens' behaviour behind the UX pass: "Use as my draft" writes the
// person's working copy in Carrel and nothing to the site, the AI draft's rendered view is private
// to its owner, and the save line says a draft on the site is not live.

import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveAiDraft } from "~/lib/ai.server";
import { readDraft } from "~/lib/content.server";
import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { siteState } from "~/lib/save-state";
import { action as aiDraftAction } from "~/routes/ai-draft";
import { loader as aiPreviewLoader } from "~/routes/ai-draft.preview";

import { addPerson, addProject, resetDb, share } from "./env";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const SLUG = "de-info";
const THEIR_SOURCE = "---\ntitle: The AI's take\nunknown_key: kept\n---\nAn alternative opening.\n";
let site: ReturnType<typeof fakeSite>;
let env: Env;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const id = await addProject(SLUG, "dustinedwards");
  await share(id, editor, "editor");
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

async function aiDraftFor(email: string, item: string) {
  const viewer = await viewerFor(email);
  const project = await requireSiteProject(env.DB, viewer, SLUG, "edit");
  const { id } = await saveAiDraft(env, project, { viewer, client: "Claude" }, item, { source: THEIR_SOURCE });
  return { id, viewer, project };
}

describe("Use as my draft", () => {
  it("writes the working copy in Carrel exactly as the AI wrote it, and sends nothing to the site", async () => {
    const saved = await site.adapter.content.saveDraft("post-one", { source: "---\ntitle: Site copy\n---\nOn the site.\n", expectedVersion: null, changeId: "s" });
    const { id, viewer, project } = await aiDraftFor("owner@test.invalid", "post-one");
    const before = site.requests.length;

    const result = await aiDraftAction({ params: { project: SLUG, item: "post-one", id: String(id) }, request: new Request("https://carrel.test/", { method: "POST" }), context: await context("owner@test.invalid") } as never);
    expect((result as Response).status).toBe(302);

    expect(await readDraft(env.DB, project, viewer, "post-one")).toMatchObject({ source: THEIR_SOURCE });
    expect(site.requests.slice(before).filter((r) => !r.startsWith("GET "))).toEqual([]);
    const onSite = await site.adapter.content.get("post-one");
    expect(onSite?.version).toBe(saved.version);
    expect(onSite?.source).toContain("On the site.");
  });
});

describe("the AI draft's rendered view", () => {
  it("renders the draft through the site for its owner", async () => {
    const { id } = await aiDraftFor("owner@test.invalid", "post-one");
    const response = (await aiPreviewLoader({ params: { project: SLUG, item: "post-one", id: String(id) }, context: await context("owner@test.invalid") } as never)) as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toMatch(/^sandbox; default-src 'none'/);
    expect(await response.text()).toContain("The AI's take");
  });

  it("PLANT: is never shown to another person, whose request answers 404", async () => {
    const { id } = await aiDraftFor("owner@test.invalid", "post-one");
    await expect(aiPreviewLoader({ params: { project: SLUG, item: "post-one", id: String(id) }, context: await context("editor@test.invalid") } as never)).rejects.toMatchObject({ status: 404 });
  });
});

describe("the save line", () => {
  it("does not read as live for a draft on the site", () => {
    expect(siteState("draft", false)).toBe("Saved as a draft on the site. Not published yet.");
    expect(siteState("draft", true)).toBe("Matches the site's draft. It is not live.");
    expect(siteState("scheduled", true)).toMatch(/scheduled/);
    expect(siteState("published", true)).toBe("Matches the live post");
  });
});
