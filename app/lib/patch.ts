// A unified patch for two texts that are both in Carrel (a working draft against the site's text,
// or against an AI draft). The site's own revision diffs come ready-made from site-api and use the
// same library, so every patch the history screens show has the same shape. Pure, so the server
// builds it and a test reads it.

import { createTwoFilesPatch } from "diff";

/**
 * The patch from `before` to `after`, three lines of context. Both sides carry the same file name,
 * so the viewer shows one file changed and not a rename; what each side is goes in its header.
 * Texts that are the same give a patch with no hunks, which the viewer says in words.
 */
export function unifiedPatch(name: string, before: { text: string; label: string }, after: { text: string; label: string }): string {
  return createTwoFilesPatch(name, name, before.text, after.text, before.label, after.label, { context: 3 });
}

/** True when a patch carries at least one changed line. */
export function hasChanges(patch: string): boolean {
  return /^@@ /m.test(patch);
}
