// Carrel's writing surface: the formatted editor by default (ruling point 3, job_1ba8094853f5), with
// the Markdown kept byte for byte underneath, and "Markdown" beside it, which is Capsomer's Markdown
// editor exactly as before. Both get Carrel's blocks, its link targets and its image upload, set in
// the serif prose layout, with "Insert from library" beside them. The choice is remembered on this
// device. The formatted editor is components/editor/rich-editor.tsx; the Markdown one is Capsomer's.

import { EditorView } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { MarkdownEditor, type LinkTarget } from "capsomer/react/markdown-editor";
import { Segmented } from "capsomer/react/segmented";

import { RichEditor, type RichEditorHandle } from "~/components/editor/rich-editor";
import { LibraryInsert } from "~/components/media/library-insert";
import { uploadImage, type EditorMedia } from "~/components/media/upload";
import type { Dialect } from "~/lib/editor/markdown.mjs";
import { SCAFFOLDS } from "~/lib/site-markdown";

export type { LinkTarget };

type Mode = "formatted" | "markdown";
const MODE_KEY = "carrel:editor-mode";

/** In the Markdown editor: a block at the cursor on a line of its own, as the editor's own blocks are put. */
function insertIntoMarkdown(root: HTMLElement | null, text: string) {
  const dom = root?.querySelector<HTMLElement>(".cm-editor");
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) return;
  const { from, to } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const prefix = line.from === from && line.text.trim() === "" ? "" : "\n\n";
  view.dispatch({ changes: { from, to, insert: `${prefix}${text}` }, selection: { anchor: from + prefix.length + text.length }, scrollIntoView: true });
  view.focus();
}

export function WritingSurface({
  label,
  value,
  onChange,
  readOnly,
  linkTargets,
  media,
  dialect = "site",
}: {
  /** What the surface is called to a screen reader, for example "Post" or "Scene". */
  label: string;
  value: string;
  onChange: (next: string) => void;
  readOnly: boolean;
  linkTargets: LinkTarget[];
  /** The project's media endpoint and the site's figure markup. Absent: no image upload or insert. */
  media?: EditorMedia | null;
  /** A site's Markdown (directives, math) or a book's. */
  dialect?: Dialect;
}) {
  const root = useRef<HTMLDivElement>(null);
  const rich = useRef<RichEditorHandle | null>(null);
  const [mode, setMode] = useState<Mode>("formatted");
  useEffect(() => {
    try {
      if (localStorage.getItem(MODE_KEY) === "markdown") setMode("markdown");
    } catch {
      // Storage refused: the formatted editor, as the default.
    }
  }, []);
  const choose = (next: Mode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // Not remembered, still switched.
    }
  };
  // Never for a Reader, whatever the parent passes: a read-only editor inserts nothing.
  const images = readOnly ? null : (media ?? null);
  // The editor shows the picture it just uploaded at `src` (an address Carrel's page can load), while
  // the Markdown must carry the site's own address, so each upload remembers which is which.
  const sites = useRef(new Map<string, string>());
  const onUpload = images
    ? async (file: File) => {
        const uploaded = await uploadImage(images.endpoint, file);
        sites.current.set(uploaded.src, uploaded.url);
        return { url: uploaded.src };
      }
    : undefined;
  const imageMarkdown = images ? ({ url, alt }: { url: string; alt: string }) => images.figure(sites.current.get(url) ?? url, alt) : undefined;

  return (
    <div className="app-writing" ref={root} data-mode={mode}>
      <div className="app-writing-tools">
        <Segmented
          legend={`Edit ${label.toLowerCase()} as`}
          hideLegend
          size="sm"
          value={mode}
          onChange={choose}
          options={[
            { value: "formatted", label: "Formatted" },
            { value: "markdown", label: "Markdown" },
          ]}
        />
        {images ? <LibraryInsert media={images} insert={(md) => (mode === "formatted" ? rich.current?.insertMarkdown(md) : insertIntoMarkdown(root.current, md))} /> : null}
      </div>
      {mode === "formatted" ? (
        <RichEditor
          ariaLabel={readOnly ? `${label}, formatted, read only` : `${label}, formatted`}
          value={value}
          onChange={onChange}
          readOnly={readOnly}
          dialect={dialect}
          placeholder="Write here."
          scaffolds={SCAFFOLDS}
          linkTargets={linkTargets}
          onUpload={onUpload}
          imageMarkdown={imageMarkdown}
          accept={images?.accept}
          onReady={(handle) => {
            rich.current = handle;
          }}
        />
      ) : (
        <MarkdownEditor
          label={<span className="cap-sr-only">{label}</span>}
          ariaLabel={readOnly ? `${label}, markdown, read only` : `${label}, markdown`}
          value={value}
          onChange={onChange}
          readOnly={readOnly}
          placeholder="Write in markdown."
          scaffolds={SCAFFOLDS}
          linkTargets={linkTargets}
          accept={images?.accept}
          onUpload={onUpload}
          imageMarkdown={imageMarkdown}
        />
      )}
    </div>
  );
}
