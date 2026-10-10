// The writing desk's own records in D1 (job_50786e609b88): each project's status list, each person's
// writing goal, the running count of words that reached a file without being typed, and the saves a
// day's progress is counted from. Git holds the text and the headers; none of this is in Git.

import { and, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { authorship, statusLabels, untypedWords, writingGoals } from "~/db/schema";
import type { BookProject } from "~/lib/books.server";
import type { Viewer } from "~/lib/people.server";
import { can } from "~/lib/roles";
import { DEFAULT_GOAL, parseWritingDays, STREAK_HORIZON_DAYS, type Goal, type SaveEntry } from "~/lib/writing/progress";
import { cleanLabels, STARTING_STATUSES, type StatusLabel } from "~/lib/writing/status";

function forbid(): never {
  throw new Response("Forbidden", { status: 403 });
}

// ---------- status lists

/** The project's list, or the starting list for books while it has none of its own. */
export async function statusList(db: D1Database, project: BookProject): Promise<{ labels: StatusLabel[]; edited: boolean }> {
  if (!can(project.role, "read")) forbid();
  const rows = await drizzle(db)
    .select({ label: statusLabels.label, color: statusLabels.color })
    .from(statusLabels)
    .where(eq(statusLabels.projectId, project.id))
    .orderBy(statusLabels.position)
    .all();
  if (rows.length === 0) return { labels: STARTING_STATUSES.book, edited: false };
  return { labels: rows, edited: true };
}

/** Replaces the whole list. Files keep whatever `status:` they carry; a label taken away shows as written. */
export async function saveStatusList(db: D1Database, project: BookProject, rows: { label: string; color: string | number }[]) {
  if (!can(project.role, "edit")) forbid();
  const clean = cleanLabels(rows);
  if (!clean.ok) return clean;
  await db.batch([
    db.prepare("DELETE FROM status_labels WHERE project_id = ?").bind(project.id),
    ...clean.labels.map((l, i) => db.prepare("INSERT INTO status_labels (project_id, position, label, color) VALUES (?, ?, ?, ?)").bind(project.id, i, l.label, l.color)),
  ]);
  return clean;
}

// ---------- goals

export async function readGoal(db: D1Database, project: BookProject, viewer: Viewer): Promise<Goal> {
  if (!can(project.role, "read")) forbid();
  const row = await drizzle(db)
    .select()
    .from(writingGoals)
    .where(and(eq(writingGoals.projectId, project.id), eq(writingGoals.personId, viewer.id)))
    .get();
  if (!row) return DEFAULT_GOAL;
  return { mode: row.mode, dailyTarget: row.dailyTarget, writingDays: parseWritingDays(row.writingDays), allowNegative: row.allowNegative };
}

export const MAX_DAILY_TARGET = 100_000;

/** A person's own goal: anyone who may write in the project sets theirs, and no one else's. */
export async function saveGoal(db: D1Database, project: BookProject, viewer: Viewer, input: { mode: string; dailyTarget: string; writingDays: string[]; allowNegative: boolean }) {
  if (!can(project.role, "edit")) forbid();
  const mode = input.mode === "deadline" ? "deadline" : "daily";
  const raw = input.dailyTarget.replace(/[,_\s]/g, "");
  const dailyTarget = raw === "" ? null : Number(raw);
  if (dailyTarget !== null && (!Number.isInteger(dailyTarget) || dailyTarget < 1 || dailyTarget > MAX_DAILY_TARGET)) {
    return { ok: false as const, error: `Give the daily target as a whole number of words from 1 to ${MAX_DAILY_TARGET.toLocaleString("en-US")}, or leave it empty.` };
  }
  const days = parseWritingDays(input.writingDays.join(""));
  if (days.length === 0) return { ok: false as const, error: "Choose at least one writing day." };
  const values = { mode, dailyTarget, writingDays: days.join(""), allowNegative: input.allowNegative } as const;
  await drizzle(db)
    .insert(writingGoals)
    .values({ projectId: project.id, personId: viewer.id, ...values })
    .onConflictDoUpdate({ target: [writingGoals.projectId, writingGoals.personId], set: values });
  return { ok: true as const };
}

// ---------- words that were not typed

/** Adds words that reached a file without being typed: a paste, a drop, an AI draft taken as the working draft. */
export async function addUntyped(db: D1Database, projectId: number, personId: number, path: string, words: number) {
  const n = Math.floor(words);
  if (!Number.isFinite(n) || n <= 0) return;
  await drizzle(db)
    .insert(untypedWords)
    .values({ projectId, personId, path, words: n })
    .onConflictDoUpdate({ target: [untypedWords.projectId, untypedWords.personId, untypedWords.path], set: { words: sql`${untypedWords.words} + ${n}` } });
}

/** The count since the last save, cleared: a save takes it. */
export async function takeUntyped(db: D1Database, projectId: number, personId: number, path: string): Promise<number> {
  const where = and(eq(untypedWords.projectId, projectId), eq(untypedWords.personId, personId), eq(untypedWords.path, path));
  const rows = await drizzle(db).delete(untypedWords).where(where).returning({ words: untypedWords.words });
  return rows.reduce((n, r) => n + r.words, 0);
}

export async function clearUntyped(db: D1Database, projectId: number, personId: number, path: string) {
  await takeUntyped(db, projectId, personId, path);
}

/** The words a field posted as not typed: a whole number from 0, anything else read as 0. */
export function untypedField(value: FormDataEntryValue | null): number {
  const n = Number(value ?? 0);
  return Number.isInteger(n) && n > 0 && n < 10_000_000 ? n : 0;
}

// ---------- the saves a day is counted from

/**
 * This person's own saves in the project over the streak horizon, as typed and removed words. An AI
 * client's saves and saves from before typed words were recorded are left out: they were not typed.
 */
export async function progressEntries(db: D1Database, project: BookProject, viewer: Viewer, now = new Date()): Promise<SaveEntry[]> {
  if (!can(project.role, "read")) forbid();
  // A day more than the horizon, so the oldest local day is whole in any zone.
  const since = new Date(now.getTime() - (STREAK_HORIZON_DAYS + 1) * 86_400_000).toISOString();
  const rows = await drizzle(db)
    .select({ at: authorship.createdAt, typed: authorship.wordsTyped, removed: authorship.wordsRemoved })
    .from(authorship)
    .where(
      and(
        eq(authorship.projectId, project.id),
        eq(authorship.personId, viewer.id),
        isNull(authorship.client),
        isNotNull(authorship.wordsTyped),
        gte(authorship.createdAt, since),
      ),
    )
    .orderBy(authorship.createdAt)
    .all();
  return rows.map((r) => ({ at: r.at, typed: r.typed ?? 0, removed: r.removed }));
}
