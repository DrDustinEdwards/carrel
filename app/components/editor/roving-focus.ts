// Copied from DrDustinEdwards/dustinedwards-info@6e0f8c9 (app/components/admin/roving-focus.ts).
// Unchanged but for the import path.

import { rovingTarget } from "~/lib/roving.mjs";

/**
 * Moves focus among the `selector` items inside the handler's element on an arrow, Home or End, and
 * returns the index it moved to, or null when the key was not one of those. The caller keeps the
 * one tab stop (`tabIndex` 0 on the active item, -1 on the rest) in its own state.
 */
export function moveRovingFocus(
  event: React.KeyboardEvent<HTMLElement>,
  selector: string,
  axis: "horizontal" | "vertical" | "both" = "horizontal",
): number | null {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(selector)];
  const at = items.findIndex((item) => item.contains(event.target as Node));
  if (at < 0) return null;
  const next = rovingTarget(event.key, at, items.length, axis);
  const target = next === null ? undefined : items[next];
  if (next === null || !target) return null;
  event.preventDefault();
  target.focus();
  return next;
}
