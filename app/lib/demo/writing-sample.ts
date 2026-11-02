// Sample writing for the Desk's chart demo (/demos/progress): a week of typed words, a daily target and
// a project deadline, all made up, so a live check sees the book page's progress chart without a sign-in.
// Nothing here is read from D1 or the writing repository, and it belongs to no one.
import type { Goal, SaveEntry } from "~/lib/writing/progress";

const DAY_MS = 86_400_000;
// Words typed on each of the last seven days, today last.
const TYPED = [620, 1340, 0, 980, 1510, 450, 1120];

export function sampleProgress(now = new Date()) {
  const entries: SaveEntry[] = TYPED.map((typed, i) => ({
    at: new Date(now.getTime() - (TYPED.length - 1 - i) * DAY_MS).toISOString(),
    typed,
    removed: Math.round(typed / 12),
  })).filter((e) => e.typed > 0);
  const goal: Goal = { mode: "daily", dailyTarget: 1000, writingDays: [0, 1, 2, 3, 4, 5, 6], allowNegative: false };
  const deadline = new Date(now.getTime() + 60 * DAY_MS).toISOString().slice(0, 10);
  return { entries, goal, projectTarget: 80_000, deadline, wordsNow: 52_340 };
}
