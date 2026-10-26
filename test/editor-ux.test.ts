// The editor and AI draft screens' behavior behind the UX pass: "Use as my draft" writes the
// person's working copy in Carrel and nothing to the site, the AI draft's rendered view is private
// to its owner, and the save line says a draft on the site is not live.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveAiDraft } from "~/lib/ai.server";
import { requireSiteProject } from "~/lib/projects.server";
import { loader as aiPreviewLoader } from "~/routes/ai-draft.preview";

import { addPerson, addProject, resetDb, share } from "./env";
import { connectedEnv, fakeSite, viewerFor, routeContext } from "./site";

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

const context = (email: string) => routeContext(env, email);

async function aiDraftFor(email: string, item: string) {
  const viewer = await viewerFor(email);
  const project = await requireSiteProject(env.DB, viewer, SLUG, "edit");
  const { id } = await saveAiDraft(env, project, { viewer, client: "Claude" }, item, { source: THEIR_SOURCE });
  return { id, viewer, project };
}

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
