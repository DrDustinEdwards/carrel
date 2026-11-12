// Status lists (ruling 8). Each project starts from its kind's list and may edit it: each label has
// one of Capsomer's eight series colors and filters the outliner. A file's `status:` is matched to a
// label ignoring case (Capsomer's label color list); a value the list does not carry is shown as
// written, in a neutral pill, and never refused.

import { colorLabels, type ColorLabel } from "capsomer/behavior/label-color-list";

export type ProjectKind = "book" | "blog" | "manuscript" | "script";

export const STARTING_STATUSES: Record<ProjectKind, ColorLabel[]> = {
  book: colorLabels("Idea", "Outlined", "Drafting", "First draft", "Revised", "Final"),
  // Published comes from the site, so it is not a label Carrel sets.
  blog: colorLabels("Idea", "Drafting", "Ready", "Scheduled"),
  manuscript: colorLabels("Drafting", "Draft done", "With coauthors", "Revising", "Final"),
  script: colorLabels("Idea", "Outlined", "Drafting", "Revised", "Locked"),
};
