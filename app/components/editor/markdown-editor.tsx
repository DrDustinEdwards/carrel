// Copied from DrDustinEdwards/dustinedwards-info@6e0f8c9 (app/components/admin/markdown-editor.tsx).
// Changed: the house theme is now a prose theme (serif, one column); `readOnly` shows a Reader the
// text without letting it change. Image paste, drop and upload came back with the media library in
// stage 3 (from dustinedwards-info@f84b978): they go through Carrel to the site's own storage, only
// when the editor is given `media` (an Editor or the Owner), and From library inserts a file already there.

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef, useState } from "react";

import { MediaPicker } from "~/components/media/media-picker";
import { useImageUpload, type EditorMedia } from "~/components/media/use-image-upload";
import { countWords, minutesForWords } from "~/lib/reading-time.mjs";

import { SCAFFOLDS, insertBlock, wrap, type ScaffoldName } from "./md-editor-commands";
import { EditorToolbar } from "./md-editor-toolbar";
import { moveRovingFocus } from "./roving-focus";
import { looksLikeUrl, useLinkPalette } from "./use-link-palette";

// CodeMirror stays its own chunk because the editor route imports this component lazily.

const proseTheme = EditorView.theme({
  "&": {
    color: "var(--ink)",
    backgroundColor: "var(--paper)",
    fontSize: "1.125rem",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-prose)",
    lineHeight: "1.75",
  },
  ".cm-content": {
    caretColor: "var(--focus)",
    padding: "1.5rem 0 40vh",
    maxWidth: "40rem",
    margin: "0 auto",
  },
  ".cm-line": { padding: "0 1rem" },
  // Inset, because the surface clips overflow: an outside ring would be cut off (2.4.7).
  "&.cm-focused": { outline: "2px solid var(--focus)", outlineOffset: "-2px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--focus)" },
  ".cm-placeholder": { color: "var(--muted)" },
});

const proseHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--ink)", fontWeight: "650" },
  { tag: tags.strong, color: "var(--ink)", fontWeight: "650" },
  { tag: tags.emphasis, color: "var(--ink)", fontStyle: "italic" },
  { tag: tags.link, color: "var(--focus)", textDecoration: "underline" },
  { tag: tags.url, color: "var(--focus)" },
  { tag: tags.monospace, fontFamily: "var(--font-mono)" },
  { tag: tags.quote, color: "var(--muted)", fontStyle: "italic" },
  { tag: tags.list, color: "var(--muted)" },
  { tag: tags.meta, color: "var(--muted)" },
  { tag: tags.processingInstruction, color: "var(--muted)" },
  { tag: tags.contentSeparator, color: "var(--muted)" },
  { tag: tags.strikethrough, color: "var(--muted)", textDecoration: "line-through" },
]);

// `state` lets the palette flag a target that is not live: linking a draft would 404 on the published page.
export type LinkTarget = {
  slug: string;
  title: string;
  state: "published" | "scheduled" | "draft";
};

// Read off the document, not loader data: the root loader re-runs on client navigation and mints a different nonce.
// The IDL property, not getAttribute: browsers hide the attribute after parsing so injected script cannot read it.
function documentCspNonce(): string {
  if (typeof document === "undefined") return "";
  return document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce ?? "";
}

