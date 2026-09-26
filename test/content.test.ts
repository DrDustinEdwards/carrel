// Planted problems for writes to a site (design section 7, "Access, roles, key"): a Reader saves, an
// Editor publishes, an Editor changes a live post, a non-member reads, and a stale expectedVersion.
// Each must be refused, and refused before the site is asked to change anything.

import { beforeEach, describe, expect, it } from "vitest";

import { autosave, readDraft, writeToSite } from "~/lib/content.server";
import { requireSiteProject } from "~/lib/projects.server";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const SLUG = "de-info";

async function refusal(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
  throw new Error("expected a refusal, and the call succeeded");
}

let projectId: number;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const reader = await addPerson("reader@test.invalid");
  await addPerson("stranger@test.invalid");
  projectId = await addProject(SLUG, "dustinedwards");
  await share(projectId, editor, "editor");
  await share(projectId, reader, "reader");
});

async function as(email: string, action: "read" | "edit" | "publish" = "read") {
  const viewer = await viewerFor(email);
  return { viewer, project: await requireSiteProject(testEnv.DB, viewer, SLUG, action) };
}

/** A post already on the site, saved by the Owner, returned with its current version. */
async function seed(site: ReturnType<typeof fakeSite>, env: Env, status: "draft" | "published" = "draft") {
  const { viewer, project } = await as("owner@test.invalid");
  const saved = await writeToSite(env, project, viewer, "post-one", { action: "save", source: "# One\n", expectedVersion: null }, site.fetch);
  if (!saved.ok) throw new Error(saved.message);
  if (status === "draft") return saved.version;
  const published = await writeToSite(env, project, viewer, "post-one", { action: "publish", expectedVersion: saved.version }, site.fetch);
  if (!published.ok) throw new Error(published.message);
  return published.version;
}

function writesTo(site: ReturnType<typeof fakeSite>) {
  return site.requests.filter((r) => !r.startsWith("GET"));
}

describe("PLANT: a non-member reads", () => {
  it("is answered 404, the same as a project that does not exist", async () => {
    const stranger = await viewerFor("stranger@test.invalid");
    expect(await refusal(requireSiteProject(testEnv.DB, stranger, SLUG, "read"))).toBe(404);
    expect(await refusal(requireSiteProject(testEnv.DB, stranger, "no-such-project", "read"))).toBe(404);
  });

  it("is answered 404 for a project that is not a site", async () => {
    await addProject("a-book");
    const owner = await viewerFor("owner@test.invalid");
    expect(await refusal(requireSiteProject(testEnv.DB, owner, "a-book", "read"))).toBe(404);
  });
});

describe("PLANT: a Reader saves", () => {
  it("is refused for autosave and for a save to the site, and the site hears nothing", async () => {
    const site = fakeSite();
    const env = connectedEnv();
    const { viewer, project } = await as("reader@test.invalid");
    expect(await refusal(autosave(env.DB, project, viewer, "post-one", { source: "x", baseVersion: null }))).toBe(403);
    expect(
      await refusal(writeToSite(env, project, viewer, "post-one", { action: "save", source: "x", expectedVersion: null }, site.fetch)),
    ).toBe(403);
    expect(site.requests).toEqual([]);
  });
});

