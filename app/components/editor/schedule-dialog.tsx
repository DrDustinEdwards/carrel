// Scheduling a post (routes/editor.tsx): the site publishes it at the chosen time. On a live post it
// schedules an update instead: the live post stays as it is, and the site publishes the new text then.

import { useState } from "react";
import { Button } from "capsomer/react/button";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "capsomer/react/dialog";
import { Field } from "capsomer/react/field";

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
  const past = scheduleAt !== "" && new Date(scheduleAt).getTime() <= Date.now();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} placement="center" size="sm" returnTo={returnTo} aria-labelledby="schedule-title">
      <DialogHeader divider>
        <DialogTitle id="schedule-title">{update ? `Schedule an update to this ${noun}` : `Schedule this ${noun}`}</DialogTitle>
        <DialogDescription>
          {update
            ? `The live ${noun} stays as it is. The site publishes your text at the time you choose${current ? ", in place of the update already scheduled" : ""}. You can cancel it before then.`
            : "The site publishes it at the time you choose. Revert to draft takes it back."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Field label="Publish at" required error={past ? "Choose a time in the future." : undefined}>
          <input className="cap-input" type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
        </Field>
      </DialogBody>
      <DialogFooter align="between">
        <DialogClose part="cancel">Cancel</DialogClose>
        <Button
          variant="primary"
          disabledReason={!scheduleAt ? "Choose a time first." : past ? "Choose a time in the future." : undefined}
          onClick={async () => {
            await schedule(new Date(scheduleAt).toISOString());
          }}
        >
          {update ? "Schedule update" : "Schedule"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
