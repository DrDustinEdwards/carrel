// What the post editor and the book file editor share about saving: how long autosave waits after
// typing stops, and Cmd+S (Ctrl+S) as a save in place.

import { useEffect } from "react";

export const AUTOSAVE_DELAY_MS = 1200;

/** Cmd+S calls `save` instead of the browser's own save; `save` decides whether a save may run now. */
export function useSaveShortcut(save: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
}