describe("PLANT: an Editor publishes", () => {
  it("is refused for publish, schedule and unpublish before any request", async () => {
    const site = fakeSite();
    const env = connectedEnv();
    const version = await seed(site, env);
    site.requests.length = 0;
    const { viewer, project } = await as("editor@test.invalid");
    for (const request of [
      { action: "publish" as const, expectedVersion: version },
      { action: "schedule" as const, expectedVersion: version, publishAt: "2030-01-01T00:00:00Z" },
      { action: "unpublish" as const, expectedVersion: version },
    ]) {
      expect(await refusal(writeToSite(env, project, viewer, "post-one", request, site.fetch)), request.action).toBe(403);
    }
    expect(site.requests).toEqual([]);
  });

  it("is refused when the change would alter a live post, since that is a publish", async () => {
    const site = fakeSite();
    const env = connectedEnv();
    const version = await seed(site, env, "published");
    site.requests.length = 0;
    const { viewer, project } = await as("editor@test.invalid");
    expect(
      await refusal(writeToSite(env, project, viewer, "post-one", { action: "save", source: "# Changed live\n", expectedVersion: version }, site.fetch)),
    ).toBe(403);
    expect(writesTo(site)).toEqual([]);
    expect(site.adapter.store.get("post-one")!.doc.source).toBe("# One\n");
  });

  it("lets an Editor save a draft, and records who did it", async () => {
    const site = fakeSite();
    const env = connectedEnv();
    const version = await seed(site, env);
    const { viewer, project } = await as("editor@test.invalid");
    const outcome = await writeToSite(env, project, viewer, "post-one", { action: "save", source: "# One, edited\n", expectedVersion: version }, site.fetch);
    expect(outcome).toMatchObject({ ok: true, status: "draft" });
    const change = await testEnv.DB.prepare("SELECT person_id, action, version_before FROM changes WHERE id = ?")
      .bind(outcome.ok ? outcome.changeId : "")
      .first();
    expect(change).toEqual({ person_id: viewer.id, action: "save", version_before: version });
  });
});

describe("PLANT: a stale expectedVersion", () => {
  it("is refused by the site, reported as a conflict, and the person's draft is kept", async () => {
    const site = fakeSite();
    const env = connectedEnv();
    const version = await seed(site, env);
    const { viewer, project } = await as("owner@test.invalid");
    // Someone else moves the post on.
    const moved = await writeToSite(env, project, viewer, "post-one", { action: "save", source: "# Moved\n", expectedVersion: version }, site.fetch);
    expect(moved.ok).toBe(true);

    await autosave(env.DB, project, viewer, "post-one", { source: "# My edit\n", baseVersion: version });
    const stale = await writeToSite(env, project, viewer, "post-one", { action: "save", source: "# My edit\n", expectedVersion: version }, site.fetch);
    expect(stale).toMatchObject({ ok: false, reason: "conflict" });
    expect(site.adapter.store.get("post-one")!.doc.source).toBe("# Moved\n");
    expect((await readDraft(env.DB, project, viewer, "post-one"))?.source).toBe("# My edit\n");
  });

  it("refuses a create over a slug the site already holds", async () => {
    const site = fakeSite();
    const env = connectedEnv();
    await seed(site, env);
    const { viewer, project } = await as("owner@test.invalid");
    const clobber = await writeToSite(env, project, viewer, "post-one", { action: "save", source: "# Clobber\n", expectedVersion: null }, site.fetch);
    expect(clobber).toMatchObject({ ok: false, reason: "conflict" });
  });
});

describe("the Owner's writes", () => {
  it("publish, index the result, record the change, and clear the draft that was sent", async () => {
    const site = fakeSite();
    const env = connectedEnv();
    const version = await seed(site, env);
    const { viewer, project } = await as("owner@test.invalid");
    await autosave(env.DB, project, viewer, "post-one", { source: "# One, final\n", baseVersion: version });
    const outcome = await writeToSite(
      env,
      project,
      viewer,
      "post-one",
      { action: "publish", expectedVersion: version, source: "# One, final\n" },
      site.fetch,
    );
    expect(outcome).toMatchObject({ ok: true, status: "published" });
    expect(site.adapter.store.get("post-one")!.doc.source).toBe("# One, final\n");
    expect(await readDraft(env.DB, project, viewer, "post-one")).toBeNull();
    const indexed = await testEnv.DB.prepare("SELECT status, title FROM site_items WHERE project_id = ? AND item_id = ?")
      .bind(projectId, "post-one")
      .first();
    expect(indexed).toEqual({ status: "published", title: "One, final" });
    const count = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM changes").first<{ n: number }>();
    expect(count!.n).toBe(2);
  });

  it("reports a site that is not connected rather than failing obscurely", async () => {
    const { viewer, project } = await as("owner@test.invalid");
    await expect(
      writeToSite(testEnv, project, viewer, "post-one", { action: "save", source: "x", expectedVersion: null }),
    ).rejects.toThrow(/No SITE_DUSTINEDWARDS_KEY set/);
  });
});
