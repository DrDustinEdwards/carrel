// The formatted editor (ruling point 3): Tiptap's MIT core over ProseMirror, showing
// formatted text with the Markdown underneath kept byte for byte (lib/editor/markdown.mjs). It keeps
// what the Markdown editor did: the APG toolbar (bold, italic, link, heading, code, footnote, the app's
// blocks, an image), Ctrl or Cmd B, I, E, K and S, the link palette over the app's pages, the block
// menu on a lone "/", an image described before it is uploaded, the word count and
// reading time, read-only, and Tab leaving the text. Markdown the editor does not format (front
// matter, code, tables, directives, math) sits in source blocks, edited as Markdown in place.
//
// The server renders a labeled textarea holding the Markdown, so the page reads the same before the
// script runs; the editor replaces it once it loads.
//
// In a file's room (`room`), the document is the room's shared copy, bound by Tiptap's Collaboration
// extension, with the others' carets, suggesting and the comment marks (room-extensions.ts). The
// Markdown is then the room's to work out (use-room.ts), and `value` only feeds the word count.

import { disableSuggestChanges, enableSuggestChanges, isSuggestChangesEnabled } from "@handlewithcare/prosemirror-suggest-changes";
import { Editor, type JSONContent } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { Placeholder } from "@tiptap/extensions";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { useEffect, useRef, useState } from "react";
import { countWords, filterLinkTargets, looksLikeUrl, minutesForWords, type ImageDescription, type LinkTarget, type Scaffold } from "capsomer/behavior/markdown-editor";
import { place } from "capsomer/behavior/popover";

import { FRAGMENT, markdownOf } from "~/lib/editor/collab";
import { fingerprints, fromDoc, pastedBlocks, toDoc, type Dialect, type JsonNode } from "~/lib/editor/markdown.mjs";
import { baseExtensions } from "~/lib/editor/schema.mjs";
import type { JsonDoc, Suggester } from "~/lib/editor/suggest";

import { commentMarks, commentsKey, refreshCarets, roomCarets, suggesting, type Anchored, type Who } from "./room-extensions";
import { sourceBlockView, SourceInlineView } from "./source-views";
import { GLYPH, Icon } from "./toolbar-icons";

export type RichEditorHandle = {
  /** Puts Markdown (a figure, an image) in as blocks at the cursor, as the editor's own blocks are put. */
  insertMarkdown: (markdown: string) => void;
  focus: () => void;
  /** The editor itself, for the room's panels (comments, suggestions). */
  editor: Editor;
};

/** The room an editor is in (use-room.ts), and what this person does in it. */
export type RichRoom = {
  doc: Y.Doc;
  awareness: Awareness;
  /** Each caret's person, from the room's own list. */
  who: Who;
  /** Changes when the room's list of people does, so the carets are drawn again. */
  peopleKey: string;
  suggester: Suggester;
  /** Typing makes suggestions. Always, for someone who may only suggest. */
  suggest: boolean;
  threads: Anchored[];
  activeThread: string | null;
  onThreadClick: (id: string) => void;
  /** A post's front matter is edited in its fields, so the text does not show it a second time. */
  hideFrontMatter: boolean;
};

export type RichEditorProps = {
  /** What the editing surface is called to a screen reader, for example "Post, formatted". */
  ariaLabel: string;
  value: string;
  onChange: (next: string) => void;
  readOnly: boolean;
  dialect: Dialect;
  placeholder?: string;
  scaffolds?: Scaffold[];
  linkTargets?: LinkTarget[];
  /** Called once the image is described, as Capsomer's markdown editor calls it. */
  onUpload?: (file: File, image: ImageDescription, signal: AbortSignal) => Promise<{ url: string }>;
  imageMarkdown?: (image: { url: string; alt: string; decorative: boolean; name: string }) => string;
  accept?: string;
  onReady?: (handle: RichEditorHandle) => void;
  room?: RichRoom;
};

// An empty alt is a decorative pick; Prelum reads ![""](x) as decorative and refuses ![](x).
const defaultImage = ({ url, alt }: { url: string; alt: string }) => `![${alt.replace(/[[\]]/g, "").trim() || '""'}](${url})`;

