// Desk's Home, Writing list and header search read across every project the viewer may open, and only
// those: an AI draft is private to its person, a project not shared never appears, and the header's
// count is the sum of the rows Home shows.

import { beforeEach, describe, expect, it } from "vitest";

import { bringBack, needsYou, searchEverything, setLater, writingRows } from "~/lib/desk.server";
import { visibleProjects } from "~/lib/people.server";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { viewerFor } from "./site";

let mine: number;
let theirs: number;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  mine = await addProject("de-info", "dustinedwards");
  theirs = await addProject("germs", "germomics");
  await share(mine, editor, "editor");
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const rows: [number, string, string, string, string | null][] = [
    [mine, "alerts-wait", "Why the monitor waits", "published", null],
    [mine, "due-now", "Due now", "scheduled", past],
    [theirs, "rabies", "Rabies", "draft", null],
    [mine, "heat-block", "heat-block", "published", "no-path"],
  ];
  await testEnv.DB.batch(
    rows.map(([project, id, title, status, at]) =>
      testEnv.DB.prepare(
        "INSERT INTO site_items (project_id, item_id, kind, title, status, path, publish_at, synced_at) VALUES (?, ?, 'post', ?, ?, ?, ?, '2026-11-01T00:00:00Z')",
      ).bind(
        project,
        id,
        title,
        status,
        status === "published" && at === "no-path" ? null : `/blog/${id}`,
        status === "scheduled" ? at : null,
      ),
    ),
  );
  const person = await viewerFor("editor@test.invalid");
  await testEnv.DB.prepare(
    "INSERT INTO ai_drafts (project_id, item_id, person_id, client, source) VALUES (?, 'alerts-wait', ?, 'Claude', 'x')",
  )
    .bind(mine, person.id)
    .run();
});

describe("what Desk lists across projects", () => {
  it("shows each person only their own queue, and the Owner every project", async () => {
    const editor = await viewerFor("editor@test.invalid");
    const owner = await viewerFor("owner@test.invalid");
    const forEditor = await needsYou(testEnv.DB, editor, await visibleProjects(testEnv.DB, editor));
    expect(forEditor.map((n) => n.group).sort()).toEqual(["ai", "due"]);
    expect(forEditor.find((n) => n.group === "due")).toMatchObject({ urgency: "blocking" });
    // The AI draft belongs to the editor: the Owner is not asked to review it.
    const forOwner = await needsYou(testEnv.DB, owner, await visibleProjects(testEnv.DB, owner));
    expect(forOwner.map((n) => n.group)).toEqual(["due"]);
  });

  it("lists posts only from shared sites, leaves data kinds out, and finds by title", async () => {
    const editor = await viewerFor("editor@test.invalid");
    const owner = await viewerFor("owner@test.invalid");
    const seen = await writingRows(testEnv.DB, await visibleProjects(testEnv.DB, editor), {});
    expect(seen.rows.map((r) => r.itemId).sort()).toEqual(["alerts-wait", "due-now"]);
    expect(seen.counts).toMatchObject({ all: 2, published: 1, scheduled: 1 });
    const all = await writingRows(testEnv.DB, await visibleProjects(testEnv.DB, owner), {});
    expect(all.rows.map((r) => r.itemId)).toContain("rabies");
    expect(all.rows.map((r) => r.itemId)).not.toContain("heat-block");
    const found = await searchEverything(
      testEnv.DB,
      await visibleProjects(testEnv.DB, owner),
      "rabies",
    );
    expect(found).toMatchObject([{ label: "Rabies", group: "Posts", hint: "germs" }]);
  });

  it("keeps a row set for later off the queue until it changes or is brought back", async () => {
    const editor = await viewerFor("editor@test.invalid");
    const visible = await visibleProjects(testEnv.DB, editor);
    const ai = (await needsYou(testEnv.DB, editor, visible)).find((n) => n.group === "ai")!;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    await setLater(testEnv.DB, editor, ai, tomorrow);
    expect((await needsYou(testEnv.DB, editor, visible)).filter((n) => !n.later)).toHaveLength(1);
    // A second draft changes the row ("2 AI drafts"), so it is back before tomorrow.
    await testEnv.DB.prepare(
      "INSERT INTO ai_drafts (project_id, item_id, person_id, client, source) VALUES (?, 'due-now', ?, 'Claude', 'x')",
    )
      .bind(mine, editor.id)
      .run();
    expect((await needsYou(testEnv.DB, editor, visible)).filter((n) => !n.later)).toHaveLength(2);
    const two = (await needsYou(testEnv.DB, editor, visible)).find((n) => n.group === "ai")!;
    await setLater(testEnv.DB, editor, two, tomorrow);
    await bringBack(testEnv.DB, editor, two.id);
    expect((await needsYou(testEnv.DB, editor, visible)).every((n) => !n.later)).toBe(true);
  });
});
