// Today's writing on the book page (ruling 6): the words typed today against today's target, the
// streak, the pace a deadline asks for, the last seven days, and the person's own goal. A day is the
// local calendar day in this device's time zone, which only the browser knows. The server counts in
// the zone Cloudflare places the request in (zoneContext, app/lib/context.ts), and the panel counts
// again in the device's zone once the page loads. The two agree for nearly every reader, so the recount
// changes nothing on screen; a note shown only before the recount would move the whole panel when it
// went (web.dev, "Optimize CLS": removing content shifts the page as much as inserting it).

import { useState } from "react";
import { barChart } from "enarratio/lite/bar";
import { Form } from "react-router";
import { Link } from "capsomer/react/link";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { ChartFrame } from "capsomer/react/chart-frame";
import { Disclosure } from "capsomer/react/disclosure";
import { Check, Field } from "capsomer/react/field";
import { Meter } from "capsomer/react/meter";
import { Panel } from "capsomer/react/panel";
import { Status } from "capsomer/react/status";

import {
  dayTotals,
  pace,
  recentDays,
  streak,
  targetFor,
  WEEKDAYS,
  dayKey,
  type Goal,
  type Pace,
  type SaveEntry,
} from "~/lib/writing/progress";
import { useBrowserZone } from "~/lib/hydrated";

const n = (value: number) => value.toLocaleString("en-US");

function paceLine(paced: Pace, deadline: string) {
  if (paced.ok)
    return `${n(paced.remaining)} words to go by ${deadline}: ${n(paced.perDay)} a day over ${paced.days} writing day${paced.days === 1 ? "" : "s"}.`;
  switch (paced.reason) {
    case "no-target":
      return `No project target yet. Add target: to the title page (book.md) to work out a pace.`;
    case "no-deadline":
      return `No deadline yet. Add deadline: (YYYY-MM-DD) to the title page (book.md) to work out a pace.`;
    case "past":
      return `The deadline, ${deadline}, has passed.`;
    case "no-days":
      return "No writing days are left before the deadline.";
    case "done":
      return "The project has reached its target.";
  }
}

const weekday = (day: string) => WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]!;

type Day = { day: string; words: number; writingDay: boolean };

// The last seven days as Enarratio's bar chart, oldest first, with the band at or above today's
// target; its hidden data table is the same numbers.
function weekChart(days: Day[], target: number | null) {
  const data = days.map((d) => ({ day: weekday(d.day).slice(0, 3), words: d.words })).reverse();
  const writing = days.filter((d) => d.writingDay);
  const off = days.filter((d) => !d.writingDay).map((d) => weekday(d.day));
  const top = days.reduce((a, d) => (d.words > a.words ? d : a), days[0]!);
  const total = days.reduce((sum, d) => sum + d.words, 0);
  const alt =
    target === null
      ? `${n(total)} words typed over the last seven days${top.words > 0 ? `, the most on ${weekday(top.day)} (${n(top.words)})` : ""}.`
      : `The ${n(target)}-word target was met on ${writing.filter((d) => d.words >= target).length} of the last ${writing.length} writing days.`;
  // `fit` is the height the server's drawing showed at the frame's width (Capsomer's ChartFrame from
  // 0.66; before it, undefined): the redraw keeps it, so it does not push the page down on a phone.
  return (width: number, fit?: { height?: number }) =>
    barChart({
      data,
      x: "day",
      y: "words",
      width,
      height: 220,
      id: "progress-week",
      title: "Words typed, the last seven days",
      subtitle: `${weekday(days.at(-1)!.day)} to today`,
      alt,
      xLabel: "Day",
      yLabel: "Typed",
      yUnit: "words",
      formatValue: n,
      notes: off.length ? `Days off: ${[...new Set(off)].join(", ")}.` : undefined,
      source: "Typed words in Carrel's authorship record",
      annotations:
        target === null
          ? undefined
          : [
              {
                type: "range",
                axis: "y",
                from: target,
                to: Math.max(target, top.words),
                label: "Target",
              },
            ],
      ...fit,
    });
}