type Palette = { from: number; to: number; query: string; active: number };
// An image is described before it is sent (ATAG 2.0 B.2.3; site-api 0.19+ refuses an undescribed
// upload): the step holds the file and a local preview until Insert, then sends it once.
type Upload = { file: File; preview: string; sending: AbortController | null } | null;

export function RichEditor(props: RichEditorProps) {
  const { ariaLabel, value, readOnly, dialect, placeholder = "Write here.", scaffolds = [], linkTargets = [], onUpload, accept, room } = props;
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const origin = useRef<{ tail: string; prints: Map<number, string>; last: string }>({ tail: "", prints: new Map(), last: value });
  const propsRef = useRef(props);
  propsRef.current = props;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const [ready, setReady] = useState(false);
  const [words, setWords] = useState(() => countWords(value));
  const [palette, setPalette] = useState<Palette | null>(null);
  const [slash, setSlash] = useState<number | null>(null);
  const [upload, setUploadState] = useState<Upload>(null);
  const uploadRef = useRef<Upload>(null);
  const setUpload = (next: Upload) => {
    uploadRef.current?.sending?.abort();
    uploadRef.current = next;
    setUploadState(next);
  };
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [alt, setAlt] = useState("");
  const [said, say] = useState("");
  const [activeTool, setActiveTool] = useState(0);
  const toolbar = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const slashRef = useRef<HTMLUListElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const altRef = useRef<HTMLInputElement>(null);

  /** The Markdown the document stands for: unchanged blocks as their bytes, the rest spelled again. */
  const markdown = (editor: Editor) =>
    room ? markdownOf(room.doc, editor.getJSON() as JsonDoc) : fromDoc(editor.getJSON() as JsonNode, origin.current.tail, origin.current.prints, dialect);
  const roomRef = useRef(room);
  roomRef.current = room;
  /** Source blocks are Markdown, which a suggestion cannot mark: while suggesting they are read only. */
  const sourceLocked = () => readOnlyRef.current || Boolean(editorRef.current && isSuggestChangesEnabled(editorRef.current.state));

  const load = (editor: Editor, source: string) => {
    const loaded = toDoc(source, dialect);
    const doc = editor.schema.nodeFromJSON(loaded.doc);
    // Not an edit: no undo step, and no change reported.
    editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content).setMeta("addToHistory", false).setMeta("preventUpdate", true));
    origin.current = { tail: loaded.tail, prints: fingerprints(editor.getJSON() as JsonNode), last: source };
    setWords(countWords(source));
  };

  // The editor itself: made once, after the page is in the browser.
  useEffect(() => {
    if (!host.current) return;
    const loaded = toDoc(value, dialect);
    const inRoom = roomRef.current;
    const editor = new Editor({
      element: host.current,
      extensions: [
        ...baseExtensions({ room: Boolean(inRoom) }).filter((e) => e.name !== "sourceBlock" && e.name !== "sourceInline"),
        sourceBlockView(sourceLocked),
        SourceInlineView,
        Placeholder.configure({ placeholder }),
        ...(inRoom
          ? [
              Collaboration.configure({ document: inRoom.doc, field: FRAGMENT }),
              roomCarets(inRoom.awareness, () => roomRef.current!.who),
              suggesting(inRoom.suggester),
              commentMarks(() => ({ threads: roomRef.current!.threads, active: roomRef.current!.activeThread })),
            ]
          : []),
      ],
      // In a room the content is the room's.
      ...(inRoom ? {} : { content: loaded.doc as JSONContent }),
      editable: !readOnly,
      // Carrel's CSP takes no inline styles: Tiptap's base rules are in app.css instead.
      injectCSS: false,
      editorProps: {
        attributes: {
          class: "app-rich-surface",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": ariaLabel,
          "aria-placeholder": placeholder,
          spellcheck: "true",
        },
        handleClickOn: (_view, _pos, _node, _nodePos, event) => {
          const mark = (event.target as HTMLElement | null)?.closest?.("[data-comment]");
          if (mark && roomRef.current) roomRef.current.onThreadClick(mark.getAttribute("data-comment")!);
          return false;
        },
        handleKeyDown: (_view, event) => {
          const mod = event.ctrlKey || event.metaKey;
          if (mod && event.key.toLowerCase() === "s") return true; // The page's own Ctrl+S saves; the browser's never opens.
          if (mod && event.key.toLowerCase() === "k") {
            openPalette();
            return true;
          }
          if (event.key === "ArrowDown" && slashOpen.current) {
            slashRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
            return true;
          }
          if (event.key === "Escape" && slashOpen.current) {
            setSlash(null);
            return true;
          }
          return false;
        },
        handlePaste: (_view, event) => {
          const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
          if (files[0] && propsRef.current.onUpload) {
            void startUpload(files[0]);
            return true;
          }
          // Markdown pasted as text becomes formatted blocks, as typing it in Markdown did.
          const html = event.clipboardData?.getData("text/html");
          const text = event.clipboardData?.getData("text/plain");
          if (!html && text && /\n|^#{1,6} |^[-*+] |^\d+\. |^> |[*_`[]/.test(text)) {
            const blocks = pastedBlocks(text, dialect);
            const single = blocks.length === 1 && blocks[0]!.type === "paragraph";
            editorRef.current?.commands.insertContent(single ? (blocks[0]!.content ?? []) : blocks);
            return true;
          }
          return false;
        },
        handleDrop: (_view, event) => {
          const files = [...((event as DragEvent).dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
          if (files[0] && propsRef.current.onUpload) {
            event.preventDefault();
            void startUpload(files[0]);
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: e }) => {
        syncSlash(e);
        // In a room, the room works out the Markdown for everyone, and `value` brings it back.
        if (roomRef.current) return;
        const md = markdown(e);
        origin.current.last = md;
        setWords(countWords(md));
        propsRef.current.onChange(md);
        syncSlash(e);
      },
      onSelectionUpdate: ({ editor: e }) => syncSlash(e),
    });
    origin.current = { tail: loaded.tail, prints: fingerprints(editor.getJSON() as JsonNode), last: value };
    editorRef.current = editor;
    if (inRoom?.suggest) enableSuggestChanges(editor.state, editor.view.dispatch);
    setReady(true);
    propsRef.current.onReady?.({ insertMarkdown, focus: () => editor.commands.focus(), editor });
    return () => {
      editor.destroy();
      editorRef.current = null;
    };
    // Made once; later values come in through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new value from outside (a discarded draft, an AI draft taken as the working copy) is loaded. In a
  // room, a replacement arrives through the room itself, and the value is only counted.
  useEffect(() => {
    const editor = editorRef.current;
    if (room) setWords(countWords(value));
    else if (editor && value !== origin.current.last) load(editor, value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Suggesting on or off, as the person chooses (always on for someone who may only suggest).
  const suggestOn = room?.suggest ?? false;
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !roomRef.current) return;
    if (suggestOn !== isSuggestChangesEnabled(editor.state)) (suggestOn ? enableSuggestChanges : disableSuggestChanges)(editor.state, editor.view.dispatch);
  }, [suggestOn, ready]);

  // The room's list of people changed: the carets are drawn again under the names it gives.
  const peopleKey = room?.peopleKey;
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && peopleKey !== undefined) editor.view.dispatch(refreshCarets(editor.state));
  }, [peopleKey]);

  // The threads or the open one changed: their marks are drawn again.
  const threadsKey = room ? `${room.activeThread}|${room.threads.map((t) => `${t.id}:${t.anchor}`).join(",")}` : "";
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && roomRef.current) editor.view.dispatch(editor.state.tr.setMeta(commentsKey, true).setMeta("addToHistory", false));
  }, [threadsKey]);

  useEffect(() => {
    editorRef.current?.setEditable(!readOnly, false);
  }, [readOnly]);

  // ---- the block menu on a lone "/"
  const slashOpen = useRef(false);
  slashOpen.current = slash !== null;
  function syncSlash(editor: Editor) {
    const { $from, empty: collapsed } = editor.state.selection;
    const lone = collapsed && !readOnlyRef.current && scaffolds.length > 0 && $from.depth === 1 && $from.parent.type.name === "paragraph" && $from.parent.textContent === "/" && $from.parentOffset === 1;
    setSlash(lone ? $from.before() : null);
  }
  useEffect(() => {
    const menu = slashRef.current;
    const editor = editorRef.current;
    if (!menu || !editor || slash === null) return;
    menu.showPopover?.();
    const at = editor.view.coordsAtPos(slash + 1);
    place({ getBoundingClientRect: () => new DOMRect(at.left, at.top, 0, at.bottom - at.top) } as Element, menu, { side: "bottom", align: "start" });
    say("Block menu open. Press Down arrow to choose a block, Escape to close.");
    return () => {
      try {
        menu.hidePopover?.();
      } catch {
        // Already closed.
      }
    };
  }, [slash]);

  function insertScaffold(s: Scaffold, fromSlash: boolean) {
    const editor = editorRef.current;
    if (!editor) return;
    const block = { type: "sourceBlock", attrs: { text: s.text, kind: s.label } };
    const chain = editor.chain().focus();
    if (fromSlash && slash !== null) chain.insertContentAt({ from: slash, to: slash + editor.state.doc.nodeAt(slash)!.nodeSize }, block).run();
    else chain.insertContent(block).run();
    setSlash(null);
    focusSourceBlock(editor, s);
  }

  /** Focus lands inside the new block's Markdown, where the block says (for example inside alt=""). */
  function focusSourceBlock(editor: Editor, s: Scaffold) {
    requestAnimationFrame(() => {
      const areas = [...editor.view.dom.querySelectorAll<HTMLTextAreaElement>(".app-src-text")];
      const area = areas.find((a) => a.value === s.text && document.activeElement !== a) ?? areas.at(-1);
      if (!area) return;
      area.focus();
      const at = s.cursorAfter ? s.text.indexOf(s.cursorAfter) + s.cursorAfter.length : (s.cursor ?? s.text.length);
      area.setSelectionRange(at, at);
    });
  }

  function insertMarkdown(md: string) {
    const editor = editorRef.current;
    if (!editor) return;
    editor.chain().focus().insertContent(pastedBlocks(md, dialect) as JSONContent[]).run();
  }

  // ---- the link palette
  function openPalette() {
    const editor = editorRef.current;
    if (!editor || readOnlyRef.current) return;
    const { from, to } = editor.state.selection;
    setSlash(null);
    setPalette({ from, to, query: editor.state.doc.textBetween(from, to, " "), active: 0 });
  }
  useEffect(() => {
    const panel = paletteRef.current;
    const editor = editorRef.current;
    if (!panel || !editor || !palette) return;
    panel.showPopover?.();
    const at = editor.view.coordsAtPos(palette.from);
    place({ getBoundingClientRect: () => new DOMRect(at.left, at.top, 0, at.bottom - at.top) } as Element, panel, { side: "bottom", align: "start" });
    panel.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      try {
        panel.hidePopover?.();
      } catch {
        // Already closed.
      }
    };
    // Opened once per palette; typing in it does not move it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette !== null]);
  const matches = palette ? filterLinkTargets(linkTargets, palette.query) : [];
  const typedUrl = palette && looksLikeUrl(palette.query) ? palette.query.trim() : null;
  function closePalette(restore: boolean) {
    const editor = editorRef.current;
    const p = palette;
    setPalette(null);
    if (editor && p && restore) editor.chain().focus().setTextSelection({ from: p.from, to: p.to }).run();
  }
  function applyLink(href: string, title: string) {
    const editor = editorRef.current;
    const p = palette;
    setPalette(null);
    if (!editor || !p) return;
    const chain = editor.chain().focus().setTextSelection({ from: p.from, to: p.to });
    if (p.from === p.to) chain.insertContent({ type: "text", text: title, marks: [{ type: "link", attrs: { href } }] }).run();
    else chain.setLink({ href }).run();
    // The cursor lands after the link, outside it.
    editor.commands.unsetMark("link", { extendEmptyMarkRange: false });
  }

  // ---- images: described, then sent, then in the text
  function startUpload(file: File) {
    if (!propsRef.current.onUpload) return;
    setUploadError(null);
    setAlt("");
    // A data: URL, not blob:, so the preview needs nothing Desk's img-src does not already allow.
    const next: NonNullable<Upload> = { file, preview: "", sending: null };
    setUpload(next);
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (uploadRef.current === next && typeof reader.result === "string") {
        const shown = { ...next, preview: reader.result };
        uploadRef.current = shown;
        setUploadState(shown);
      }
    });
    reader.readAsDataURL(file);
    say(`Describe ${file.name} to insert it.`);
    requestAnimationFrame(() => altRef.current?.focus());
  }
  function cancelUpload() {
    setUpload(null);
    setUploadError(null);
    editorRef.current?.commands.focus();
  }
  async function insertImage(decorative: boolean) {
    const current = uploadRef.current;
    const send = propsRef.current.onUpload;
    const text = decorative ? "" : alt.trim();
    if (!current || current.sending || !send || (!decorative && !text)) return;
    const sending = new AbortController();
    const busy = { ...current, sending };
    uploadRef.current = busy;
    setUploadState(busy);
    setUploadError(null);
    say(`Uploading ${current.file.name}`);
    try {
      const { url } = await send(current.file, { alt: text, decorative }, sending.signal);
      if (uploadRef.current !== busy) return;
      const md = (propsRef.current.imageMarkdown ?? defaultImage)({ url, alt: text, decorative, name: current.file.name });
      uploadRef.current = null;
      setUploadState(null);
      insertMarkdown(md);
      say("Image inserted.");
    } catch (error) {
      if (uploadRef.current !== busy) return;
      // The step stays, with what was typed, so a retry is one press.
      const kept = { ...current, sending: null };
      uploadRef.current = kept;
      setUploadState(kept);
      setUploadError(error instanceof Error ? error.message : "The upload failed.");
      say("");
    }
  }

  // ---- the toolbar
  const run = (fn: (e: Editor) => void) => () => {
    const editor = editorRef.current;
    if (editor) fn(editor);
  };
  const tools = [
    { id: "bold", label: "Bold", hint: "Ctrl or Cmd + B", keys: "Control+B Meta+B", paths: GLYPH.bold, run: run((e) => e.chain().focus().toggleBold().run()) },
    { id: "italic", label: "Italic", hint: "Ctrl or Cmd + I", keys: "Control+I Meta+I", paths: GLYPH.italic, run: run((e) => e.chain().focus().toggleItalic().run()) },
    { id: "link", label: "Link", hint: "Ctrl or Cmd + K, searches pages", keys: "Control+K Meta+K", paths: GLYPH.link, run: openPalette },
    {
      id: "heading",
      label: "Heading level",
      hint: "Cycles h2, h3, h4, none",
      paths: GLYPH.heading,
      run: run((e) => {
        const level = e.isActive("heading", { level: 2 }) ? 3 : e.isActive("heading", { level: 3 }) ? 4 : e.isActive("heading", { level: 4 }) ? 0 : 2;
        if (level === 0) e.chain().focus().setParagraph().run();
        else e.chain().focus().setHeading({ level: level as 2 | 3 | 4 }).run();
      }),
    },
    { id: "code", label: "Code", hint: "Ctrl or Cmd + E", keys: "Control+E Meta+E", paths: GLYPH.code, run: run((e) => e.chain().focus().toggleCode().run()) },
    {
      id: "footnote",
      label: "Footnote",
      hint: "A reference and its definition",
      paths: GLYPH.footnote,
      run: run((e) => {
        const md = markdown(e);
        const n = Math.max(0, ...[...md.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1]))) + 1;
        e.chain().focus().insertContent({ type: "sourceInline", attrs: { text: `[^${n}]` } }).run();
        const end = e.state.doc.content.size;
        e.chain().insertContentAt(end, { type: "sourceBlock", attrs: { text: `[^${n}]: `, kind: "Footnote" } }).run();
        focusSourceBlock(e, { id: "footnote", label: "Footnote", hint: "", text: `[^${n}]: ` });
      }),
    },
    ...(onUpload ? [{ id: "image", label: "Insert image", hint: "Asks for alt text, then uploads the file", paths: GLYPH.image, run: () => fileRef.current?.click() }] : []),
  ];
  const blocks = scaffolds.map((s) => ({ id: `scaffold-${s.id}`, label: s.label, hint: s.hint, keys: undefined, paths: s.icon ? [s.icon] : [], glyph: s.label.slice(0, 1), run: () => insertScaffold(s, false) }));
  const all = [...tools, ...blocks];
  const onToolbarKey = (event: React.KeyboardEvent) => {
    const buttons = [...(toolbar.current?.querySelectorAll<HTMLButtonElement>(".cap-md-tool:not(:disabled)") ?? [])];
    const at = buttons.findIndex((b) => b === document.activeElement);
    const next = event.key === "ArrowRight" ? (at + 1) % buttons.length : event.key === "ArrowLeft" ? (at - 1 + buttons.length) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
    if (next === null || at < 0) return;
    event.preventDefault();
    buttons[next]?.focus();
  };
  const off = readOnly || !ready;

  return (
    <div className="cap-md app-rich" data-ready={ready ? "" : undefined} data-hide-front={room?.hideFrontMatter ? "" : undefined}>
      <div className="cap-md-frame">
        <div className="cap-md-toolbar" role="toolbar" aria-label="Formatting" ref={toolbar} onKeyDown={onToolbarKey}>
          {all.map((t, i) => (
            <span key={t.id} className="app-tool-slot">
              {i === tools.length && blocks.length > 0 ? <span className="cap-md-sep" aria-hidden="true" /> : null}
              <button
                type="button"
                className="cap-md-tool"
                aria-label={t.label}
                title={`${t.label}. ${t.hint}`}
                aria-keyshortcuts={t.keys}
                tabIndex={i === activeTool ? 0 : -1}
                disabled={off}
                onFocus={() => setActiveTool(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={t.run}
              >
                {t.paths.length > 0 ? (
                  <Icon paths={t.paths} />
                ) : (
                  <span className="cap-md-tool-glyph" aria-hidden="true">
                    {"glyph" in t ? String(t.glyph) : ""}
                  </span>
                )}
              </button>
            </span>
          ))}
          {blocks.length > 0 ? <span className="cap-md-toolbar-hint">Type / on an empty line</span> : null}
        </div>
        {!ready ? (
          // Before the script: the Markdown itself, readable and selectable.
          <textarea className="cap-input cap-md-source" aria-label={ariaLabel} value={value} readOnly rows={12} />
        ) : null}
        <div ref={host} className="cap-md-surface app-rich-host" hidden={!ready} />
        <div className="cap-md-foot">
          {onUpload ? (
            <p className="cap-md-hint" aria-hidden="true">
              <Icon paths={GLYPH.image} />
              Drop or paste an image to upload it
            </p>
          ) : null}
          <p className="cap-md-stats">
            <span className="cap-md-count">
              {words.toLocaleString("en")} word{words === 1 ? "" : "s"}
              {words > 0 ? ` · ${minutesForWords(words)} min read` : ""}
            </span>
          </p>
        </div>
      </div>
      <p className="cap-sr-only" role="status">
        {said}
      </p>
      {onUpload ? (
        <input
          ref={fileRef}
          type="file"
          hidden
          tabIndex={-1}
          accept={accept}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void startUpload(f);
          }}
        />
      ) : null}
      {upload ? (
        <div
          className="cap-md-upload"
          role="group"
          aria-label="Describe the image"
          aria-busy={upload.sending ? "true" : undefined}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancelUpload();
            }
          }}
        >
          <img className="cap-md-upload-thumb" src={upload.preview || undefined} alt="" />
          <div className="cap-md-upload-fields">
            <label className="cap-field-label" htmlFor="rich-alt">
              Alt text{" "}
              <span className="cap-field-required" aria-hidden="true">
                Required
              </span>
            </label>
            <input
              ref={altRef}
              id="rich-alt"
              className="cap-input"
              autoComplete="off"
              placeholder="What the image shows"
              aria-describedby="rich-alt-help"
              value={alt}
              readOnly={Boolean(upload.sending)}
              onChange={(e) => setAlt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void insertImage(false);
                }
              }}
            />
            <p className="cap-field-help" id="rich-alt-help">
              Describe {upload.file.name} for a person who cannot see it, or insert it as decorative if it adds nothing. It is uploaded when you insert it.
            </p>
            {upload.sending ? <p className="cap-md-upload-wait">Uploading {upload.file.name}</p> : null}
            {uploadError ? (
              <p className="cap-field-error cap-md-upload-error" role="alert">
                {uploadError}
              </p>
            ) : null}
            <div className="cap-md-upload-actions">
              <button type="button" className="cap-btn" data-variant="primary" disabled={!alt.trim() || Boolean(upload.sending)} onClick={() => void insertImage(false)}>
                Insert image
              </button>
              <button type="button" className="cap-btn" disabled={Boolean(upload.sending)} onClick={() => void insertImage(true)}>
                Insert as decorative
              </button>
              <button type="button" className="cap-btn" data-variant="quiet" onClick={cancelUpload}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {palette ? (
        <div
          ref={paletteRef}
          className="cap-popover cap-md-palette"
          popover="manual"
          role="group"
          aria-label="Insert a link"
          data-size="lg"
          data-side="bottom"
          data-align="start"
          onBlur={(e) => {
            if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) closePalette(false);
          }}
        >
          <label className="cap-md-palette-label" htmlFor="rich-link">
            Link to
          </label>
          <input
            id="rich-link"
            type="text"
            className="cap-input"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={matches.length > 0}
            aria-controls="rich-link-list"
            aria-activedescendant={matches.length > 0 ? `rich-link-${palette.active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="Search pages, or type a URL"
            value={palette.query}
            onChange={(e) => setPalette({ ...palette, query: e.target.value, active: 0 })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closePalette(true);
              } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (matches.length) setPalette({ ...palette, active: (palette.active + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length });
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (typedUrl) applyLink(typedUrl, typedUrl);
                else if (matches[palette.active]) applyLink(matches[palette.active]!.href, matches[palette.active]!.title);
              }
            }}
          />
          <div className="cap-listbox" role="listbox" id="rich-link-list" aria-label="Pages" data-wrap="">
            {matches.map((m, i) => (
              <div
                key={m.href}
                id={`rich-link-${i}`}
                className="cap-option"
                role="option"
                aria-selected={i === palette.active}
                data-active={i === palette.active ? "" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyLink(m.href, m.title)}
              >
                <span className="cap-option-label">{m.title}</span>
                {m.note ? <span className="cap-md-option-note"> ({m.note})</span> : null}
                {m.hint ? <span className="cap-md-option-hint">{m.hint}</span> : null}
              </div>
            ))}
          </div>
          <p className="cap-md-palette-note" role="status">
            {typedUrl ? `Enter links to ${typedUrl}.` : matches.length === 0 ? "No page matches. Type a full address to link to it." : `${matches.length} page${matches.length === 1 ? "" : "s"}.`}
          </p>
        </div>
      ) : null}
      {slash !== null ? (
        <ul
          ref={slashRef}
          className="cap-popover cap-md-slash"
          popover="manual"
          aria-label="Insert a block"
          data-flush=""
          data-size="auto"
          data-side="bottom"
          data-align="start"
          onKeyDown={(e) => {
            const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".cap-md-slash-item")];
            const at = items.findIndex((b) => b === document.activeElement);
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setSlash(null);
              editorRef.current?.commands.focus();
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
              e.preventDefault();
              const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
              items[next]?.focus();
            }
          }}
        >
          {scaffolds.map((s) => (
            <li key={s.id}>
              <button type="button" className="cap-md-slash-item" tabIndex={-1} onClick={() => insertScaffold(s, true)}>
                <strong>{s.label}</strong>
                <span className="cap-md-slash-hint">{s.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
