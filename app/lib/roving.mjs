// Copied from DrDustinEdwards/dustinedwards-info@6e0f8c9 (app/lib/admin/roving.mjs).
// Unchanged.

/**
 * The key map of a roving tabindex (APG toolbar, radio group and menu patterns): which item an arrow,
 * Home or End moves to. Pure, so a node test can hold it; the components own focus and state.
 *
 * `axis` is the arrows that move: "horizontal" for a toolbar, "vertical" for a list, "both" for a
 * radio group, where Down and Right go forward and Up and Left go back.
 * Movement wraps, as the APG toolbar and radio group examples do.
 *
 * @param {string} key a KeyboardEvent `key`
 * @param {number} at the index that has focus now
 * @param {number} count how many items there are
 * @param {"horizontal" | "vertical" | "both"} [axis]
 * @returns {number | null} the index to move to, or null when the key is not a movement key
 */
export function rovingTarget(key, at, count, axis = "horizontal") {
  if (count <= 0) return null;
  const across = axis !== "vertical";
  const down = axis !== "horizontal";
  if ((across && key === "ArrowRight") || (down && key === "ArrowDown")) return (at + 1) % count;
  if ((across && key === "ArrowLeft") || (down && key === "ArrowUp")) return (at - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
