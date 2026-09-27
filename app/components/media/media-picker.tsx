// Copied from DrDustinEdwards/dustinedwards-info@f84b978 (app/components/admin/media-picker.tsx).
// Changed: it loads Carrel's per-project media endpoint instead of /admin/media?picker=1, gains a
// search box (the site's picker had none, and a library outgrows one page), shows each file at the
// site's own address (`src`), and hands back the name and alt text too, for the alt prompt.

import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

type PickedMedia = { id: string; url: string; src: string; name: string; alt: string };

type PickerRow = { id: string; url: string; src: string; filename: string | null; alt: string; contentType: string };

export function MediaPicker({
  endpoint,
  onPick,
  onCancel,
}: {
  endpoint: string;
  onPick: (picked: PickedMedia) => void;
  onCancel?: () => void;
}) {
  const media = useFetcher<{ items: PickerRow[]; nextCursor: string | null; error?: string }>();
  const [q, setQ] = useState("");

  useEffect(() => {
    if (media.state === "idle" && !media.data) media.load(endpoint);
  }, [media, endpoint]);

  // Images only: a PDF in the library is not something a figure can show.
  const objects = (media.data?.items ?? []).filter((o) => o.contentType.startsWith("image/"));
  // Before the first answer, the idle render included: without data, "no images" would be a guess.
  const loading = !media.data;
  /* Mounted empty on the first render and filled after, so the loading and the result are both announced. */
  const status = (
    <p className="sr-only" role="status">
      {media.state === "loading" && loading
        ? "Loading media"
        : loading
          ? ""
          : objects.length === 0
            ? "No images"
            : `${objects.length} image${objects.length === 1 ? "" : "s"}`}
    </p>
  );

  return (
    <div className="media-picker" role="group" aria-label="Insert an image from the library">
      {status}
      <form
        className="media-picker-search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          media.load(`${endpoint}?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <label htmlFor="media-picker-q">Search the library</label>
        <input id="media-picker-q" type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Name or alt text" />
        <button type="submit" className="btn-ghost">
          Search
        </button>
      </form>

      {media.data?.error ? (
        <p className="alarm" role="alert">
          {media.data.error}
        </p>
      ) : loading ? (
        <p className="muted">Loading media...</p>
      ) : objects.length === 0 ? (
        <p className="muted">
          {q.trim() ? `No images match "${q.trim()}".` : "No images in the library yet. Drop or paste one into the editor to upload it."}
        </p>
      ) : (
        <ul className="media-picker-grid">
          {objects.map((object) => (
            <li key={object.id}>
              <button
                type="button"
                className="media-picker-item"
                onClick={() => onPick({ id: object.id, url: object.url, src: object.src, name: object.filename ?? object.id, alt: object.alt })}
              >
                <img src={object.src} alt="" loading="lazy" width={160} height={160} />
                <span className="media-picker-key">{object.filename ?? object.id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {media.data?.nextCursor ? <p className="muted">Showing the first page. Search, or open the media library to page through the rest.</p> : null}
      {onCancel ? (
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      ) : null}
    </div>
  );
}
