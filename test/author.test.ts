// The Author role (Dustin's ruling, 2026-10-29): an Author publishes and unpublishes the posts they
// wrote, and nothing of anyone else's. Planted: an Author's publish of the Owner's post, through the
// function and through the editor's route, is refused before the site is asked to change anything.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { writeToSite } from "~/lib/content.server";
import { setProjectRole } from "~/lib/people-admin.server";
import { requireSiteProject } from "~/lib/projects.server";
import { action as editorAction, loader as editorLoader } from "~/routes/editor";

import { addBook, addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, refusal, routeContext, viewerFor } from "./site";

const SLUG = "de-info";
const AUTHOR = "author@test.invalid";
const OWNER = "owner@test.invalid";

let site: ReturnType<typeof fakeSite>;
let env: Env;
let projectId: number;

beforeEach(async () => {
  await resetDb();
  await addPerson(OWNER, { owner: true });
  const author = await addPerson(AUTHOR);
  projectId = await addProject(SLUG, "dustinedwards");
  await share(projectId, author, "author");
  site = fakeSite();
  env = connectedEnv();
  vi.stubGlobal("fetch", site.fetch);
});

async function as(email: string) {
  const viewer = await viewerFor(email);
  return { viewer, project: await requireSiteProject(testEnv.DB, viewer, SLUG, "read") };
}

/** A new post saved to the site by `email`, which makes them its author. */
async function create(email: string, id: string) {
  const { viewer, project } = await as(email);
  const saved = await writeToSite(env, project, viewer, id, { action: "save", source: `# ${id}\n`, expectedVersion: null });
  if (!saved.ok) throw new Error(saved.message);
  return saved.version;
}

const writes = () => site.requests.filter((r) => !r.startsWith("GET"));

describe("an Author", () => {
  it("publishes, changes and unpublishes a post they wrote", async () => {
    const { viewer, project } = await as(AUTHOR);
    const published = await writeToSite(env, project, viewer, "mine", { action: "publish", expectedVersion: await create(AUTHOR, "mine") });
    expect(published).toMatchObject({ ok: true, status: "published" });
    const changed = await writeToSite(env, project, viewer, "mine", { action: "save", source: "# Mine, changed\n", expectedVersion: published.ok ? published.version : "" });
    expect(changed).toMatchObject({ ok: true, status: "published" });
    const off = await writeToSite(env, project, viewer, "mine", { action: "unpublish", expectedVersion: changed.ok ? changed.version : "" });
    expect(off).toMatchObject({ ok: true, status: "draft" });
  });

  it("PLANT: is refused the Owner's post, by the function and the editor, before the site is asked", async () => {
    const version = await create(OWNER, "owners");
    const { viewer, project } = await as(AUTHOR);
    site.requests.length = 0;
    expect(await refusal(writeToSite(env, project, viewer, "owners", { action: "publish", expectedVersion: version }))).toBe(403);
    const url = `https://carrel.test/p/${SLUG}/e/owners`;
    const form = new FormData();
    for (const [k, v] of Object.entries({ intent: "publish", source: "# owners\n", expectedVersion: version, confirm: "first-publish" })) form.set(k, v);
    const params = { project: SLUG, item: "owners" };
    expect(await refusal(editorAction({ request: new Request(url, { method: "POST", body: form }), params, context: await routeContext(env, AUTHOR) } as never))).toBe(403);
    expect(writes()).toEqual([]);
    // The editor offers the controls on their own post only, and the flag dismissal on none.
    const opened = (await editorLoader({ request: new Request(url), params, context: await routeContext(env, AUTHOR) } as never)) as { canPublish: boolean; canDismiss: boolean };
    expect(opened).toMatchObject({ canPublish: false, canDismiss: false });
  });

  it("is granted only to a person on a site's project", async () => {
    const owner = await viewerFor(OWNER);
    const agent = await addPerson("agent:grok");
    const reviewer = await addPerson("reviewer@test.invalid", { reviewer: true });
    const book = await addBook("novel");
    const person = (await viewerFor(AUTHOR)).id;
    await expect(setProjectRole(testEnv.DB, owner, agent, projectId, "author")).rejects.toThrow(/never publish/);
    await expect(setProjectRole(testEnv.DB, owner, reviewer, projectId, "author")).rejects.toThrow(/reviewer/);
    await expect(setProjectRole(testEnv.DB, owner, person, book, "author")).rejects.toThrow(/book/);
    await setProjectRole(testEnv.DB, owner, agent, projectId, "editor");
  });
});
