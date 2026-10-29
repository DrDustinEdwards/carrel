// Scheduling a post (routes/editor.tsx): the site publishes it at the chosen time. On a live post it
// schedules an update instead: the live post stays as it is, and the site publishes the new text then.

import { useEffect, useState } from "react";
import { Button } from "capsomer/react/button";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "capsomer/react/dialog";
import { Field } from "capsomer/react/field";
import { ExactTime } from "~/components/exact-time";

type Props = {
  open: boolean;
  /** "post", "page": what is scheduled, in the dialog's title. */
  noun: string;
  /** The post is live: what is scheduled is an update to it. */
  update?: boolean;
  /** The time an update already waits for, as an ISO time; scheduling again replaces it. */
  current?: string | null;
  returnTo: HTMLElement | null | undefined;
  onClose: () => void;
  /** Sends the schedule, as an ISO time. */
  schedule: (publishAt: string) => Promise<void>;
};

/** An ISO time as a datetime-local input's value, in the browser's own zone. */
function localValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduleDialog({ open, noun, update = false, current = null, returnTo, onClose, schedule }: Props) {
  const [scheduleAt, setScheduleAt] = useState(current ? localValue(current) : "");
  // The input reads and writes the browser's own time zone, and shows the time in the browser's
  // format, so the field names the zone and the line under it says the time in Carrel's words.
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => setZone(Intl.DateTimeFormat().resolvedOptions().timeZone), []);
  const at = scheduleAt ? new Date(scheduleAt) : null;
  const past = at !== null && at.getTime() <= Date.now();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} placement="center" size="sm" returnTo={returnTo} aria-labelledby="schedule-title">
      <DialogHeader divider>
        <DialogTitle id="schedule-title">{update ? (current ? "Replace the scheduled update" : `Schedule an update to this ${noun}`) : `Schedule this ${noun}`}</DialogTitle>
        <DialogDescription>
          {update
            ? `The live ${noun} stays as it is. The site publishes the text in the editor at the time you choose${current ? ", in place of the update scheduled now" : ""}. You can cancel it before then.`
            : "The site publishes it at the time you choose. Revert to draft takes it back."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Field label="Publish at" required help={zone ? `In your time zone, ${zone}.` : undefined} error={past ? "Choose a time in the future." : undefined}>
          <input className="cap-input" type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
        </Field>
        {at && !past && !Number.isNaN(at.getTime()) ? (
          <p className="cap-muted app-note">
            Goes live <ExactTime at={at.toISOString()} />.
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter align="between" className="app-reason-unseen">
        <DialogClose part="cancel">Cancel</DialogClose>
        <Button
          variant="primary"
          // Why it is refused is said once, under the field (a past time) or by the field's Required
          // (no time yet); the button's own reason is for a screen reader (app.css).
          disabledReason={!scheduleAt ? "Choose a time first." : past ? "Choose a time in the future." : undefined}
          onClick={async () => {
            await schedule(new Date(scheduleAt).toISOString());
          }}
        >
          {update ? (current ? "Replace the update" : "Schedule update") : "Schedule"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
