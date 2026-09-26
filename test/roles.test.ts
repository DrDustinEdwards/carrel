// Planted problems for shared access: a person may do only what their role on a project allows,
// and sees nothing of a project not shared with them.

import { beforeEach, describe, expect, it } from "vitest";

import { findViewer, requireAction, visibleProjects, type Viewer } from "~/lib/people.server";
import { can } from "~/lib/roles";
import { addPerson, addProject, resetDb, share, testEnv } from "./env";

let owner: Viewer;
let reader: Viewer;
let editor: Viewer;
let outsider: Viewer;
let novel: number;
let series: number;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const readerId = await addPerson("reader@test.invalid");
  const editorId = await addPerson("editor@test.invalid");
  await addPerson("outsider@test.invalid");
  novel = await addProject("paluxy-portal");
  series = await addProject("blog-series");
  await share(novel, readerId, "reader");
  await share(novel, editorId, "editor");
  owner = (await findViewer(testEnv.DB, "owner@test.invalid"))!;
  reader = (await findViewer(testEnv.DB, "reader@test.invalid"))!;
  editor = (await findViewer(testEnv.DB, "editor@test.invalid"))!;
  outsider = (await findViewer(testEnv.DB, "outsider@test.invalid"))!;
});

async function status(viewer: Viewer, project: number, action: Parameters<typeof requireAction>[3]) {
  try {
    await requireAction(testEnv.DB, viewer, project, action);
    return 200;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

describe("roles: refusals", () => {
  it("refuses a Reader who saves", async () => {
    expect(await status(reader, novel, "edit")).toBe(403);
  });

  it("refuses an Editor who publishes", async () => {
    expect(await status(editor, novel, "publish")).toBe(403);
  });

  it("refuses an Editor who sends externally or manages people", async () => {
    expect(await status(editor, novel, "send_external")).toBe(403);
    expect(await status(editor, novel, "manage")).toBe(403);
  });

  it("answers 404, not 403, when a non-member reads a project", async () => {
    expect(await status(outsider, novel, "read")).toBe(404);
  });

  it("answers 404 for a shared user on a project not shared with them", async () => {
    expect(await status(reader, series, "read")).toBe(404);
  });

  it("gives nobody a role from nothing", () => {
    expect(can(null, "read")).toBe(false);
  });
});

describe("roles: what is allowed", () => {
  it("lets a Reader read and comment", async () => {
    expect(await status(reader, novel, "read")).toBe(200);
    expect(await status(reader, novel, "comment")).toBe(200);
  });

  it("lets an Editor edit", async () => {
    expect(await status(editor, novel, "edit")).toBe(200);
  });

  it("lets the Owner do everything on every project, shared or not", async () => {
    for (const action of ["read", "comment", "edit", "publish", "send_external", "manage"] as const) {
      expect(await status(owner, series, action)).toBe(200);
    }
  });
});

describe("roles: what each person sees", () => {
  it("shows a shared user only the projects shared with them", async () => {
    expect((await visibleProjects(testEnv.DB, reader)).map((p) => p.slug)).toEqual(["paluxy-portal"]);
    expect(await visibleProjects(testEnv.DB, outsider)).toEqual([]);
  });

  it("shows the Owner every project", async () => {
    expect((await visibleProjects(testEnv.DB, owner)).map((p) => p.slug).sort()).toEqual(["blog-series", "paluxy-portal"]);
  });
});

describe("schema: the Owner cannot be granted twice", () => {
  it("refuses a second Owner row", async () => {
    await expect(addPerson("second@test.invalid", { owner: true })).rejects.toThrow();
  });

  it("refuses 'owner' as a membership role", async () => {
    const id = await addPerson("sneaky@test.invalid");
    await expect(
      testEnv.DB.prepare("INSERT INTO project_members (project_id, person_id, role) VALUES (?, ?, 'owner')")
        .bind(novel, id)
        .run(),
    ).rejects.toThrow();
  });
});
