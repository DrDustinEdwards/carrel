// Today's writing on the book page (ruling 6): the words typed today against today's target, the
// streak, the pace a deadline asks for, the last seven days, and the person's own goal. A day is the
// local calendar day in this device's time zone, which only the browser knows, so the numbers are
// worked out after the page loads; until then the panel says it is counting.

import { useEffect, useState } from "react";
import { Form, Link } from "react-router";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Disclosure } from "capsomer/react/disclosure";
import { Check, Field } from "capsomer/react/field";
import { Meter } from "capsomer/react/meter";
import { Panel } from "capsomer/react/panel";
import { Status } from "capsomer/react/status";

import { dayTotals, pace, recentDays, streak, targetFor, WEEKDAYS, dayKey, type Goal, type Pace, type SaveEntry } from "~/lib/writing/progress";

const n = (value: number) => value.toLocaleString("en-US");

function paceLine(paced: Pace, deadline: string) {
  if (paced.ok) return `${n(paced.remaining)} words to go by ${deadline}: ${n(paced.perDay)} a day over ${paced.days} writing day${paced.days === 1 ? "" : "s"}.`;
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

function dayLabel(day: string, today: string) {
  if (day === today) return "Today";
  const weekday = WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]!;
  return `${weekday} ${day.slice(5).replace("-", "/")}`;
}

export function ProgressPanel({
  entries,
  goal,
  projectTarget,
  deadline,
  wordsNow,
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
  canEdit: boolean;
  /** The title page's address, where the project target and deadline are set. */
  titlePage: string;
  error: string | null;
  saved: boolean;
}) {
  // The device's zone, read once the page is in the browser. The server's render has none.
  const [zone, setZone] = useState<string | null>(null);
  const [mode, setMode] = useState(goal.mode);
  useEffect(() => setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"), []);
  useEffect(() => setMode(goal.mode), [goal.mode]);

  let body;
  if (!zone) {
    body = (
      <p className="cap-muted" role="status">
        Counting today's words in this device's time zone.
      </p>
    );
  } else {
    const today = dayKey(new Date(), zone);
    const totals = dayTotals(entries, zone, goal.allowNegative);
    const wordsToday = totals.get(today) ?? 0;
    const paced = pace({ projectTarget, deadline, wordsNow, wordsToday, today, writingDays: goal.writingDays });
    const target = targetFor(goal, today, paced);
    const dayOff = !goal.writingDays.includes(new Date(`${today}T12:00:00Z`).getUTCDay());
    const run = streak(totals, today, target, goal.writingDays);
    const met = target !== null && wordsToday >= target;
    const days = recentDays(totals, today, 7, goal.writingDays);

    body = (
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
            <span className="cap-muted">{dayOff ? "A day off: no target today." : goal.mode === "deadline" ? "No pace to work out yet." : "No daily target set."}</span>
          </p>
        )}
        {met ? <Status tone="ok">Target met</Status> : null}
        <p>
          Streak: <strong>{run}</strong> day{run === 1 ? "" : "s"} in a row at the target.
          {target === null ? <span className="cap-muted"> A streak needs a target.</span> : null}
        </p>
        {goal.mode === "deadline" || deadline || projectTarget ? <p className="cap-muted">{paceLine(paced, deadline)}</p> : null}
        <div className="cap-table-wrap" role="region" aria-labelledby="progress-week" tabIndex={0}>
          <table className="cap-table">
            <caption id="progress-week" className="cap-sr-only">
              Words typed on each of the last seven days
            </caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" data-num>
                  Words
                </th>
                <th scope="col">Target</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day}>
                  <th scope="row">{dayLabel(d.day, today)}</th>
                  <td data-num>{n(d.words)}</td>
                  <td>{!d.writingDay ? <span className="cap-muted">Day off</span> : target === null ? <span className="cap-muted">None set</span> : d.words >= target ? <Status tone="ok">Met</Status> : d.day === today ? <span className="cap-muted">Not yet</span> : <span className="cap-muted">Missed</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <Panel title="Today's writing" src="Typed words only">
      <div className="app-stack" data-tight>
        {body}
        <p className="cap-muted app-note">Pastes, imports and AI drafts you take as your draft do not count. A day runs midnight to midnight on this device.</p>
        {error ? <Alert tone="crit">{error}</Alert> : saved ? <p role="status">Your target is saved.</p> : null}
        {canEdit ? (
          <Disclosure summary="Your target" defaultOpen={Boolean(error)}>
            <Form method="post" className="app-stack" data-tight>
              <input type="hidden" name="intent" value="goal" />
              <fieldset className="app-fieldset">
                <legend>Set the daily target</legend>
                <Check type="radio" name="mode" value="daily" label="By hand" checked={mode === "daily"} onChange={() => setMode("daily")} />
                <Check type="radio" name="mode" value="deadline" label="From the deadline" checked={mode === "deadline"} onChange={() => setMode("deadline")} />
              </fieldset>
              <Field label="Words a day" help={mode === "deadline" ? "Used only when you set it by hand." : "Leave empty for no target."}>
                <input className="cap-input" name="dailyTarget" inputMode="numeric" defaultValue={goal.dailyTarget ?? ""} autoComplete="off" />
              </Field>
              <p className="cap-muted app-note">
                The deadline and the project target are target: and deadline: in the <Link to={titlePage}>title page</Link>.
              </p>
              <fieldset className="app-fieldset">
                <legend>Writing days</legend>
                <div className="app-days">
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <Check key={d} name="writingDays" value={String(d)} label={WEEKDAYS[d]!} defaultChecked={goal.writingDays.includes(d)} />
                  ))}
                </div>
              </fieldset>
              <Check name="allowNegative" value="1" label="Let deletions take a day below zero" defaultChecked={goal.allowNegative} />
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
