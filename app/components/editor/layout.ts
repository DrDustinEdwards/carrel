// The editor's layout (Write, Split, Preview), remembered in this browser.

import { useEffect, useState } from "react";

export type Layout = "write" | "split" | "preview";

const LAYOUT_KEY = "carrel:editor-layout";

export function useEditorLayout(): [Layout, (next: Layout) => void] {
  const [layout, setLayout] = useState<Layout>("write");
  // Remembered in this browser; read after mount so the server and the first client paint agree.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LAYOUT_KEY);
      if (stored === "write" || stored === "split" || stored === "preview") setLayout(stored);
    } catch {
      // Storage disabled: Write, the default.
    }
  }, []);
  const chooseLayout = (next: Layout) => {
    setLayout(next);
    try {
      window.localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // As above.
    }
  };
  return [layout, chooseLayout];
}
