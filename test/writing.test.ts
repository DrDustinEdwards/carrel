// Writing 1: the status, summary, target and limit header keys; each project's
// status list; the outliner; and daily progress, which counts only typed words. The day, pace and
// streak math and the status list's checks are Capsomer's (writing-progress, label-color-list) and
// tested there.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authorshipRecord,
  refreshBook,
  requireBookProject,
  saveBookFile,
} from "~/lib/books.server";
import { describe as describeFile, readMeta } from "~/lib/novels/layout";
import { parseFile } from "~/lib/novels/frontmatter";
import { clearTokenCache } from "~/lib/novels/repo.server";
import {
  addUntyped,
  progressEntries,
  readGoal,
  saveGoal,
  saveStatusList,
  statusList,
} from "~/lib/writing.server";
import { action as fileAction, loader as fileLoader } from "~/routes/book.file";
import { loader as bookLoader } from "~/routes/book";
import { loader as outlinerLoader } from "~/routes/book.outliner";
import { action as progressAction, loader as progressLoader } from "~/routes/book.progress";
import { action as settingsAction } from "~/routes/book.settings";

import { sharedBook, testEnv } from "./env";
import { fakeNovels, githubStyleKey } from "./novels";
import { viewerFor, routeContext, settle } from "./site";

const SLUG = "test-book";
const HEADER = (status: string, extra = "") =>
  `---\nstatus: ${status}\nsummary: Wade at the gate\ntarget: 2,000\n${extra}pov: Wade\n---\n\n`;
const ONE = "chapters/01-arrival/01-the-gate.md";
const TWO = "chapters/01-arrival/02-supper.md";
const THREE = "chapters/02-the-crossing/01-the-chain.md";

// ---------- pure

describe("the header keys", () => {
  it("reads status, summary, target and limit on a scene, and target and deadline on the title page", () => {
    const scene = readMeta(ONE, parseFile(HEADER("Drafting", "limit: 3_000\n")).data, true);
    expect(scene).toMatchObject({
      kind: "scene",
      header: {
        status: "Drafting",
        summary: "Wade at the gate",
        target: 2000,
        limit: 3000,
        pov: "Wade",
      },
    });
    const book = readMeta(
      "book.md",
      parseFile("---\ntitle: T\ntarget: 90000\ndeadline: 2027-03-01\n---\n").data,
      true,
    );
    expect(book).toMatchObject({ kind: "book", entry: { target: 90000, deadline: "2027-03-01" } });
  });

  it("treats a missing or unreadable target as none, never a guess", () => {
    for (const value of ["", "lots", "-5", "0", "2k", "1.5"]) {
      const meta = readMeta(ONE, parseFile(`---\ntarget: ${value}\n---\n`).data, true);
      expect(meta.kind === "scene" && meta.header.target).toBeNull();
    }
    const book = readMeta("book.md", parseFile("---\ndeadline: next spring\n---\n").data, true);
    expect(book.kind === "book" && book.entry.deadline).toBe("");
  });

  it("does not count the header keys as prose", () => {
    expect(describeFile(ONE, `${HEADER("Idea")}Three words here.\n`).words).toBe(3);
  });
});

// ---------- D1, the save path and the routes

let key: string;
beforeAll(async () => {
  key = (await githubStyleKey()).pkcs1Pem;
});

let gh: ReturnType<typeof fakeNovels>;
let env: Env;

beforeEach(async () => {
  clearTokenCache();
  await sharedBook(SLUG);
  gh = fakeNovels({
    [`${SLUG}/book.md`]: "---\ntitle: T\ntarget: 10000\ndeadline: 2027-01-01\n---\n",
    [`${SLUG}/${ONE}`]: `${HEADER("Drafting")}Wade opened the gate.\n`,
    [`${SLUG}/${TWO}`]: `${HEADER("first draft")}They ate.\n`,
    [`${SLUG}/${THREE}`]: "---\npov: Nell\n---\n\nThe chain.\n",
    [`${SLUG}/chapters/02-the-crossing/02-the-bank.md`]: `${HEADER("Polished")}The bank.\n`,
  });
  vi.stubGlobal("fetch", gh.fetch);
  env = { ...testEnv, NOVELS_APP_ID: "123", NOVELS_APP_PRIVATE_KEY: key };
});

