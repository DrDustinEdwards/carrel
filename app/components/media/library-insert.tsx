// "Insert from library": an image already on the site goes into the post, with its alt text. The
// dialog holds Capsomer's MediaLibrary in picker mode, the same grid, search and tags as the media
// page, over the project's media endpoint: its links and its search load the next view into the
// dialog instead of leaving the editor. The picker's alt step starts from the file's own alt text; the
// figure takes the file's own caption, which the post can change like any other text.

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Button } from "capsomer/react/button";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "capsomer/react/dialog";
import { Empty } from "capsomer/react/empty";
import { MediaLibrary, type FormComponent, type MediaData } from "capsomer/react/media-library";

import type { EditorMedia } from "./upload";

export function LibraryInsert({ media, insert: put }: { media: EditorMedia; insert: (markdown: string) => void }) {
  const [open, setOpen] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [data, setData] = useState<MediaData | null>(null);
  const [error, setError] = useState("");
  const library = media.endpoint.replace(/\/api$/, "");

  const load = async (query: string) => {
    setError("");
    try {
      const response = await fetch(`${media.endpoint}${query}`, { headers: { accept: "application/json" } });
      const body = (await response.json().catch(() => null)) as (MediaData & { error?: undefined }) | { error?: string } | null;
      if (body && "rows" in body) setData(body);
      else setError((body && body.error) || `The library answered ${response.status}.`);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    }
  };

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (open && !data && !error) void loadRef.current("");
  }, [open, data, error]);

  // A link to another view of the library (a tag, a page, a file to choose) loads it here.
  const follow = (event: MouseEvent<HTMLElement>) => {
    const link = (event.target as Element).closest("a[href]");
    if (!(link instanceof HTMLAnchorElement)) return;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin || url.pathname !== library) return;
    event.preventDefault();
    void load(url.search);
  };
  // The search form is a GET of the library's own address: run it here too. One component for the
  // dialog's life, so a render never remounts the form being typed in.
  const PickerForm = useMemo<FormComponent>(
    () =>
      function PickerForm({ onSubmit, ...props }) {
        return (
          <form
            {...props}
            onSubmit={(event) => {
              onSubmit?.(event);
              if (event.defaultPrevented || (props.method ?? "get").toLowerCase() !== "get") return;
              event.preventDefault();
              const query = new URLSearchParams();
              for (const [k, v] of new FormData(event.currentTarget)) if (typeof v === "string" && v) query.append(k, v);
              void loadRef.current(`?${query}`);
            }}
          />
        );
      },
    [],
  );

  const close = () => {
    setOpen(false);
    setData(null);
    setError("");
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
          <DialogTitle id="library-title">Insert an image from the library</DialogTitle>
          <DialogDescription>Pick an image already on the site, then describe it. It is not in the post until it has alt text.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div onClickCapture={follow}>
            {error ? (
              <Empty kind="failed" flush title="The library did not answer">
                {error}
              </Empty>
            ) : data ? (
              <MediaLibrary
                data={data}
                action={library}
                Form={PickerForm}
                mode="picker"
                onPick={({ id, url, alt }) => {
                  const caption = data.rows.find((r) => r.key === id)?.caption ?? "";
                  put(media.figure(url, alt, caption));
                  close();
                }}
              />
            ) : (
              <p className="cap-muted" role="status">
                Loading media...
              </p>
            )}
          </div>
        </DialogBody>
        <DialogFooter align="between">
          <DialogClose part="cancel">Cancel</DialogClose>
        </DialogFooter>
      </Dialog>
    </>
  );
}
