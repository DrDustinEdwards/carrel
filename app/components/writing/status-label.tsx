// A file's status as the project's list names it: the label's word with its color as a dot beside
// it, so the word carries the meaning and the color only repeats it. A value the list does not carry
// is shown as written, in a neutral outline pill; an empty one shows nothing.

import { Pill } from "capsomer/react/status";

import { labelFor, type StatusLabel } from "~/lib/writing/status";

export function StatusLabelPill({ labels, status }: { labels: StatusLabel[]; status: string }) {
  if (!status.trim()) return null;
  const label = labelFor(labels, status);
  if (!label) {
    return (
      <Pill variant="outline">
        {status.trim()}
        <span className="cap-sr-only"> (not on the status list)</span>
      </Pill>
    );
  }
  return (
    <span className="app-label" data-color={label.color}>
      <span className="app-label-dot" aria-hidden="true" />
      {label.label}
    </span>
  );
}