export function ProgressPanel({
  entries,
  goal,
  projectTarget,
  deadline,
  wordsNow,
  zone: requestZone,
  canEdit,
  titlePage,
  error,
  saved,
}: {
  entries: SaveEntry[];
  goal: Goal;
  projectTarget: number | null;
  deadline: string;
  wordsNow: number;
  /** The zone the server counted in: the request's, from Cloudflare, or UTC. */
  zone: string;
  canEdit: boolean;
  /** The title page's address, where the project target and deadline are set. */
  titlePage: string;
  error: string | null;
  saved: boolean;
}) {
  // The server's zone first, so hydration matches its HTML; then the device's own, read in the browser.
  const zone = useBrowserZone(requestZone);
  const [mode, setMode] = useState(goal.mode);
  // A new goal from the server replaces the mode being chosen, adjusted while rendering
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const [goalMode, setGoalMode] = useState(goal.mode);
  if (goal.mode !== goalMode) {
    setGoalMode(goal.mode);
    setMode(goal.mode);
  }
  // The day is read once, when the panel is drawn, not on every render.
  const [now] = useState(() => new Date());

  const today = dayKey(now, zone);
  const totals = dayTotals(entries, zone, goal.allowNegative);
  const wordsToday = totals.get(today) ?? 0;
  const paced = pace({
    projectTarget,
    deadline,
    wordsNow,
    wordsToday,
    today,
    writingDays: goal.writingDays,
  });
  const target = targetFor(goal, today, paced);
  const dayOff = !goal.writingDays.includes(new Date(`${today}T12:00:00Z`).getUTCDay());
  const run = streak(totals, today, target, goal.writingDays);
  const met = target !== null && wordsToday >= target;
  const days = recentDays(totals, today, 7, goal.writingDays);

  const body = (
    <div className="app-stack" data-tight>
      {target !== null ? (
        <Meter
          label="Typed today"
          value={Math.max(0, wordsToday)}
          max={target}
          display={`${n(wordsToday)} of ${n(target)}`}
          valueText={`${n(wordsToday)} of ${n(target)} words typed today.${met ? " Target met." : ""}`}
          tone={met ? "ok" : undefined}
          note={met ? "Today's target is met." : `${n(target - wordsToday)} to go today.`}
        />
      ) : (
        <p>
          <strong>{n(wordsToday)}</strong> word{wordsToday === 1 ? "" : "s"} typed today.{" "}
          <span className="cap-muted">
            {dayOff
              ? "A day off: no target today."
              : goal.mode === "deadline"
                ? "No pace to work out yet."
                : "No daily target set."}
          </span>
        </p>
      )}
      {met ? <Status tone="ok">Target met</Status> : null}
      <p>
        Streak: <strong>{run}</strong> day{run === 1 ? "" : "s"} in a row at the target.
        {target === null ? <span className="cap-muted"> A streak needs a target.</span> : null}
      </p>
      {goal.mode === "deadline" || deadline || projectTarget ? (
        <p className="cap-muted">{paceLine(paced, deadline)}</p>
      ) : null}
      <ChartFrame draw={weekChart(days, target)} width={360} />
    </div>
  );

  return (
    <Panel title="Today's writing" src="Typed words only">
      <div className="app-stack" data-tight>
        {body}
        <p className="cap-muted app-note">
          Pastes, imports and AI drafts you take as your draft do not count. A day runs midnight to
          midnight on this device.
        </p>
        {error ? (
          <Alert tone="crit">{error}</Alert>
        ) : saved ? (
          <p role="status">Your target is saved.</p>
        ) : null}
        {canEdit ? (
          <Disclosure summary="Your target" defaultOpen={Boolean(error)}>
            <Form method="post" className="app-stack" data-tight>
              <input type="hidden" name="intent" value="goal" />
              <fieldset className="app-fieldset">
                <legend>Set the daily target</legend>
                <Check
                  type="radio"
                  name="mode"
                  value="daily"
                  label="By hand"
                  checked={mode === "daily"}
                  onChange={() => setMode("daily")}
                />
                <Check
                  type="radio"
                  name="mode"
                  value="deadline"
                  label="From the deadline"
                  checked={mode === "deadline"}
                  onChange={() => setMode("deadline")}
                />
              </fieldset>
              <Field
                label="Words a day"
                help={
                  mode === "deadline"
                    ? "Used only when you set it by hand."
                    : "Leave empty for no target."
                }
              >
                <input
                  className="cap-input"
                  name="dailyTarget"
                  inputMode="numeric"
                  defaultValue={goal.dailyTarget ?? ""}
                  autoComplete="off"
                />
              </Field>
              <p className="cap-muted app-note">
                The deadline and the project target are target: and deadline: in the{" "}
                <Link to={titlePage}>title page</Link>.
              </p>
              <fieldset className="app-fieldset">
                <legend>Writing days</legend>
                <div className="app-days">
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <Check
                      key={d}
                      name="writingDays"
                      value={String(d)}
                      label={WEEKDAYS[d]!}
                      defaultChecked={goal.writingDays.includes(d)}
                    />
                  ))}
                </div>
              </fieldset>
              <Check
                name="allowNegative"
                value="1"
                label="Let deletions take a day below zero"
                defaultChecked={goal.allowNegative}
              />
              <div className="app-actions">
                <Button type="submit">Save my target</Button>
              </div>
            </Form>
          </Disclosure>
        ) : null}
      </div>
    </Panel>
  );
}
