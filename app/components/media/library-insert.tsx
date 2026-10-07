// "From library": an image already on the site goes into the post, with its alt text. Capsomer's editor
// uploads (a drop, a paste, its Insert image button) but has no way to pick a file the site already
// holds, so this is Carrel's: a dialog over the project's media endpoint, then an alt step that starts
// from the alt the file already has, then one insert at the cursor through CodeMirror's public API.

import { EditorView } from "@codemirror/view";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useFetcher } from "react-router";
import { Button } from "capsomer/react/button";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "capsomer/react/dialog";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";

import type { EditorMedia } from "./upload";

type Row = { id: string; url: string; src: string; filename: string | null; alt: string; contentType: string };
type Picked = { url: string; src: string; name: string };

/** Puts a block at the cursor on a line of its own, as the editor's own blocks are put. */
function insertBlock(view: EditorView, text: string) {
  const { from, to } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const prefix = line.from === from && line.text.trim() === "" ? "" : "\n\n";
  view.dispatch({
    changes: { from, to, insert: `${prefix}${text}` },
    selection: { anchor: from + prefix.length + text.length },
    scrollIntoView: true,
  });
  view.focus();
}

export function LibraryInsert({ media, editor }: { media: EditorMedia; editor: RefObject<HTMLElement | null> }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [alt, setAlt] = useState("");
  const [q, setQ] = useState("");
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const altField = useRef<HTMLInputElement>(null);
  const list = useFetcher<{ items: Row[]; nextCursor: string | null; error?: string }>();

  useEffect(() => {
    if (open && list.state === "idle" && !list.data) void list.load(media.endpoint);
  }, [open, list, media.endpoint]);

  // Focus goes to the alt field once a file is picked: the step is otherwise silent.
  useEffect(() => {
    if (picked) altField.current?.focus();
  }, [picked]);

  const close = () => {
    setOpen(false);
    setPicked(null);
    setAlt("");
  };

  // Images only: a PDF in the library is not something a figure can show.
  const images = (list.data?.items ?? []).filter((o) => o.contentType.startsWith("image/"));
  const loading = !list.data;

  const insert = () => {
    const dom = editor.current?.querySelector<HTMLElement>(".cm-editor");
    const view = dom ? EditorView.findFromDOM(dom) : null;
    if (!view || !picked || !alt.trim()) return;
    insertBlock(view, media.figure(picked.url, alt.trim()));
    close();
  };

  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        onClick={(event) => {
          setOpener(event.currentTarget);
          setOpen(true);
        }}
      >
        Insert from library
      </Button>
      <Dialog open={open} onOpenChange={(o) => !o && close()} placement="center" size="lg" returnTo={opener} aria-labelledby="library-title">
        <DialogHeader divider>
          <DialogTitle id="library-title">{picked ? "Describe the image" : "Insert an image from the library"}</DialogTitle>
          <DialogDescription>{picked ? "The image is on the site. It is not in the post until it has alt text." : "Pick an image already on the site, then describe it."}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {picked ? (
            <div className="app-pick-alt" role="group" aria-label="Describe the image">
              <img className="app-pick-thumb" src={picked.src} alt="" />
              <div className="app-form">
                <Field label="Alt text" required help="What the image shows, for someone who cannot see it.">
                  <input
                    ref={altField}
                    className="cap-input"
                    value={alt}
                    onChange={(event) => setAlt(event.target.value)}
                    autoComplete="off"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        insert();
                      }
                    }}
                  />
                </Field>
                <p className="cap-muted">{picked.name}</p>
              </div>
            </div>
          ) : (
            <div className="app-form" role="group" aria-label="Insert an image from the library">
              <p className="cap-sr-only" role="status">
                {loading ? "Loading media" : images.length === 0 ? "No images" : `${images.length} image${images.length === 1 ? "" : "s"}`}
              </p>
              <form
                className="app-filters"
                role="search"
                onSubmit={(event) => {
                  event.preventDefault();
                  void list.load(`${media.endpoint}?q=${encodeURIComponent(q.trim())}`);
                }}
              >
                <Field label="Search the library">
                  <input className="cap-input" type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Name or alt text" />
                </Field>
                <Button type="submit">Search</Button>
              </form>
              {list.data?.error ? (
                <Empty kind="failed" flush title="The library did not answer">
                  {list.data.error}
                </Empty>
              ) : loading ? (
                <p className="cap-muted">Loading media...</p>
              ) : images.length === 0 ? (
                <Empty kind={q.trim() ? "no-match" : "nothing-yet"} flush title={q.trim() ? `No images match “${q.trim()}”` : "No images in the library yet"}>
                  {q.trim() ? "Try the name or the alt text." : "Drop or paste one into the editor to upload it."}
                </Empty>
              ) : (
                <div className="cap-media" data-size="s">
                  <ul className="cap-media-grid" role="list" aria-label="Images">
                    {images.map((o) => (
                      <li key={o.id} className="cap-media-tile">
                        <button
                          type="button"
                          className="cap-media-open"
                          onClick={() => {
                            setPicked({ url: o.url, src: o.src, name: o.filename ?? o.id });
                            setAlt(o.alt);
                          }}
                        >
                          <span className="cap-media-thumb">
                            <img src={o.src} alt="" loading="lazy" width={160} height={160} />
                          </span>
                          <span className="cap-media-name">{o.filename ?? o.id}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {list.data?.nextCursor ? <p className="cap-muted">Showing the first page. Search, or open the media library to page through the rest.</p> : null}
            </div>
          )}
        </DialogBody>
        <DialogFooter align="between">
          {picked ? (
            <Button
              onClick={() => {
                setPicked(null);
                setAlt("");
              }}
            >
              Back to the library
            </Button>
          ) : (
            <DialogClose part="cancel">Cancel</DialogClose>
          )}
          {picked ? (
            <Button variant="primary" onClick={insert} disabledReason={alt.trim() === "" ? "Describe the image first." : undefined}>
              Insert figure
            </Button>
          ) : null}
        </DialogFooter>
      </Dialog>
    </>
  );
}
