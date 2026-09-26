// Copied from DrDustinEdwards/dustinedwards-info@6e0f8c9 (app/components/admin/md-editor-toolbar.tsx).
// Changed: the Insert image button is gone until media arrives in stage 3.

import type { EditorView } from "@codemirror/view";
import { useState } from "react";

import {
  SCAFFOLDS,
  cycleHeading,
  insertFootnote,
  wrap,
  type ScaffoldName,
} from "./md-editor-commands";
import { moveRovingFocus } from "./roving-focus";

const SCAFFOLD_GLYPHS: Record<ScaffoldName, React.ReactNode> = {
  chart: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  diagram: (
    <>
      <rect x="3" y="4" width="7" height="5" rx="1" />
      <rect x="14" y="15" width="7" height="5" rx="1" />
      <path d="M10 6.5h4a3 3 0 0 1 3 3V15" />
    </>
  ),
  figure: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="m3 14 4-4 5 5" />
      <circle cx="15.5" cy="8.5" r="1.5" />
      <path d="M6 21h12" />
    </>
  ),
};

type Tool = { label: string; hint: string; onClick: () => void; glyph: React.ReactNode };

/**
 * The formatting buttons, the scaffold buttons and the slash hint above the markdown surface. One
 * tab stop for the whole toolbar, arrows between its buttons (the APG toolbar pattern), so a
 * keyboard reader crosses it in one Tab rather than one per button.
 */
export function EditorToolbar({
  run,
  openLinkPalette,
  scaffold,
}: {
  /** Wraps a command so it runs against the mounted view, and does nothing before there is one. */
  run: (fn: (view: EditorView) => void) => () => void;
  openLinkPalette: (view: EditorView) => void;
  scaffold: (name: ScaffoldName) => void;
}) {
  const [active, setActive] = useState(0);

  const tools: Tool[] = [
    {
      label: "Bold",
      hint: "Ctrl or Cmd + B",
      onClick: run((v) => wrap(v, "**")),
      glyph: <path d="M6 4h7a4 4 0 0 1 0 8H6zM6 12h8a4 4 0 0 1 0 8H6z" />,
    },
    {
      label: "Italic",
      hint: "Ctrl or Cmd + I",
      onClick: run((v) => wrap(v, "_")),
      glyph: <path d="M15 4h-5M14 20H9M14 4 10 20" />,
    },
    {
      label: "Link",
      hint: "Ctrl or Cmd + K, searches your posts",
      onClick: run(openLinkPalette),
      glyph: (
        <>
          <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
          <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
        </>
      ),
    },
    {
      label: "Heading level",
      hint: "Cycles h2, h3, h4, none",
      onClick: run(cycleHeading),
      glyph: <path d="M6 4v16M18 4v16M6 12h12" />,
    },
    {
      label: "Code",
      hint: "Ctrl or Cmd + E",
      onClick: run((v) => wrap(v, "`")),
      glyph: <path d="m8 6-6 6 6 6M16 6l6 6-6 6" />,
    },
    {
      label: "Footnote",
      hint: "Reference plus definition",
      onClick: run(insertFootnote),
      glyph: (
        <>
          <path d="M4 6h10M4 12h10M4 18h7" />
          <path d="M18 5v6M21 8h-6" />
        </>
      ),
    },
  ];
  const scaffolds: Tool[] = (Object.keys(SCAFFOLDS) as ScaffoldName[]).map((name) => ({
    label: SCAFFOLDS[name].label,
    hint: SCAFFOLDS[name].hint,
    onClick: () => scaffold(name),
    glyph: SCAFFOLD_GLYPHS[name],
  }));

  const button = (tool: Tool, index: number) => (
    <ToolButton
      key={tool.label}
      label={tool.label}
      hint={tool.hint}
      onClick={tool.onClick}
      tabIndex={index === active ? 0 : -1}
      onFocus={() => setActive(index)}
    >
      {tool.glyph}
    </ToolButton>
  );

  return (
    <div
      className="md-toolbar"
      role="toolbar"
      aria-label="Markdown formatting"
      onKeyDown={(event) => {
        const next = moveRovingFocus(event, ".md-tool");
        if (next !== null) setActive(next);
      }}
    >
      {tools.map((tool, index) => button(tool, index))}
      <span className="md-toolbar-sep" aria-hidden="true" />
      {scaffolds.map((tool, index) => button(tool, tools.length + index))}
      <span className="md-toolbar-hint muted">Type / on an empty line</span>
    </div>
  );
}

function ToolButton({
  label,
  hint,
  onClick,
  tabIndex,
  onFocus,
  children,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  tabIndex: number;
  onFocus: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="md-tool"
      onClick={onClick}
      title={`${label}. ${hint}`}
      tabIndex={tabIndex}
      onFocus={onFocus}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
      <span className="sr-only">{label}</span>
    </button>
  );
}
