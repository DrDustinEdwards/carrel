// Scheduling a post (routes/editor.tsx): the site publishes it at the chosen time.

import { useState } from "react";
import { Button } from "capsomer/react/button";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "capsomer/react/dialog";
import { Field } from "capsomer/react/field";

type Props = {
  open: boolean;
  /** "post", "page": what is scheduled, in the dialog's title. */
  noun: string;
  returnTo: HTMLElement | null | undefined;
  onClose: () => void;
  /** Sends the schedule, as an ISO time. */
  schedule: (publishAt: string) => Promise<void>;
};

export function ScheduleDialog({ open, noun, returnTo, onClose, schedule }: Props) {
  const [scheduleAt, setScheduleAt] = useState("");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} placement="center" size="sm" returnTo={returnTo} aria-labelledby="schedule-title">
      <DialogHeader divider>
        <DialogTitle id="schedule-title">Schedule this {noun}</DialogTitle>
        <DialogDescription>The site publishes it at the time you choose. Revert to draft takes it back.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <Field label="Publish at" required>
          <input className="cap-input" type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
        </Field>
      </DialogBody>
      <DialogFooter align="between">
        <DialogClose part="cancel">Cancel</DialogClose>
        <Button
          variant="primary"
          disabledReason={!scheduleAt ? "Choose a time first." : undefined}
          onClick={async () => {
            await schedule(new Date(scheduleAt).toISOString());
          }}
        >
          Schedule
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