async function as(email: string, action: "read" | "edit" = "read") {
  const viewer = await viewerFor(email);
  return { viewer, project: await requireBookProject(testEnv.DB, viewer, SLUG, action) };
}

const contextFor = (email: string) => routeContext(env, email);

function body(fields: Record<string, string | string[]>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) form.append(k, one);
  return form;
}

const post = async (
  route: (args: never) => Promise<unknown>,
  email: string,
  url: string,
  fields: Record<string, string | string[]>,
  params: Record<string, string>,
) =>
  settle(
    route({
      request: new Request(`https://carrel.test${url}`, { method: "POST", body: body(fields) }),
      params,
      context: await contextFor(email),
    } as never),
  );

async function outliner(email: string, query = "") {
  return settle(
    outlinerLoader({
      request: new Request(`https://carrel.test/b/${SLUG}/outliner${query}`),
      params: { project: SLUG },
      context: await contextFor(email),
    } as never),
  ) as Promise<Awaited<ReturnType<typeof outlinerLoader>>>;
}

async function refresh() {
  const { project } = await as("owner@test.invalid");
  await refreshBook(testEnv.DB, gh.repo, project);
}

describe("typed words on save", () => {
  it("PLANT: counts what was typed, not what was pasted or taken from an AI draft", async () => {
    await refresh();
    const { viewer, project } = await as("editor@test.invalid", "edit");
    const current = gh.files.get(`${SLUG}/${ONE}`)!;
    // Ten words reach the file; four of them were pasted, reported at autosave and at save.
    await addUntyped(testEnv.DB, project.id, viewer.id, ONE, 3);
    const saved = await saveBookFile(testEnv.DB, gh.repo, project, viewer, ONE, {
      source: `${current.source}one two three four five six seven eight nine ten\n`,
      expectedVersion: current.sha,
      untyped: 1,
    });
    expect(saved.ok).toBe(true);
    const row = await testEnv.DB.prepare("SELECT words_added, words_typed FROM authorship").first<{
      words_added: number;
      words_typed: number;
    }>();
    expect(row).toEqual({ words_added: 10, words_typed: 6 });
    // The count is taken by the save, so the next save starts from nothing.
    expect(
      await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM untyped_words").first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("counts nothing for an AI client's save, or a save from a version the index does not hold", async () => {
    await refresh();
    const { viewer, project } = await as("owner@test.invalid", "edit");
    let current = gh.files.get(`${SLUG}/${ONE}`)!;
    await saveBookFile(testEnv.DB, gh.repo, project, viewer, ONE, {
      source: `${current.source}More words.\n`,
      expectedVersion: current.sha,
      client: "Claude",
    });
    current = gh.files.get(`${SLUG}/${TWO}`)!;
    await testEnv.DB.prepare("UPDATE book_files SET sha = 'stale' WHERE path = ?").bind(TWO).run();
    await saveBookFile(testEnv.DB, gh.repo, project, viewer, TWO, {
      source: `${current.source}More words.\n`,
      expectedVersion: current.sha,
    });
    const rows = await testEnv.DB.prepare("SELECT words_typed FROM authorship").all<{
      words_typed: number | null;
    }>();
    expect(rows.results).toEqual([{ words_typed: null }, { words_typed: null }]);
    expect(await progressEntries(testEnv.DB, project, viewer)).toEqual([]);
    expect((await authorshipRecord(testEnv.DB, project)).length).toBe(2);
  });

  it("leaves an AI draft's words out of the day when it is taken as the working copy, and a discard drops them, through the editor's route", async () => {
    await refresh();
    const { viewer, project } = await as("owner@test.invalid", "edit");
    const current = gh.files.get(`${SLUG}/${ONE}`)!;
    const url = `/b/${SLUG}/f/${ONE}`;
    const params = { project: SLUG, "*": ONE };
    await settle(
      fileLoader({
        request: new Request(`https://carrel.test${url}`),
        params,
        context: await contextFor("owner@test.invalid"),
      } as never),
    );
    const ai = await testEnv.DB.prepare(
      "INSERT INTO ai_drafts (project_id, item_id, person_id, client, source, base_version, note) VALUES (?, ?, ?, 'Claude', ?, ?, '') RETURNING id",
    )
      .bind(
        project.id,
        ONE,
        viewer.id,
        `${HEADER("Drafting")}An AI wrote these five words.\n`,
        current.sha,
      )
      .first<{ id: number }>();
    await post(
      fileAction,
      "owner@test.invalid",
      url,
      { intent: "use-ai-draft", confirmed: "1", draft: String(ai!.id) },
      params,
    );
    expect(
      await testEnv.DB.prepare("SELECT words FROM untyped_words").first<{ words: number }>(),
    ).toEqual({ words: 6 });
    await post(
      fileAction,
      "owner@test.invalid",
      url,
      { intent: "discard", confirmed: "1" },
      params,
    );
    expect(
      await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM untyped_words").first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("gives each person their own saves only", async () => {
    await refresh();
    const owner = await as("owner@test.invalid", "edit");
    const editor = await as("editor@test.invalid", "edit");
    const current = gh.files.get(`${SLUG}/${ONE}`)!;
    await saveBookFile(testEnv.DB, gh.repo, editor.project, editor.viewer, ONE, {
      source: `${current.source}Four more words here.\n`,
      expectedVersion: current.sha,
    });
    expect(await progressEntries(testEnv.DB, owner.project, owner.viewer)).toEqual([]);
    expect(await progressEntries(testEnv.DB, editor.project, editor.viewer)).toMatchObject([
      { typed: 4, removed: 0 },
    ]);
  });
});

describe("goals", () => {
  it("PLANT: a Reader cannot set a goal; an Editor sets their own, checked", async () => {
    expect(
      (
        (await post(
          progressAction,
          "reader@test.invalid",
          `/b/${SLUG}/progress`,
          { intent: "goal", mode: "daily", dailyTarget: "500", writingDays: ["1"] },
          { project: SLUG },
        )) as Response
      ).status,
    ).toBe(403);
    const bad = await post(
      progressAction,
      "editor@test.invalid",
      `/b/${SLUG}/progress`,
      { intent: "goal", mode: "daily", dailyTarget: "lots", writingDays: ["1"] },
      { project: SLUG },
    );
    expect(bad).toMatchObject({
      goal: { saved: false, error: expect.stringMatching(/whole number/) },
    });
    const none = await post(
      progressAction,
      "editor@test.invalid",
      `/b/${SLUG}/progress`,
      { intent: "goal", mode: "daily", dailyTarget: "500" },
      { project: SLUG },
    );
    expect(none).toMatchObject({
      goal: { saved: false, error: expect.stringMatching(/writing day/) },
    });
    const ok = await post(
      progressAction,
      "editor@test.invalid",
      `/b/${SLUG}/progress`,
      {
        intent: "goal",
        mode: "deadline",
        dailyTarget: "1,500",
        writingDays: ["1", "3", "5"],
        allowNegative: "1",
      },
      { project: SLUG },
    );
    expect(ok).toMatchObject({ goal: { saved: true } });
    const editor = await as("editor@test.invalid");
    expect(await readGoal(testEnv.DB, editor.project, editor.viewer)).toEqual({
      mode: "deadline",
      dailyTarget: 1500,
      writingDays: [1, 3, 5],
      allowNegative: true,
    });
    const owner = await as("owner@test.invalid");
    expect(await readGoal(testEnv.DB, owner.project, owner.viewer)).toMatchObject({
      mode: "daily",
      dailyTarget: null,
    });
  });

  it("hands the book page the saves, the goal, and the title page's target and deadline", async () => {
    await refresh();
    const { viewer, project } = await as("owner@test.invalid", "edit");
    await saveGoal(testEnv.DB, project, viewer, {
      mode: "daily",
      dailyTarget: "300",
      writingDays: ["0", "6"],
      allowNegative: false,
    });
    const data = (await progressLoader({
      request: new Request(`https://carrel.test/b/${SLUG}/progress`),
      params: { project: SLUG },
      context: await contextFor("owner@test.invalid"),
    } as never)) as Awaited<ReturnType<typeof progressLoader>>;
    expect(data.progress).toMatchObject({
      projectTarget: 10000,
      deadline: "2027-01-01",
      goal: { dailyTarget: 300, writingDays: [0, 6] },
      entries: [],
    });
    const book = (await bookLoader({
      request: new Request(`https://carrel.test/b/${SLUG}`),
      params: { project: SLUG },
      context: await contextFor("owner@test.invalid"),
    } as never)) as Awaited<ReturnType<typeof bookLoader>>;
    expect(book.chapters[0]!.scenes.map((s) => s.status)).toEqual(["Drafting", "first draft"]);
  });
});

describe("the outliner", () => {
  it("lists every scene in reading order with its status, summary and target", async () => {
    await refresh();
    const data = await outliner("reader@test.invalid");
    expect(data.total).toBe(4);
    expect(data.rows.map((r) => [r.path, r.status, r.target])).toEqual([
      [ONE, "Drafting", 2000],
      [TWO, "first draft", 2000],
      [THREE, "", null],
      ["chapters/02-the-crossing/02-the-bank.md", "Polished", 2000],
    ]);
    expect(data.counts).toEqual({ drafting: 1, "first draft": 1, none: 1, other: 1 });
  });

  it("filters by a label ignoring case, by no status, and by a status not on the list", async () => {
    await refresh();
    expect(
      (await outliner("reader@test.invalid", "?status=first+draft")).rows.map((r) => r.path),
    ).toEqual([TWO]);
    expect((await outliner("reader@test.invalid", "?status=none")).rows.map((r) => r.path)).toEqual(
      [THREE],
    );
    expect(
      (await outliner("reader@test.invalid", "?status=other")).rows.map((r) => r.status),
    ).toEqual(["Polished"]);
    expect((await outliner("reader@test.invalid", "?status=final")).rows).toEqual([]);
  });

  it("PLANT: a Reader cannot edit the status list; an Editor replaces it, and the outliner follows", async () => {
    await refresh();
    const url = `/b/${SLUG}/settings`;
    const reader = await post(
      settingsAction,
      "reader@test.invalid",
      url,
      { intent: "labels", label: ["Polished"], color: ["2"] },
      { project: SLUG },
    );
    expect((reader as Response).status).toBe(403);
    const saved = await post(
      settingsAction,
      "editor@test.invalid",
      url,
      { intent: "labels", label: ["Drafting", "Polished", ""], color: ["3", "7", "1"] },
      { project: SLUG },
    );
    expect(saved).toEqual({ saved: true, error: null });
    const { project } = await as("reader@test.invalid");
    expect(await statusList(testEnv.DB, project)).toEqual({
      edited: true,
      labels: [
        { label: "Drafting", color: 3 },
        { label: "Polished", color: 7 },
      ],
    });
    const data = await outliner("reader@test.invalid", "?status=other");
    expect(data.rows.map((r) => r.status)).toEqual(["first draft"]);
    const twice = await saveStatusList(
      testEnv.DB,
      (await as("editor@test.invalid", "edit")).project,
      [
        { label: "A", color: 1 },
        { label: "a", color: 1 },
      ],
    );
    expect(twice.ok).toBe(false);
  });
});
