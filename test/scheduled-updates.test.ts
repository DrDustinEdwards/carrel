// Scheduling an update to a live post (site-api v0.10.0, DrDustinEdwards/site-api#59): the post stays
// live and the site holds the new text until its time. Planted: on a site without scheduled updates,
// which would take the post down until then, Carrel refuses before asking the site anything.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { writeToSite } from "~/lib/content.server";
import { requireSiteProject } from "~/lib/projects.server";
import { loader as editorLoader } from "~/routes/editor";
import { loader as projectLoader } from "~/routes/project";

import { addPerson, addProject, resetDb, testEnv } from "./env";
import { connectedEnv, nextSite, routeContext, viewerFor } from "./site";

const SLUG = "de-info";
const OWNER = "owner@test.invalid";
const AT = "2030-01-02T03:04:00.000Z";

let env: Env;

beforeEach(async () => {
  await resetDb();
  await addPerson(OWNER, { owner: true });
  await addProject(SLUG, "dustinedwards");
  env = connectedEnv();
});

/** A live post, and the Owner's way to write to it. */
async function live(site: ReturnType<typeof nextSite>) {
  vi.stubGlobal("fetch", site.fetch);
  const viewer = await viewerFor(OWNER);
  const project = await requireSiteProject(testEnv.DB, viewer, SLUG, "read");
  const saved = await writeToSite(env, project, viewer, "post", { action: "save", source: "# Live\n", expectedVersion: null });
  const published = await writeToSite(env, project, viewer, "post", { action: "publish", expectedVersion: saved.ok ? saved.version : "" });
  if (!published.ok) throw new Error(published.message);
  return { viewer, project, version: published.version };
}

const actions = async () => (await testEnv.DB.prepare("SELECT action FROM changes ORDER BY rowid").all<{ action: string }>()).results.map((r) => r.action);

describe("a scheduled update to a live post", () => {
  it("keeps the post live, shows the update waiting, and cancels it", async () => {
    const site = nextSite({ scheduledUpdates: true });
    const { viewer, project, version } = await live(site);
    const scheduled = await writeToSite(env, project, viewer, "post", { action: "schedule", expectedVersion: version, publishAt: AT, source: "# Live, updated\n" });
    expect(scheduled).toMatchObject({ ok: true, status: "published" });
    expect((await site.adapter.content.get("post"))).toMatchObject({ status: "published", source: "# Live\n" });

    const context = await routeContext(env, OWNER);
    const opened = (await editorLoader({ request: new Request(`https://carrel.test/p/${SLUG}/e/post`), params: { project: SLUG, item: "post" }, context } as never)) as {
      scheduledUpdates: boolean;
      pendingUpdate: { publishAt: string; source: string } | null;
    };
    expect(opened).toMatchObject({ scheduledUpdates: true, pendingUpdate: { publishAt: AT, source: "# Live, updated\n" } });
    const list = await projectLoader({ request: new Request(`https://carrel.test/p/${SLUG}`), params: { project: SLUG }, context } as never);
    expect(list.data?.rows.find((r) => r.id === "post")?.scheduledUpdate?.publishAt).toBe(AT);

    const canceled = await writeToSite(env, project, viewer, "post", { action: "unschedule", expectedVersion: scheduled.ok ? scheduled.version : "" });
    expect(canceled).toMatchObject({ ok: true, action: "unschedule", status: "published" });
    expect(site.adapter.store.get("post")?.pending).toBeUndefined();
    expect(await actions()).toEqual(["save", "publish", "schedule", "unschedule"]);
  });

  it("PLANT: is refused on a site that would take the post down, before the site is asked", async () => {
    const site = nextSite();
    const { viewer, project, version } = await live(site);
    site.requests.length = 0;
    const outcome = await writeToSite(env, project, viewer, "post", { action: "schedule", expectedVersion: version, publishAt: AT, source: "# Live, updated\n" });
    expect(outcome).toMatchObject({ ok: false, reason: "refused", message: expect.stringContaining("cannot keep a post live") });
    expect(site.requests.filter((r) => !r.startsWith("GET"))).toEqual([]);
    expect((await site.adapter.content.get("post"))?.status).toBe("published");
  });
});
