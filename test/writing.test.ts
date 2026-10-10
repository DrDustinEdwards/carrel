// Writing 1 (job_50786e609b88): the status, summary, target and limit header keys; each project's
// status list; the outliner; and daily progress, which counts only typed words, by the local day,
// with deletions held at zero unless the goal allows otherwise, a target by hand or from a deadline
// over the chosen writing days, and streaks.

import { RouterContextProvider } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { authorshipRecord, refreshBook, requireBookProject, saveBookFile } from "~/lib/books.server";
import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { describe as describeFile, readMeta } from "~/lib/novels/layout";
import { parseFile } from "~/lib/novels/frontmatter";
import { clearTokenCache } from "~/lib/novels/repo.server";
import { addUntyped, progressEntries, readGoal, saveGoal, saveStatusList, statusList } from "~/lib/writing.server";
import { dayKey, dayTotals, pace, recentDays, streak, targetFor, writingDaysBetween, type Goal } from "~/lib/writing/progress";
import { cleanLabels, labelFor, STARTING_STATUSES } from "~/lib/writing/status";
import { action as bookAction, loader as bookLoader } from "~/routes/book";
import { action as fileAction } from "~/routes/book.file";
import { action as outlinerAction, loader as outlinerLoader } from "~/routes/book.outliner";

import { addBook, addPerson, resetDb, share, testEnv } from "./env";
import { fakeNovels, githubStyleKey } from "./novels";
import { viewerFor } from "./site";

const SLUG = "test-book";
const HEADER = (status: string, extra = "") => `---\nstatus: ${status}\nsummary: Wade at the gate\ntarget: 2,000\n${extra}pov: Wade\n---\n\n`;
const ONE = "chapters/01-arrival/01-the-gate.md";
const TWO = "chapters/01-arrival/02-supper.md";
const THREE = "chapters/02-the-crossing/01-the-chain.md";

// ---------- pure

