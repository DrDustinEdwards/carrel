// Daily progress and streaks (ruling 6, after Dabble, Ulysses and Scrivener). A day is the local
// calendar day in the device's time zone, so it resets at local midnight wherever Dustin is; the
// browser passes its zone in and nothing here reads the server's clock zone. Only typed words count:
// each save's words_typed already leaves out pastes, drops, imports and AI drafts taken as the
// working draft. Deletions come off the day, but not below zero unless the goal allows it. A target
// is set by hand or worked out from the project's deadline over the writing days chosen, and a
// streak counts the days that target was met.
//
// Pure functions only: the book page runs them in the browser, and the tests run them anywhere.

export type SaveEntry = { at: string; typed: number; removed: number };

export type Goal = {
  mode: "daily" | "deadline";
  dailyTarget: number | null;
  /** Weekdays that are writing days, 0 Sunday to 6 Saturday. A day off is not counted against pace or streak. */
  writingDays: number[];
  allowNegative: boolean;
};

export const DEFAULT_GOAL: Goal = { mode: "daily", dailyTarget: null, writingDays: [0, 1, 2, 3, 4, 5, 6], allowNegative: false };

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** How far back a streak is followed; the loader sends this many days of saves. */
export const STREAK_HORIZON_DAYS = 400;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar day (YYYY-MM-DD) an instant falls on in a time zone. */
export function dayKey(at: string | Date, timeZone: string): string {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(typeof at === "string" ? new Date(at) : at).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The weekday of a calendar day, 0 Sunday. Computed at noon UTC, which every zone shares as the same date. */
export function weekdayOf(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Words per local day: typed minus removed, held at zero unless the goal lets a day go negative. */
export function dayTotals(entries: SaveEntry[], timeZone: string, allowNegative: boolean): Map<string, number> {
  const raw = new Map<string, number>();
  for (const e of entries) {
    const day = dayKey(e.at, timeZone);
    raw.set(day, (raw.get(day) ?? 0) + e.typed - e.removed);
  }
  if (allowNegative) return raw;
  return new Map([...raw].map(([day, n]) => [day, Math.max(0, n)]));
}

/** Writing days from `from` to `to`, both included. */
export function writingDaysBetween(from: string, to: string, writingDays: number[]): number {
  let n = 0;
  for (let day = from, guard = 0; day <= to && guard < 3700; day = addDays(day, 1), guard++) {
    if (writingDays.includes(weekdayOf(day))) n++;
  }
  return n;
}

export type Pace =
  | { ok: true; perDay: number; remaining: number; days: number }
  | { ok: false; reason: "no-target" | "no-deadline" | "past" | "no-days" | "done" };

/**
 * The words a day needs to reach the project's target by its deadline: what was left when today
 * began, spread over the writing days from today to the deadline. Today's own words do not lower
 * today's target, so the number holds still while Dustin writes.
 */
export function pace(input: { projectTarget: number | null; deadline: string; wordsNow: number; wordsToday: number; today: string; writingDays: number[] }): Pace {
  if (!input.projectTarget) return { ok: false, reason: "no-target" };
  if (!input.deadline) return { ok: false, reason: "no-deadline" };
  if (input.deadline < input.today) return { ok: false, reason: "past" };
  const remaining = Math.max(0, input.projectTarget - (input.wordsNow - Math.max(0, input.wordsToday)));
  if (remaining === 0) return { ok: false, reason: "done" };
  const days = writingDaysBetween(input.today, input.deadline, input.writingDays);
  if (days === 0) return { ok: false, reason: "no-days" };
  return { ok: true, perDay: Math.ceil(remaining / days), remaining, days };
}

/** Today's target, or null when there is none; a day off has none whatever the goal says. */
export function targetFor(goal: Goal, today: string, paced: Pace): number | null {
  if (!goal.writingDays.includes(weekdayOf(today))) return null;
  if (goal.mode === "deadline") return paced.ok ? paced.perDay : null;
  return goal.dailyTarget && goal.dailyTarget > 0 ? goal.dailyTarget : null;
}

/**
 * Days in a row the target was met, counting back from today. Today counts once it is met and does
 * not break the run before then. A day off neither breaks the run nor adds to it, unless the target
 * was met on it anyway. The target is today's: Carrel keeps no history of past targets.
 */
export function streak(totals: Map<string, number>, today: string, target: number | null, writingDays: number[]): number {
  if (!target || target <= 0) return 0;
  let run = 0;
  for (let i = 0; i < STREAK_HORIZON_DAYS; i++) {
    const day = addDays(today, -i);
    const met = (totals.get(day) ?? 0) >= target;
    if (met) {
      run++;
      continue;
    }
    if (i === 0) continue;
    if (!writingDays.includes(weekdayOf(day))) continue;
    break;
  }
  return run;
}

/** The last `n` days, newest first, each with its words and whether it was a writing day. */
export function recentDays(totals: Map<string, number>, today: string, n: number, writingDays: number[]) {
  return Array.from({ length: n }, (_, i) => {
    const day = addDays(today, -i);
    return { day, words: totals.get(day) ?? 0, writingDay: writingDays.includes(weekdayOf(day)) };
  });
}

/** "0123456" as stored, to weekday numbers; anything else in the string is dropped. */
export function parseWritingDays(stored: string): number[] {
  return [...new Set([...stored].map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
}
