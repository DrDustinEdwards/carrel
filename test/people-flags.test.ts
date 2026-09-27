// The people page, the project flags list and media in the authorship record (job_11a70a5353a3).
// Each refusal the job names is planted, and each checks that nothing changed.

import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { deleteMedia, uploadMedia } from "~/lib/media.server";
import { addPerson as adminAddPerson, listPeople, PeopleRefusal, setDisabled, setProjectRole } from "~/lib/people-admin.server";
import { findViewer } from "~/lib/people.server";
import { requireSiteProject } from "~/lib/projects.server";
import { action as peopleAction, loader as peopleLoader } from "~/routes/people";
import { action as flagsAction, loader as flagsLoader } from "~/routes/project.flags";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const SLUG = "de-info";
let projectId: number;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const reader = await addPerson("reader@test.invalid");
  const reviewer = await addPerson("reviewer@test.invalid", { reviewer: true });
  await addPerson("stranger@test.invalid");
  projectId = await addProject(SLUG, "dustinedwards");
  await share(projectId, editor, "editor");
  await share(projectId, reader, "reader");
  await share(projectId, reviewer, "reader");
});

async function contextFor(email: string, env: Env = testEnv) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
  context.set(viewerContext, await viewerFor(email));
  context.set(nonceContext, "n");
  return context;
}

