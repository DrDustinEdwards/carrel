// Status lists (ruling 8). Each project starts from its kind's list and may edit it: each label has
// one of the eight series colors and filters the outliner. The list, its checks and its pill are
// Capsomer's label color list; the starting lists are Carrel's.

import { colorLabels, type ColorLabel } from "capsomer/behavior/label-color-list";

export type ProjectKind = "book" | "blog" | "manuscript" | "script";

export const STARTING_STATUSES: Record<ProjectKind, ColorLabel[]> = {
  book: colorLabels("Idea", "Outlined", "Drafting", "First draft", "Revised", "Final"),
  // Published comes from the site, so it is not a label Carrel sets.
  blog: colorLabels("Idea", "Drafting", "Ready", "Scheduled"),
  manuscript: colorLabels("Drafting", "Draft done", "With coauthors", "Revising", "Final"),
  script: colorLabels("Idea", "Outlined", "Drafting", "Revised", "Locked"),
};
