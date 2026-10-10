// Status lists (ruling 8). Each project starts from its kind's list and may edit it: each label has
// one of Capsomer's eight series colors and filters the outliner. A file's `status:` is matched to a
// label ignoring case; a value the list does not carry is shown as written, in a neutral pill, and
// never refused.

export type StatusLabel = { label: string; color: number };

export type ProjectKind = "book" | "blog" | "manuscript" | "script";

const list = (...labels: string[]): StatusLabel[] => labels.map((label, i) => ({ label, color: (i % 8) + 1 }));

export const STARTING_STATUSES: Record<ProjectKind, StatusLabel[]> = {
  book: list("Idea", "Outlined", "Drafting", "First draft", "Revised", "Final"),
  // Published comes from the site, so it is not a label Carrel sets.
  blog: list("Idea", "Drafting", "Ready", "Scheduled"),
  manuscript: list("Drafting", "Draft done", "With coauthors", "Revising", "Final"),
  script: list("Idea", "Outlined", "Drafting", "Revised", "Locked"),
};

/** The names a person sees for the eight colors, in token order (--series-1 to --series-8). */
export const COLOR_NAMES = ["Violet", "Orange", "Teal", "Green", "Indigo", "Pine", "Pink", "Wine"] as const;

export const MAX_LABELS = 12;
export const MAX_LABEL_LENGTH = 40;

/** The label a file's `status:` names, or null for an empty or unknown value. */
export function labelFor(labels: StatusLabel[], status: string): StatusLabel | null {
  const wanted = status.trim().toLowerCase();
  if (!wanted) return null;
  return labels.find((l) => l.label.toLowerCase() === wanted) ?? null;
}

/**
 * A list as a person submitted it: blank rows dropped, labels trimmed, duplicates (ignoring case)
 * refused, colors kept to 1 to 8. Returns the clean list or why it was refused.
 */
export function cleanLabels(rows: { label: string; color: string | number }[]): { ok: true; labels: StatusLabel[] } | { ok: false; error: string } {
  const labels: StatusLabel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const label = row.label.trim().replace(/\s+/g, " ");
    if (!label) continue;
    if (label.length > MAX_LABEL_LENGTH) return { ok: false, error: `Keep each label to ${MAX_LABEL_LENGTH} characters: "${label.slice(0, 20)}..." is longer.` };
    const key = label.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `"${label}" is in the list twice.` };
    seen.add(key);
    const color = Number(row.color);
    labels.push({ label, color: Number.isInteger(color) && color >= 1 && color <= 8 ? color : (labels.length % 8) + 1 });
  }
  if (labels.length === 0) return { ok: false, error: "Keep at least one label." };
  if (labels.length > MAX_LABELS) return { ok: false, error: `Keep the list to ${MAX_LABELS} labels.` };
  return { ok: true, labels };
}
