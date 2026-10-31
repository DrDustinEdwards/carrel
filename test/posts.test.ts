// The posts list, through the content kit and Capsomer's PostsList. The kit's own rules (intents,
// versions, Undo) are tested in site-api; these are Carrel's: its roles as the kit reads them, the
// authorship record of every write and the index that follows it, and an Author who keeps a post
// through a rename. Planted: a Reader who posts an intent.

import { memoryAdapter } from "@dustinedwards/site-api/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mayPublishItem, writeToSite } from "~/lib/content.server";
import { searchItems } from "~/lib/index.server";
import { requireSiteProject } from "~/lib/projects.server";
import { action as projectAction } from "~/routes/project";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, routeContext, viewerFor } from "./site";

const SLUG = "de-info";
let site: ReturnType<typeof fakeSite<ReturnType<typeof memoryAdapter>>>;
let env: Env;
let projectId: number;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const author = await addPerson("author@test.invalid");
  const reader = await addPerson("reader@test.invalid");
  projectId = await addProject(SLUG, "dustinedwards");
  await share(projectId, author, "author");
  await share(projectId, reader, "reader");
  site = fakeSite();
  env = connectedEnv();
  vi.stubGlobal("fetch", site.fetch);
});

const writes = () => site.requests.filter((r) => !r.startsWith("GET"));
const record = () =>
  testEnv.DB.prepare("SELECT item_id AS itemId, action, version_before AS before, version_after AS after, renamed_from AS renamedFrom FROM changes ORDER BY created_at, rowid").all().then((r) => r.results);

/** A draft the Author wrote in Carrel, so the authorship record names them. */
async function draft(id: string) {
  const viewer = await viewerFor("author@test.invalid");
  const project = await requireSiteProject(env.DB, viewer, SLUG, "edit");
  const saved = await writeToSite(env, project, viewer, id, { action: "save", source: `---\ntitle: "${id}"\n---\n\nText.\n`, expectedVersion: null });
  if (!saved.ok) throw new Error(saved.message);
  return saved.version;
}

/** Posts the list's form with no script, as `email`. */
async function post(email: string, fields: Record<string, string | string[]>) {
  const body = new URLSearchParams(Object.entries(fields).flatMap(([k, v]) => [v].flat().map((one) => [k, one])));
  const context = await routeContext(env, email);
  return projectAction({ request: new Request(`https://carrel.test/p/${SLUG}`, { method: "POST", body }), params: { project: SLUG }, context } as never);
}

describe("the posts list's writes", () => {
  it("records a move to the Trash and its Undo with their versions, and the index follows", async () => {
    const version = await draft("old-notes");
    const trashed = await post("author@test.invalid", { intent: "trash", ids: "old-notes", versions: version });
    expect(trashed).toMatchObject({ ok: true, undo: { intent: "restore" } });
    expect(await searchItems(env.DB, projectId, {})).toEqual([]);

    const undo = "undo" in trashed ? trashed.undo! : null;
    expect(await post("author@test.invalid", { intent: undo!.intent, ...undo!.fields })).toMatchObject({ ok: true });
    expect((await searchItems(env.DB, projectId, {})).map((i) => i.itemId)).toEqual(["old-notes"]);

    const [created, toTrash, back] = (await record()) as Array<{ itemId: string; action: string; before: string | null; after: string | null }>;
    expect(created).toMatchObject({ action: "save", before: null });
    expect(toTrash).toMatchObject({ itemId: "old-notes", action: "content-trash", before: version });
    expect(back).toMatchObject({ itemId: "old-notes", action: "content-restore", before: toTrash!.after });
  });

  it("names the posts that link here before a trash, where the site says (site-api v0.19.0), and credits the person on every write", async () => {
    // TODO site-api 0.19: the fake site answers `backlinks` and the backlinks route itself.
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/content/old-notes/backlinks")) return Response.json({ items: [{ id: "spring", title: "Spring notes", path: "/writing/spring" }] });
      if (request.method !== "GET" && request.headers.get("content-type") === "application/json") bodies.push(await request.clone().json());
      const answer = await site.fetch(request);
      if (!path.endsWith("/meta")) return answer;
      const meta = (await answer.json()) as { capabilities: object };
      return Response.json({ ...meta, capabilities: { ...meta.capabilities, backlinks: true } });
    });
    const version = await draft("old-notes");
    const asked = await post("author@test.invalid", { intent: "trash", ids: "old-notes", versions: version });
    expect(asked).toMatchObject({ ok: false, confirm: { intent: "trash", lead: "1 other post links to this post: \u201cSpring notes\u201d (/writing/spring). Its link would lead nowhere while it is in the Trash.", fields: { backlinks: "seen" } } });
    expect(writes().filter((w) => w.includes("/trash"))).toEqual([]);
    expect(await post("author@test.invalid", { intent: "trash", ids: "old-notes", versions: version, backlinks: "seen" })).toMatchObject({ ok: true });
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies.every((b) => (b as { actor?: { name: string } }).actor?.name === "author")).toBe(true);
  });

  it("keeps the Author of a renamed draft, so they still publish it", async () => {
    const version = await draft("first-name");
    expect(await post("author@test.invalid", { intent: "rename", ids: "first-name", versions: version, newId: "second-name" })).toMatchObject({ ok: true });
    expect((await record()).at(-1)).toMatchObject({ itemId: "second-name", action: "content-rename", renamedFrom: "first-name" });
    const viewer = await viewerFor("author@test.invalid");
    expect(await mayPublishItem(env.DB, { id: projectId, role: "author" }, viewer, "second-name")).toBe(true);
  });

  it("PLANT: refuses every intent a Reader posts, and the site and the record do not move", async () => {
    const version = await draft("kept");
    const before = writes().length;
    for (const intent of ["trash", "tag-add", "duplicate", "rename", "unpublish", "delete"]) {
      expect(await post("reader@test.invalid", { intent, ids: "kept", versions: version, tag: "x", newId: "taken" }), intent).toMatchObject({ ok: false });
    }
    expect(writes().length).toBe(before);
    expect(await record()).toHaveLength(1);
  });
});
