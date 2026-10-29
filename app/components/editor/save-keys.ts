// What the post editor and the book file editor share about saving: Cmd+S (Ctrl+S) as a save in place.

import { useEffect } from "react";

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
