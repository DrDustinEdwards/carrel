// Copied from DrDustinEdwards/dustinedwards-info@6e0f8c9 (app/components/admin/use-link-palette.ts).
// Unchanged. Links go to /blog/<slug>, which is right for dustinedwards.info, the one site in stage 2.

import type { EditorView } from "@codemirror/view";
import { useRef, useState } from "react";

import type { LinkTarget } from "./markdown-editor";

const LINK_RESULT_LIMIT = 8;

export function looksLikeUrl(text: string) {
  return /^(https?:\/\/|mailto:|\/|#)/i.test(text.trim());
}

/**
 * The markdown editor's Cmd+K palette: where it opened, what is typed, which post is highlighted,
 * and the link it writes back into the document.
 */
export function useLinkPalette({
  viewRef,
  host,
  linkTargets,
}: {
  viewRef: React.RefObject<EditorView | null>;
  host: React.RefObject<HTMLDivElement | null>;
  linkTargets: LinkTarget[];
}) {
  // Captured when Cmd+K is pressed, because focus leaves the editor and the selection can move after the blur.
  const [linkAt, setLinkAt] = useState<{
    from: number;
    to: number;
    top: number;
    left: number;
  } | null>(null);
  const [linkQuery, setLinkQuery] = useState("");
  const [linkIndex, setLinkIndex] = useState(0);
  const linkInputRef = useRef<HTMLInputElement>(null);

  const linkMatches = (() => {
    const needle = linkQuery.trim().toLowerCase();
    if (looksLikeUrl(needle)) return [];
    const pool = needle
      ? linkTargets.filter(
          (t) =>
            t.title.toLowerCase().includes(needle) || t.slug.toLowerCase().includes(needle),
        )
      : linkTargets;
    return pool.slice(0, LINK_RESULT_LIMIT);
  })();

  const openLinkPalette = (view: EditorView) => {
    const { from, to } = view.state.selection.main;
    const parent = host.current;
    const coords = view.coordsAtPos(from);
    if (!parent || !coords) return;
    const box = parent.getBoundingClientRect();
    const selected = view.state.sliceDoc(from, to);
    setLinkQuery(selected);
    setLinkIndex(0);
    setLinkAt({ from, to, top: coords.bottom - box.top, left: coords.left - box.left });
  };

  const closeLinkPalette = () => {
    const view = viewRef.current;
    const at = linkAt;
    setLinkAt(null);
    setLinkQuery("");
    setLinkIndex(0);
    if (!view || !at) return;
    view.dispatch({ selection: { anchor: at.from, head: at.to } });
    view.focus();
  };

  // The cursor lands after the link: the next keystroke is almost always the sentence continuing.
  const insertLink = (href: string, fallbackLabel: string) => {
    const view = viewRef.current;
    const at = linkAt;
    if (!view || !at) return;
    const selected = view.state.sliceDoc(at.from, at.to);
    const label = selected || fallbackLabel || href;
    const markdown = `[${label}](${href})`;
    setLinkAt(null);
    setLinkQuery("");
    setLinkIndex(0);
    view.dispatch({
      changes: { from: at.from, to: at.to, insert: markdown },
      selection: { anchor: at.from + markdown.length },
    });
    view.focus();
  };

  const commitLink = () => {
    const typed = linkQuery.trim();
    if (looksLikeUrl(typed)) {
      insertLink(typed, typed);
      return;
    }
    const chosen = linkMatches[linkIndex];
    if (chosen) insertLink(`/blog/${chosen.slug}`, chosen.title);
  };

  return {
    linkAt,
    linkQuery,
    setLinkQuery,
    linkIndex,
    setLinkIndex,
    linkInputRef,
    linkMatches,
    openLinkPalette,
    closeLinkPalette,
    insertLink,
    commitLink,
  };
}