export default function MarkdownEditor({
  value,
  onChange,
  onReady,
  slug,
  placeholder,
  linkTargets = [],
  readOnly = false,
  media,
}: {
  value: string;
  onChange: (next: string) => void;
  onReady: () => void;
  slug: string;
  placeholder?: string;
  linkTargets?: LinkTarget[];
  readOnly?: boolean;
  /** The project's media endpoint and the site's figure markup. Absent: no image upload or insert. */
  media?: EditorMedia;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // React 19 renders a lazy component during SSR, so the chrome waits for mount or a no-script reader gets a dead toolbar.
  const [ready, setReady] = useState(false);
  const [slashAt, setSlashAt] = useState<{ from: number; top: number; left: number } | null>(null);
  // Read by the keymap, which is built once and would otherwise see the first render's null.
  const slashOpenRef = useRef(false);
  slashOpenRef.current = slashAt !== null;
  const slashRef = useRef<HTMLUListElement>(null);
  // Never for a Reader, whatever the parent passes: a read-only editor inserts nothing.
  const imageMedia = readOnly ? undefined : media;
  const fileRef = useRef<HTMLInputElement>(null);
  const altRef = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const { upload, setUpload, uploadError, alt, setAlt, uploadFile, pickExisting, insertFigure } = useImageUpload(viewRef, imageMedia);
  // Read by the paste and drop handlers, which are built once.
  const uploadRef = useRef(uploadFile);
  uploadRef.current = uploadFile;

  const [stats, setStats] = useState(() => {
    const words = countWords(value);
    return { words, minutes: minutesForWords(words) };
  });

  const {
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
  } = useLinkPalette({ viewRef, host, linkTargets });

  useEffect(() => {
    const parent = host.current;
    if (!parent || viewRef.current) return;

    const extensions: Extension[] = [
      // Without the nonce the CSP drops every injected style, CodeMirror's base theme and the prose theme included.
      EditorView.cspNonce.of(documentCspNonce()),
      history(),
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(proseHighlight),
      proseTheme,
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      // The label on the hidden textarea does not reach this surface, which is what has focus (4.1.2).
      EditorView.contentAttributes.of({ "aria-label": readOnly ? "Post, markdown, read only" : "Post, markdown" }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const text = update.state.doc.toString();
          onChangeRef.current(text);
          // Counted from the document, not the parent's copy, so the number cannot lag a keystroke.
          const words = countWords(text);
          setStats((prev) =>
            prev.words === words ? prev : { words, minutes: minutesForWords(words) },
          );
        }
        if (!readOnly && (update.docChanged || update.selectionSet)) {
          // Only a lone "/" at line end: markdown is full of slashes, and a menu opening inside a URL would be unusable.
          const { head } = update.state.selection.main;
          const line = update.state.doc.lineAt(head);
          if (line.text === "/" && head === line.to) {
            const coords = update.view.coordsAtPos(line.from);
            const box = parent.getBoundingClientRect();
            setSlashAt(
              coords
                ? { from: line.from, top: coords.bottom - box.top, left: coords.left - box.left }
                : null,
            );
          } else {
            setSlashAt(null);
          }
        }
      }),
      ...(imageMedia
        ? [
            EditorView.domEventHandlers({
              paste(event, view) {
                const item = [...(event.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
                const file = item?.getAsFile();
                if (!file) return false;
                event.preventDefault();
                viewRef.current = view;
                void uploadRef.current(file);
                return true;
              },
              drop(event, view) {
                const file = [...(event.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
                if (!file) return false;
                event.preventDefault();
                viewRef.current = view;
                void uploadRef.current(file);
                return true;
              },
            }),
          ]
        : []),
      keymap.of([
        { key: "Mod-b", run: (v) => (wrap(v, "**"), true) },
        { key: "Mod-i", run: (v) => (wrap(v, "_"), true) },
        { key: "Mod-k", run: (v) => (openLinkPalette(v), true) },
        { key: "Mod-e", run: (v) => (wrap(v, "`"), true) },
        // No Mod-s here: the editor shell owns Cmd+S, since it knows which transition the primary button is armed for.
        { key: "Escape", run: () => (setSlashAt(null), false) },
        // Down from the "/" line enters the block menu, which is otherwise reachable only by mouse.
        {
          key: "ArrowDown",
          run: () => {
            if (!slashOpenRef.current) return false;
            slashRef.current?.querySelector<HTMLElement>(".md-slash-item")?.focus();
            return true;
          },
        },
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      cmPlaceholder(placeholder ?? "Write in markdown."),
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent,
    });
    viewRef.current = view;
    setReady(true);
    onReady();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mounted once: `value` is only the initial document, and re-running would rebuild the editor and lose the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Guarded on the text differing, or every keystroke would round-trip through the parent and reset the selection.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  // Focus goes to the alt field once the file is on the site: the prompt is otherwise silent, and the
  // figure cannot be inserted until it is answered.
  const uploadedUrl = upload?.url ?? "";
  useEffect(() => {
    if (uploadedUrl) altRef.current?.focus();
  }, [uploadedUrl]);

  const run = (fn: (view: EditorView) => void) => () => {
    const view = viewRef.current;
    if (view) fn(view);
  };

  const scaffold = (name: ScaffoldName, replaceSlash?: number) => {
    const view = viewRef.current;
    if (!view) return;
    const s = SCAFFOLDS[name];
    if (replaceSlash !== undefined) {
      const line = view.state.doc.lineAt(replaceSlash);
      view.dispatch({ changes: { from: line.from, to: line.to, insert: "" } });
    }
    setSlashAt(null);
    insertBlock(view, s.text, s.cursor);
  };

  return (
    <div className="md-editor">
      {ready && !readOnly ? (
        <EditorToolbar
          run={run}
          openLinkPalette={openLinkPalette}
          scaffold={scaffold}
          pickImage={imageMedia ? () => fileRef.current?.click() : undefined}
          pickFromLibrary={imageMedia ? () => setPicking(true) : undefined}
        />
      ) : null}

      {imageMedia ? (
        <input
          ref={fileRef}
          type="file"
          accept={imageMedia.accept}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void uploadFile(file);
          }}
        />
      ) : null}

      {imageMedia && picking ? (
        <MediaPicker
          endpoint={imageMedia.endpoint}
          onPick={(picked) => {
            setPicking(false);
            pickExisting(picked);
          }}
          onCancel={() => {
            setPicking(false);
            viewRef.current?.focus();
          }}
        />
      ) : null}

      <div className="md-surface" ref={host} />

      {ready ? (
        <div className="md-foot">
          {/* Not a live region: it changes constantly, and announcing each change would make the
              editor unusable with a screen reader. */}
          <p className="md-stats">
            {stats.words.toLocaleString()} word{stats.words === 1 ? "" : "s"}
            {stats.words > 0 ? (
              <>
                <span className="md-stats-sep" aria-hidden="true">
                  ·
                </span>
                {stats.minutes} min read
              </>
            ) : null}
          </p>
        </div>
      ) : null}

      {/* Searches the site's own posts: the common link is to another post, and the author knows
          its title rather than its slug. */}
      {linkAt ? (
        <div
          className="md-link-palette"
          style={{ top: `${linkAt.top}px`, left: `${linkAt.left}px` }}
        >
          <input
            ref={linkInputRef}
            autoFocus
            type="text"
            className="md-link-input"
            value={linkQuery}
            placeholder="Search posts, or type a URL"
            aria-label="Search posts to link to, or type a URL"
            role="combobox"
            aria-expanded={linkMatches.length > 0}
            // Only while the list exists: an id that resolves to nothing is a broken reference.
            aria-controls={linkMatches.length > 0 ? "md-link-list" : undefined}
            aria-activedescendant={
              linkMatches[linkIndex] ? `md-link-opt-${linkMatches[linkIndex].slug}` : undefined
            }
            onChange={(event) => {
              setLinkQuery(event.target.value);
              setLinkIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setLinkIndex((i) => (linkMatches.length ? (i + 1) % linkMatches.length : 0));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setLinkIndex((i) =>
                  linkMatches.length ? (i - 1 + linkMatches.length) % linkMatches.length : 0,
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                commitLink();
              } else if (event.key === "Escape") {
                // Stopped as well as prevented, or the Escape bubbles to the shell and closes other things.
                event.preventDefault();
                event.stopPropagation();
                closeLinkPalette();
              }
            }}
            onBlur={(event) => {
              if (event.relatedTarget instanceof HTMLElement &&
                  event.relatedTarget.closest(".md-link-palette")) {
                return;
              }
              closeLinkPalette();
            }}
          />

          {looksLikeUrl(linkQuery) ? (
            <p className="md-link-note">Enter to link to this address</p>
          ) : linkMatches.length > 0 ? (
            <ul id="md-link-list" className="md-link-list" role="listbox" aria-label="Posts">
              {linkMatches.map((target, index) => (
                <li key={target.slug}>
                  <button
                    type="button"
                    id={`md-link-opt-${target.slug}`}
                    role="option"
                    aria-selected={index === linkIndex}
                    className="md-link-item"
                    data-active={index === linkIndex ? "" : undefined}
                    onMouseEnter={() => setLinkIndex(index)}
                    onClick={() => insertLink(`/blog/${target.slug}`, target.title)}
                  >
                    <strong>{target.title}</strong>
                    <span className="muted">
                      /blog/{target.slug}
                      {/* In words inside the option text, so a screen reader announces it, not just a color. */}
                      {target.state !== "published" ? (
                        <span className="md-link-state"> not live yet ({target.state})</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="md-link-note">No posts match. Type a URL to link out.</p>
          )}
        </div>
      ) : null}

      {slashAt ? (
        /* Plain buttons, not a listbox: nothing here is selected, each one acts. Down from the
           editor enters it, Up and Down move, Escape returns to the text. */
        <ul
          ref={slashRef}
          className="md-slash"
          style={{ top: `${slashAt.top}px`, left: `${slashAt.left}px` }}
          aria-label="Insert a block"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setSlashAt(null);
              viewRef.current?.focus();
              return;
            }
            moveRovingFocus(event, ".md-slash-item", "vertical");
          }}
        >
          {(Object.keys(SCAFFOLDS) as ScaffoldName[]).map((name) => (
            <li key={name}>
              <button
                type="button"
                className="md-slash-item"
                onClick={() => scaffold(name, slashAt.from)}
              >
                <strong>{SCAFFOLDS[name].label}</strong>
                <span className="muted">{SCAFFOLDS[name].hint}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* An alert, read on insertion: a failed upload is an event the author has to act on. */}
      {uploadError ? (
        <p className="alarm" role="alert">
          {uploadError}
        </p>
      ) : null}

      {/* Always in the DOM, so the region exists before its text does. */}
      <p className="sr-only" role="status">
        {upload && !upload.url ? `Uploading ${upload.name}` : ""}
      </p>

      {upload ? (
        <div className="md-upload" role="group" aria-label="Describe the image">
          {upload.url ? <img src={upload.src} alt="" className="md-upload-thumb" /> : <span className="muted">Uploading {upload.name}</span>}
          <div className="md-upload-fields">
            <label className="md-upload-label" htmlFor="md-upload-alt">
              Alt text, required
            </label>
            <input
              id="md-upload-alt"
              ref={altRef}
              value={alt}
              onChange={(event) => setAlt(event.target.value)}
              placeholder="What the image shows"
              autoComplete="off"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  insertFigure();
                }
              }}
            />
            <div className="md-upload-actions">
              {/* Blocked until alt exists: an image inserted without alt is the one that ships without it. */}
              <button type="button" className="btn" disabled={!upload.url || alt.trim() === ""} onClick={insertFigure}>
                Insert figure
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setUpload(null);
                  setAlt("");
                  viewRef.current?.focus();
                }}
              >
                Cancel
              </button>
            </div>
            {upload.url && alt.trim() === "" ? (
              <p className="alarm">The image is on the site. It is not in the post until it has alt text.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      <p className="sr-only" aria-live="polite">
        {slug ? `Editing ${slug}` : "Editing a new post"}
      </p>
    </div>
  );
}
