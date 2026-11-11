// The editor's layout (Write, Split, Preview), remembered in this browser.

import { useRemembered } from "capsomer/react/hooks";

export type Layout = "write" | "split" | "preview";

const LAYOUT_KEY = "carrel:editor-layout";

export function useEditorLayout(): [Layout, (next: Layout) => void] {
  // Remembered in this browser; Write on the server and the first client paint, so they agree.
  const [stored, remember] = useRemembered(LAYOUT_KEY);
  const layout: Layout = stored === "split" || stored === "preview" ? stored : "write";
  return [layout, remember];
}