describe("the header keys", () => {
  it("reads status, summary, target and limit on a scene, and target and deadline on the title page", () => {
    const scene = readMeta(ONE, parseFile(HEADER("Drafting", "limit: 3_000\n")).data, true);
    expect(scene).toMatchObject({ kind: "scene", header: { status: "Drafting", summary: "Wade at the gate", target: 2000, limit: 3000, pov: "Wade" } });
    const book = readMeta("book.md", parseFile("---\ntitle: T\ntarget: 90000\ndeadline: 2027-03-01\n---\n").data, true);
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

describe("status lists", () => {
  it("starts each kind from the ruling's list", () => {
    expect(STARTING_STATUSES.book.map((l) => l.label)).toEqual(["Idea", "Outlined", "Drafting", "First draft", "Revised", "Final"]);
    expect(STARTING_STATUSES.blog.map((l) => l.label)).toEqual(["Idea", "Drafting", "Ready", "Scheduled"]);
    expect(STARTING_STATUSES.manuscript.map((l) => l.label)).toEqual(["Drafting", "Draft done", "With coauthors", "Revising", "Final"]);
    expect(STARTING_STATUSES.script.map((l) => l.label)).toEqual(["Idea", "Outlined", "Drafting", "Revised", "Locked"]);
  });

  it("matches a status ignoring case, and an unknown one to nothing", () => {
    expect(labelFor(STARTING_STATUSES.book, "first DRAFT")?.label).toBe("First draft");
    expect(labelFor(STARTING_STATUSES.book, "Polished")).toBeNull();
    expect(labelFor(STARTING_STATUSES.book, "  ")).toBeNull();
  });

  it("PLANT: refuses a list with a label twice, or none at all, and drops blank rows", () => {
    expect(cleanLabels([{ label: "Idea", color: 1 }, { label: "idea", color: 2 }])).toMatchObject({ ok: false });
    expect(cleanLabels([{ label: " ", color: 1 }])).toMatchObject({ ok: false });
    expect(cleanLabels([{ label: " Idea ", color: "9" }, { label: "", color: 2 }, { label: "Done", color: "4" }])).toEqual({
      ok: true,
      labels: [
        { label: "Idea", color: 1 },
        { label: "Done", color: 4 },
      ],
    });
  });
});

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS_ONLY = [1, 2, 3, 4, 5];

describe("the local day", () => {
  it("puts a save on the calendar day of the device's zone, resetting at local midnight", () => {
    // 04:30 UTC on 10 October is still 9 October in Chicago and already 10 October in Tokyo.
    expect(dayKey("2026-10-10T04:30:00Z", "America/Chicago")).toBe("2026-10-09");
    expect(dayKey("2026-10-10T04:30:00Z", "UTC")).toBe("2026-10-10");
    expect(dayKey("2026-10-09T15:30:00Z", "Asia/Tokyo")).toBe("2026-10-10");
    const entries = [
      { at: "2026-10-10T04:30:00Z", typed: 100, removed: 0 },
      { at: "2026-10-10T05:30:00Z", typed: 50, removed: 0 },
    ];
    expect([...dayTotals(entries, "America/Chicago", false)]).toEqual([
      ["2026-10-09", 100],
      ["2026-10-10", 50],
    ]);
  });

  it("PLANT: deletions take a day down but not below zero, unless the goal allows it", () => {
    const entries = [{ at: "2026-10-10T12:00:00Z", typed: 40, removed: 100 }];
    expect(dayTotals(entries, "UTC", false).get("2026-10-10")).toBe(0);
    expect(dayTotals(entries, "UTC", true).get("2026-10-10")).toBe(-60);
    expect(dayTotals([{ at: "2026-10-10T12:00:00Z", typed: 400, removed: 100 }], "UTC", false).get("2026-10-10")).toBe(300);
  });
});

describe("targets and pace", () => {
  const goal = (g: Partial<Goal>): Goal => ({ mode: "daily", dailyTarget: 500, writingDays: EVERY_DAY, allowNegative: false, ...g });

  it("counts only the chosen writing days between today and the deadline", () => {
    // Saturday 10 October to Friday 16 October 2026: five weekdays.
    expect(writingDaysBetween("2026-10-10", "2026-10-16", WEEKDAYS_ONLY)).toBe(5);
    expect(writingDaysBetween("2026-10-10", "2026-10-16", EVERY_DAY)).toBe(7);
  });

  it("spreads what was left this morning over the writing days to the deadline, and holds still while you write", () => {
    const base = { projectTarget: 10_000, deadline: "2026-10-16", today: "2026-10-12", writingDays: WEEKDAYS_ONLY };
    // Monday to Friday is five writing days; 7,500 words were written before today.
    expect(pace({ ...base, wordsNow: 7_500, wordsToday: 0 })).toEqual({ ok: true, perDay: 500, remaining: 2_500, days: 5 });
    expect(pace({ ...base, wordsNow: 7_800, wordsToday: 300 })).toEqual({ ok: true, perDay: 500, remaining: 2_500, days: 5 });
    expect(pace({ ...base, deadline: "2026-10-01", wordsNow: 0, wordsToday: 0 })).toEqual({ ok: false, reason: "past" });
    expect(pace({ ...base, projectTarget: null, wordsNow: 0, wordsToday: 0 })).toEqual({ ok: false, reason: "no-target" });
    expect(pace({ ...base, wordsNow: 10_000, wordsToday: 0 })).toEqual({ ok: false, reason: "done" });
  });

  it("has no target on a day off, by hand or from the deadline", () => {
    const saturday = "2026-10-10";
    expect(targetFor(goal({ writingDays: WEEKDAYS_ONLY }), saturday, { ok: false, reason: "no-target" })).toBeNull();
    expect(targetFor(goal({}), saturday, { ok: false, reason: "no-target" })).toBe(500);
    expect(targetFor(goal({ mode: "deadline" }), saturday, { ok: true, perDay: 321, remaining: 1, days: 1 })).toBe(321);
    expect(targetFor(goal({ mode: "deadline" }), saturday, { ok: false, reason: "no-deadline" })).toBeNull();
  });
});

describe("streaks", () => {
  const totals = (days: Record<string, number>) => new Map(Object.entries(days));

  it("counts days in a row at the target, and today does not break it before it is met", () => {
    const t = totals({ "2026-10-07": 600, "2026-10-08": 500, "2026-10-09": 700, "2026-10-10": 100 });
    expect(streak(t, "2026-10-10", 500, EVERY_DAY)).toBe(3);
    expect(streak(totals({ ...Object.fromEntries(t), "2026-10-10": 500 }), "2026-10-10", 500, EVERY_DAY)).toBe(4);
  });

  it("PLANT: a missed writing day ends the run; a day off does not", () => {
    // Friday 9 met, Saturday 10 and Sunday 11 off, Monday 12 met.
    const t = totals({ "2026-10-08": 0, "2026-10-09": 500, "2026-10-12": 500 });
    expect(streak(t, "2026-10-12", 500, WEEKDAYS_ONLY)).toBe(2);
    expect(streak(t, "2026-10-12", 500, EVERY_DAY)).toBe(1);
    expect(streak(t, "2026-10-12", null, EVERY_DAY)).toBe(0);
  });

  it("lists the last days newest first, with days off marked", () => {
    const days = recentDays(totals({ "2026-10-12": 300 }), "2026-10-12", 3, WEEKDAYS_ONLY);
    expect(days).toEqual([
      { day: "2026-10-12", words: 300, writingDay: true },
      { day: "2026-10-11", words: 0, writingDay: false },
      { day: "2026-10-10", words: 0, writingDay: false },
    ]);
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
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const reader = await addPerson("reader@test.invalid");
  const id = await addBook(SLUG);
  await share(id, editor, "editor");
  await share(id, reader, "reader");
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

async function contextFor(email: string) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
  context.set(viewerContext, await viewerFor(email));
  context.set(nonceContext, "test-nonce");
  return context;
}

async function settle<T>(p: Promise<T>): Promise<T | Response> {
  try {
    return await p;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

function body(fields: Record<string, string | string[]>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) form.append(k, one);
  return form;
}

const post = async (route: (args: never) => Promise<unknown>, email: string, url: string, fields: Record<string, string | string[]>, params: Record<string, string>) =>
  settle(route({ request: new Request(`https://carrel.test${url}`, { method: "POST", body: body(fields) }), params, context: await contextFor(email) } as never));

async function outliner(email: string, query = "") {
  return settle(outlinerLoader({ request: new Request(`https://carrel.test/b/${SLUG}/outliner${query}`), params: { project: SLUG }, context: await contextFor(email) } as never)) as Promise<
    Awaited<ReturnType<typeof outlinerLoader>>
  >;
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
    const row = await testEnv.DB.prepare("SELECT words_added, words_typed FROM authorship").first<{ words_added: number; words_typed: number }>();
    expect(row).toEqual({ words_added: 10, words_typed: 6 });
    // The count is taken by the save, so the next save starts from nothing.
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM untyped_words").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("counts nothing for an AI client's save, or a save from a version the index does not hold", async () => {
    await refresh();
    const { viewer, project } = await as("owner@test.invalid", "edit");
    let current = gh.files.get(`${SLUG}/${ONE}`)!;
    await saveBookFile(testEnv.DB, gh.repo, project, viewer, ONE, { source: `${current.source}More words.\n`, expectedVersion: current.sha, client: "Claude" });
    current = gh.files.get(`${SLUG}/${TWO}`)!;
    await testEnv.DB.prepare("UPDATE book_files SET sha = 'stale' WHERE path = ?").bind(TWO).run();
    await saveBookFile(testEnv.DB, gh.repo, project, viewer, TWO, { source: `${current.source}More words.\n`, expectedVersion: current.sha });
    const rows = await testEnv.DB.prepare("SELECT words_typed FROM authorship").all<{ words_typed: number | null }>();
    expect(rows.results).toEqual([{ words_typed: null }, { words_typed: null }]);
    expect(await progressEntries(testEnv.DB, project, viewer)).toEqual([]);
    expect((await authorshipRecord(testEnv.DB, project)).length).toBe(2);
  });

  it("takes pastes from autosave and an AI draft's words from Use as my draft, through the editor's route", async () => {
    await refresh();
    const { viewer, project } = await as("owner@test.invalid", "edit");
    const current = gh.files.get(`${SLUG}/${ONE}`)!;
    const url = `/b/${SLUG}/f/${ONE}`;
    const params = { project: SLUG, "*": ONE };
    await post(fileAction, "owner@test.invalid", url, { intent: "autosave", source: `${current.source}pasted words here\n`, expectedVersion: current.sha, untyped: "3" }, params);
    const ai = await testEnv.DB.prepare("INSERT INTO ai_drafts (project_id, item_id, person_id, client, source, base_version, note) VALUES (?, ?, ?, 'Claude', ?, ?, '') RETURNING id")
      .bind(project.id, ONE, viewer.id, `${HEADER("Drafting")}An AI wrote these five words.\n`, current.sha)
      .first<{ id: number }>();
    await post(fileAction, "owner@test.invalid", url, { intent: "use-ai-draft", draft: String(ai!.id) }, params);
    expect(await testEnv.DB.prepare("SELECT words FROM untyped_words").first<{ words: number }>()).toEqual({ words: 3 + 6 });
    await post(fileAction, "owner@test.invalid", url, { intent: "discard" }, params);
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM untyped_words").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("gives each person their own saves only", async () => {
    await refresh();
    const owner = await as("owner@test.invalid", "edit");
    const editor = await as("editor@test.invalid", "edit");
    const current = gh.files.get(`${SLUG}/${ONE}`)!;
    await saveBookFile(testEnv.DB, gh.repo, editor.project, editor.viewer, ONE, { source: `${current.source}Four more words here.\n`, expectedVersion: current.sha });
    expect(await progressEntries(testEnv.DB, owner.project, owner.viewer)).toEqual([]);
    expect(await progressEntries(testEnv.DB, editor.project, editor.viewer)).toMatchObject([{ typed: 4, removed: 0 }]);
  });
});

describe("goals", () => {
  it("PLANT: a Reader cannot set a goal; an Editor sets their own, checked", async () => {
    expect(((await post(bookAction, "reader@test.invalid", `/b/${SLUG}`, { intent: "goal", mode: "daily", dailyTarget: "500", writingDays: ["1"] }, { project: SLUG })) as Response).status).toBe(403);
    const bad = await post(bookAction, "editor@test.invalid", `/b/${SLUG}`, { intent: "goal", mode: "daily", dailyTarget: "lots", writingDays: ["1"] }, { project: SLUG });
    expect(bad).toMatchObject({ goal: { saved: false, error: expect.stringMatching(/whole number/) } });
    const none = await post(bookAction, "editor@test.invalid", `/b/${SLUG}`, { intent: "goal", mode: "daily", dailyTarget: "500" }, { project: SLUG });
    expect(none).toMatchObject({ goal: { saved: false, error: expect.stringMatching(/writing day/) } });
    const ok = await post(bookAction, "editor@test.invalid", `/b/${SLUG}`, { intent: "goal", mode: "deadline", dailyTarget: "1,500", writingDays: ["1", "3", "5"], allowNegative: "1" }, { project: SLUG });
    expect(ok).toMatchObject({ goal: { saved: true } });
    const editor = await as("editor@test.invalid");
    expect(await readGoal(testEnv.DB, editor.project, editor.viewer)).toEqual({ mode: "deadline", dailyTarget: 1500, writingDays: [1, 3, 5], allowNegative: true });
    const owner = await as("owner@test.invalid");
    expect(await readGoal(testEnv.DB, owner.project, owner.viewer)).toMatchObject({ mode: "daily", dailyTarget: null });
  });

  it("hands the book page the saves, the goal, and the title page's target and deadline", async () => {
    await refresh();
    const { viewer, project } = await as("owner@test.invalid", "edit");
    await saveGoal(testEnv.DB, project, viewer, { mode: "daily", dailyTarget: "300", writingDays: ["0", "6"], allowNegative: false });
    const data = (await bookLoader({ request: new Request(`https://carrel.test/b/${SLUG}`), params: { project: SLUG }, context: await contextFor("owner@test.invalid") } as never)) as Awaited<
      ReturnType<typeof bookLoader>
    >;
    expect(data.progress).toMatchObject({ projectTarget: 10000, deadline: "2027-01-01", goal: { dailyTarget: 300, writingDays: [0, 6] }, entries: [] });
    expect(data.chapters[0]!.scenes.map((s) => s.status)).toEqual(["Drafting", "first draft"]);
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
    expect((await outliner("reader@test.invalid", "?status=first+draft")).rows.map((r) => r.path)).toEqual([TWO]);
    expect((await outliner("reader@test.invalid", "?status=none")).rows.map((r) => r.path)).toEqual([THREE]);
    expect((await outliner("reader@test.invalid", "?status=other")).rows.map((r) => r.status)).toEqual(["Polished"]);
    expect((await outliner("reader@test.invalid", "?status=final")).rows).toEqual([]);
  });

  it("PLANT: a Reader cannot edit the status list; an Editor replaces it, and the outliner follows", async () => {
    await refresh();
    const url = `/b/${SLUG}/outliner`;
    const reader = await post(outlinerAction, "reader@test.invalid", url, { intent: "labels", label: ["Polished"], color: ["2"] }, { project: SLUG });
    expect((reader as Response).status).toBe(403);
    const saved = await post(outlinerAction, "editor@test.invalid", url, { intent: "labels", label: ["Drafting", "Polished", ""], color: ["3", "7", "1"] }, { project: SLUG });
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
    const twice = await saveStatusList(testEnv.DB, (await as("editor@test.invalid", "edit")).project, [{ label: "A", color: 1 }, { label: "a", color: 1 }]);
    expect(twice.ok).toBe(false);
  });
});
