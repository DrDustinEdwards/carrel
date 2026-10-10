// The editor's chrome steps back while someone types and returns on a mouse move or when focus enters
// it. Carrel's editor always did this for its own toolbar; it now covers the shell too, so the rail and
// the top bar fall quiet with the rest. The state is one attribute on the document, read by app.css.

import { useEffect } from "react";

export function useTypingRecede() {
  useEffect(() => {
    const root = document.documentElement;
    const settle = () => {
      if (root.hasAttribute("data-typing")) root.removeAttribute("data-typing");
    };
    const type = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
      // Only typing in the editing surface counts; a character typed in a dialog's field does not.
      const target = event.target;
      if (target instanceof HTMLElement && target.closest(".cm-editor, .app-rich-surface")) root.setAttribute("data-typing", "");
    };
    window.addEventListener("keydown", type);
    window.addEventListener("mousemove", settle);
    return () => {
      window.removeEventListener("keydown", type);
      window.removeEventListener("mousemove", settle);
      root.removeAttribute("data-typing");
    };
  }, []);
}