async function status(run: () => Promise<unknown>): Promise<number> {
  try {
    await run();
    return 200;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

/** Every people and membership row, to prove a refusal changed nothing. */
async function snapshot() {
  const [p, m] = await Promise.all([
    testEnv.DB.prepare("SELECT id, email, is_owner, is_reviewer, disabled_at FROM people ORDER BY id").all(),
    testEnv.DB.prepare("SELECT project_id, person_id, role FROM project_members ORDER BY project_id, person_id").all(),
  ]);
  return JSON.stringify([p.results, m.results]);
}

function form(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request("https://carrel.test/people", { method: "POST", body });
}

async function personId(email: string) {
  return (await testEnv.DB.prepare("SELECT id FROM people WHERE email = ?").bind(email).first<{ id: number }>())!.id;
}

describe("the people page", () => {
  it("lists everyone with their kind and their role on each project, the Owner first", async () => {
    const data = await listPeople(testEnv.DB, await viewerFor("owner@test.invalid"));
    expect(data.people[0]).toMatchObject({ email: "owner@test.invalid", isOwner: true });
    expect(data.people.find((p) => p.email === "editor@test.invalid")).toMatchObject({ roles: [{ projectId, role: "editor" }] });
    expect(data.people.find((p) => p.email === "reviewer@test.invalid")).toMatchObject({ isReviewer: true, roles: [{ role: "reader" }] });
    expect(data.projects).toEqual([{ id: projectId, slug: SLUG, name: SLUG, kind: "site" }]);
  });

  it("adds a person, shares a project with them, changes and removes the role, disables and enables them", async () => {
    const context = await contextFor("owner@test.invalid");
    expect(await peopleAction({ request: form({ intent: "add", email: " Wife@Test.Invalid ", name: "Wife", reviewer: "no" }), params: {}, context } as never)).toEqual({
      ok: true,
      intent: "add",
      added: "wife@test.invalid",
    });
    const id = await personId("wife@test.invalid");
    await peopleAction({ request: form({ intent: "role", person: String(id), project: String(projectId), role: "reader" }), params: {}, context } as never);
    await peopleAction({ request: form({ intent: "role", person: String(id), project: String(projectId), role: "editor" }), params: {}, context } as never);
    expect(await testEnv.DB.prepare("SELECT role FROM project_members WHERE person_id = ?").bind(id).first()).toEqual({ role: "editor" });
    await peopleAction({ request: form({ intent: "role", person: String(id), project: String(projectId), role: "" }), params: {}, context } as never);
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM project_members WHERE person_id = ?").bind(id).first()).toEqual({ n: 0 });

    await peopleAction({ request: form({ intent: "disable", person: String(id) }), params: {}, context } as never);
    // Disabled means refused at both doors, since every request looks the person up again.
    expect(await findViewer(testEnv.DB, "wife@test.invalid")).toBeNull();
    await peopleAction({ request: form({ intent: "enable", person: String(id) }), params: {}, context } as never);
    expect(await findViewer(testEnv.DB, "wife@test.invalid")).toMatchObject({ email: "wife@test.invalid" });
  });

  it("refuses an email already in Carrel, and one that is not an email", async () => {
    const owner = await viewerFor("owner@test.invalid");
    const before = await snapshot();
    await expect(adminAddPerson(testEnv.DB, owner, { email: "EDITOR@test.invalid", name: "", reviewer: false })).rejects.toBeInstanceOf(PeopleRefusal);
    await expect(adminAddPerson(testEnv.DB, owner, { email: "not an email", name: "", reviewer: false })).rejects.toBeInstanceOf(PeopleRefusal);
    expect(await snapshot()).toBe(before);
  });
});

describe("PLANT: a non-Owner at the people page", () => {
  for (const email of ["editor@test.invalid", "reader@test.invalid", "reviewer@test.invalid", "stranger@test.invalid"]) {
    it(`answers ${email} 404 for the page and every action, and nothing changes`, async () => {
      const before = await snapshot();
      const context = await contextFor(email);
      const target = String(await personId("reader@test.invalid"));
      expect(await status(() => peopleLoader({ request: new Request("https://carrel.test/people"), params: {}, context } as never))).toBe(404);
      for (const fields of <Record<string, string>[]>[
        { intent: "add", email: "new@test.invalid", name: "", reviewer: "no" },
        { intent: "role", person: target, project: String(projectId), role: "editor" },
        { intent: "disable", person: target },
      ]) {
        expect(await status(() => peopleAction({ request: form(fields), params: {}, context } as never)), fields.intent).toBe(404);
      }
      expect(await snapshot()).toBe(before);
    });
  }
});

describe("PLANT: the Owner's own row", () => {
  it("refuses a second Owner: the page has no way to make one, and the database refuses one too", async () => {
    const context = await contextFor("owner@test.invalid");
    // Even a forged form field cannot make an Owner: addPerson has no such input.
    await peopleAction({ request: form({ intent: "add", email: "second@test.invalid", name: "", reviewer: "no", owner: "yes", is_owner: "1" }), params: {}, context } as never);
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM people WHERE is_owner = 1").first()).toEqual({ n: 1 });
    await expect(testEnv.DB.prepare("UPDATE people SET is_owner = 1 WHERE email = 'second@test.invalid'").run()).rejects.toThrow(/UNIQUE/);
  });

  it("refuses the Owner disabling themself, and changing the Owner's role, and nothing changes", async () => {
    const owner = await viewerFor("owner@test.invalid");
    const before = await snapshot();
    await expect(setDisabled(testEnv.DB, owner, owner.id, true)).rejects.toThrow("The Owner cannot be disabled.");
    await expect(setProjectRole(testEnv.DB, owner, owner.id, projectId, "reader")).rejects.toThrow(/Owner's role cannot be changed/);
    const answer = await peopleAction({ request: form({ intent: "disable", person: String(owner.id) }), params: {}, context: await contextFor("owner@test.invalid") } as never);
    expect(answer).toEqual({ ok: false, intent: "disable", message: "The Owner cannot be disabled." });
    expect(await snapshot()).toBe(before);
  });
});

describe("PLANT: a reviewer given the Editor role", () => {
  it("is refused (reviewers read and flag only), and nothing changes; Reader is allowed", async () => {
    const owner = await viewerFor("owner@test.invalid");
    const reviewer = await personId("reviewer@test.invalid");
    await setProjectRole(testEnv.DB, owner, reviewer, projectId, null);
    const before = await snapshot();
    await expect(setProjectRole(testEnv.DB, owner, reviewer, projectId, "editor")).rejects.toThrow(/Reviewers read and flag only/);
    expect(await snapshot()).toBe(before);
    await setProjectRole(testEnv.DB, owner, reviewer, projectId, "reader");
    expect(await testEnv.DB.prepare("SELECT role FROM project_members WHERE person_id = ?").bind(reviewer).first()).toEqual({ role: "reader" });
  });
});

// ---------- the project flags list

async function flag(path: string, message: string, check = "ai") {
  const row = await testEnv.DB.prepare("INSERT INTO findings (project_id, path, check_name, message, fingerprint) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .bind(projectId, path, check, message, `${path}:${message}`)
    .first<{ id: number }>();
  return row!.id;
}

async function indexed(itemId: string, title: string) {
  await testEnv.DB.prepare("INSERT INTO site_items (project_id, item_id, kind, title, status, synced_at) VALUES (?, ?, 'post', ?, 'draft', '2026-09-27T00:00:00Z')")
    .bind(projectId, itemId, title)
    .run();
}

function dismissForm(id: number, item: string) {
  const body = new FormData();
  body.set("intent", "dismiss");
  body.set("flag", String(id));
  body.set("item", item);
  return new Request(`https://carrel.test/p/${SLUG}/flags`, { method: "POST", body });
}

describe("the project flags list", () => {
  it("lists every flag, open first, including one on an item the site does not have", async () => {
    await indexed("real-post", "A real post");
    const proof = await flag("carrel-mcp-proof", "Proof flag (from Claude Code)");
    const real = await flag("real-post", "A claim with no source (from Grok Build)", "review");
    const owner = await viewerFor("owner@test.invalid");
    await (await import("~/lib/ai.server")).dismissItemFinding(testEnv.DB, await requireSiteProject(testEnv.DB, owner, SLUG, "publish"), owner, "real-post", real);
    const data = (await flagsLoader({ params: { project: SLUG }, context: await contextFor("reader@test.invalid") } as never)) as { canDismiss: boolean; flags: { id: number; onSite: boolean; status: string; title: string | null }[] };
    expect(data.canDismiss).toBe(false);
    expect(data.flags.map((f) => [f.id, f.status, f.onSite, f.title])).toEqual([
      [proof, "open", false, null],
      [real, "dismissed", true, "A real post"],
    ]);
  });

  it("lets the Owner dismiss a flag on an item the site does not have, recorded as the editor records it, and it stays dismissed", async () => {
    const proof = await flag("carrel-mcp-proof", "Proof flag (from Claude)");
    const owner = await viewerFor("owner@test.invalid");
    expect(await flagsAction({ request: dismissForm(proof, "carrel-mcp-proof"), params: { project: SLUG }, context: await contextFor("owner@test.invalid") } as never)).toEqual({ dismissed: proof });
    const row = await testEnv.DB.prepare("SELECT status, dismissed_by, dismissed_at FROM findings WHERE id = ?").bind(proof).first<{ status: string; dismissed_by: number; dismissed_at: string }>();
    expect(row).toMatchObject({ status: "dismissed", dismissed_by: owner.id });
    expect(row!.dismissed_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const again = (await flagsLoader({ params: { project: SLUG }, context: await contextFor("owner@test.invalid") } as never)) as { flags: { id: number; status: string }[] };
    expect(again.flags).toEqual([expect.objectContaining({ id: proof, status: "dismissed" })]);
  });

  it("PLANT: an Editor or a Reader cannot dismiss, a stranger sees nothing, and the flag stays open", async () => {
    const proof = await flag("carrel-mcp-proof", "Proof flag");
    for (const [email, code] of [["editor@test.invalid", 403], ["reader@test.invalid", 403], ["stranger@test.invalid", 404]] as const) {
      expect(await status(async () => flagsAction({ request: dismissForm(proof, "carrel-mcp-proof"), params: { project: SLUG }, context: await contextFor(email) } as never)), email).toBe(code);
    }
    expect(await status(async () => flagsLoader({ params: { project: SLUG }, context: await contextFor("stranger@test.invalid") } as never))).toBe(404);
    expect(await testEnv.DB.prepare("SELECT status, dismissed_by FROM findings WHERE id = ?").bind(proof).first()).toEqual({ status: "open", dismissed_by: null });
  });

  // Two layers refuse a non-Owner: the route (by role, before it reads the form) and the dismiss
  // function itself. Each is tested on its own, so removing either one is seen.
  it("PLANT: the route refuses a non-Owner by role before it reads the form", async () => {
    const empty = new Request(`https://carrel.test/p/${SLUG}/flags`, { method: "POST", body: new FormData() });
    // With the role check, 403. Without it, the missing fields would answer 400 instead.
    expect(await status(async () => flagsAction({ request: empty, params: { project: SLUG }, context: await contextFor("editor@test.invalid") } as never))).toBe(403);
  });

  it("PLANT: the dismiss function refuses a non-Owner on its own, whatever route calls it", async () => {
    const proof = await flag("carrel-mcp-proof", "Proof flag");
    const editor = await viewerFor("editor@test.invalid");
    const { dismissItemFinding } = await import("~/lib/ai.server");
    const project = await requireSiteProject(testEnv.DB, editor, SLUG, "read");
    expect(await status(() => dismissItemFinding(testEnv.DB, project, editor, "carrel-mcp-proof", proof))).toBe(403);
    expect(await testEnv.DB.prepare("SELECT status FROM findings WHERE id = ?").bind(proof).first()).toEqual({ status: "open" });
  });

  it("refuses a flag named with the wrong item, so a form cannot dismiss another item's flag", async () => {
    const proof = await flag("carrel-mcp-proof", "Proof flag");
    expect(await status(async () => flagsAction({ request: dismissForm(proof, "some-other-item"), params: { project: SLUG }, context: await contextFor("owner@test.invalid") } as never))).toBe(404);
    expect(await testEnv.DB.prepare("SELECT status FROM findings WHERE id = ?").bind(proof).first()).toEqual({ status: "open" });
  });
});

// ---------- media in the authorship record

const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

describe("media in the authorship record", () => {
  let site: ReturnType<typeof fakeSite>;
  let env: Env;

  beforeEach(() => {
    site = fakeSite();
    env = connectedEnv();
    vi.stubGlobal("fetch", site.fetch);
  });

  const rows = () => testEnv.DB.prepare("SELECT id, item_id, person_id, action, version_before, version_after, client FROM changes ORDER BY created_at").all().then((r) => r.results);
  const file = (bytes: Uint8Array, name = "river.png", type = "image/png") => ({ name, type, size: bytes.byteLength, bytes: async () => bytes.slice().buffer });

  it("writes exactly one row for an upload and one for a delete, crediting the person and an AI client", async () => {
    const editor = await viewerFor("editor@test.invalid");
    const up = await uploadMedia(env, await requireSiteProject(env.DB, editor, SLUG, "edit"), { viewer: editor, client: "Claude Code" }, file(PNG), "The river");
    expect(up.ok).toBe(true);
    const id = up.ok ? up.item.id : "";
    expect(await rows()).toEqual([{ id: expect.any(String), item_id: id, person_id: editor.id, action: "media-upload", version_before: null, version_after: null, client: "Claude Code" }]);

    const owner = await viewerFor("owner@test.invalid");
    expect(await deleteMedia(env, await requireSiteProject(env.DB, owner, SLUG, "delete_media"), { viewer: owner }, id)).toEqual({ ok: true });
    expect((await rows()).map((r) => [r.action, r.item_id, r.person_id, r.client])).toEqual([
      ["media-upload", id, editor.id, "Claude Code"],
      ["media-delete", id, owner.id, null],
    ]);
  });

  it("PLANT: a refused delete, a refused upload and a role refusal write no row", async () => {
    const owner = await viewerFor("owner@test.invalid");
    const item = await site.adapter.media!.upload({ bytes: PNG, contentType: "image/png", filename: "cover.png", alt: "", changeId: "seed" });
    await site.adapter.content.saveDraft("river-post", { source: `# The river\n\n![](${item.url})\n`, expectedVersion: null, changeId: "c1" });
    const project = await requireSiteProject(env.DB, owner, SLUG, "delete_media");
    expect(await deleteMedia(env, project, { viewer: owner }, item.id)).toMatchObject({ ok: false, usedBy: [{ id: "river-post" }] });
    expect(await uploadMedia(env, project, { viewer: owner }, file(new TextEncoder().encode("<p>x</p>"), "x.html", "text/html"), "")).toMatchObject({ ok: false });
    const reader = await viewerFor("reader@test.invalid");
    expect(await status(async () => uploadMedia(env, await requireSiteProject(env.DB, reader, SLUG, "read"), { viewer: reader }, file(PNG), ""))).toBe(403);
    expect(await rows()).toEqual([]);
  });

  it("still requires a version for every content write (migration 0007 keeps that rule)", async () => {
    const owner = await personId("owner@test.invalid");
    await expect(
      testEnv.DB.prepare("INSERT INTO changes (id, project_id, item_id, person_id, action, version_after) VALUES ('x', ?, 'post', ?, 'save', NULL)").bind(projectId, owner).run(),
    ).rejects.toThrow(/CHECK/);
    await testEnv.DB.prepare("INSERT INTO changes (id, project_id, item_id, person_id, action, version_after) VALUES ('y', ?, 'post', ?, 'save', 'v1')").bind(projectId, owner).run();
  });
});
