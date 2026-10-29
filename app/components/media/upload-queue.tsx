// Uploading to the media library (routes/media.tsx): several files at once, each its own upload with
// its own progress, and a failed one kept with its reason and a Retry. The tiles are Capsomer's media
// tiles in their uploading and failed states. Each file goes to the project's media endpoint (the same
// one the editor uses), which hands it to the site; XMLHttpRequest, because fetch reports no upload
// progress. Without script the form posts every chosen file at once, and the page says what happened.

import { useEffect, useRef, useState } from "react";
import { Form } from "react-router";
import { Button } from "capsomer/react/button";
import { DropZone } from "capsomer/react/drop-zone";
import { Field } from "capsomer/react/field";
import { MediaTile, type MediaRecord } from "capsomer/react/media";

/** Files sent at once; the rest wait their turn, so a large drop does not open dozens of requests. */
const AT_ONCE = 3;
/** The most files one drop takes. */
export const MAX_QUEUE = 50;

type Entry = { key: string; file: File; alt: string; state: "waiting" | "uploading" | "failed" | "done"; progress: number; error?: string; id?: string };

type Props = {
  /** Carrel's media endpoint for this project: POST uploads one file. */
  endpoint: string;
  accept: string;
  maxBytes: number;
  hint: string;
  pending: boolean;
  /** One file reached the site: the page reloads its list. */
  onUploaded: (id: string) => void;
};

/** Sends one file, reporting how much of it has left the browser. Resolves the site's id, or rejects with the reason in words. */
function send(endpoint: string, entry: Entry, progress: (pct: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.set("file", entry.file);
    if (entry.alt) form.set("alt", entry.alt);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", endpoint);
    xhr.responseType = "json";
    xhr.setRequestHeader("accept", "application/json");
    // The last few percent wait for the site, which answers only once it has stored the file.
    xhr.upload.onprogress = (event) => event.lengthComputable && progress(Math.min(95, (event.loaded / event.total) * 95));
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as { id?: string; error?: string };
      if (xhr.status >= 200 && xhr.status < 300 && body.id) resolve(body.id);
      else reject(new Error(body.error ?? `The upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("The connection dropped before the file was sent."));
    xhr.send(form);
  });
}

function record(entry: Entry): MediaRecord {
  return {
    key: entry.key,
    name: entry.file.name,
    url: "",
    kind: entry.file.type.startsWith("image/") ? "image" : "document",
    type: entry.file.type,
    bytes: entry.file.size,
    alt: entry.alt,
    altState: entry.alt ? "set" : "missing",
    title: "",
    caption: "",
    tags: [],
    used: [],
    // A file waiting its turn is drawn as an upload at 0 percent.
    state: entry.state === "failed" ? "failed" : "uploading",
    progress: entry.progress,
    error: entry.error,
  };
}

export function UploadQueue({ endpoint, accept, maxBytes, hint, pending, onUploaded }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [alt, setAlt] = useState("");
  // Script takes over once the page is live: files upload as they are added, and the Upload button is for the page without it.
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);
  const counter = useRef(0);
  const uploaded = useRef(onUploaded);
  uploaded.current = onUploaded;

  const patch = (key: string, change: Partial<Entry>) => setEntries((now) => now.map((e) => (e.key === key ? { ...e, ...change } : e)));

  // Starts the next waiting files while fewer than AT_ONCE are in flight.
  useEffect(() => {
    const running = entries.filter((e) => e.state === "uploading").length;
    const next = entries.filter((e) => e.state === "waiting").slice(0, Math.max(0, AT_ONCE - running));
    for (const entry of next) {
      patch(entry.key, { state: "uploading", progress: 0, error: undefined });
      send(endpoint, entry, (pct) => patch(entry.key, { progress: pct }))
        .then((id) => {
          patch(entry.key, { state: "done", progress: 100, id });
          uploaded.current(id);
        })
        .catch((error: unknown) => patch(entry.key, { state: "failed", error: error instanceof Error ? error.message : String(error) }));
    }
  }, [entries, endpoint]);

  const add = (files: File[]) => {
    // One alt text is one description: it goes with a single file, and several are described one by one after.
    const shared = files.length === 1 ? alt.trim() : "";
    setEntries((now) => [
      ...now.filter((e) => e.state !== "done"),
      ...files.map((file) => ({ key: `upload-${(counter.current += 1)}`, file, alt: shared, state: "waiting" as const, progress: 0 })),
    ]);
    if (shared) setAlt("");
  };

  const shown = entries.filter((e) => e.state !== "done");
  const done = entries.filter((e) => e.state === "done").length;
  const failed = shown.filter((e) => e.state === "failed").length;
  const inFlight = shown.length - failed;

  return (
    <Form method="post" encType="multipart/form-data" className="app-form">
      <DropZone name="file" accept={accept} maxBytes={maxBytes} maxFiles={MAX_QUEUE} multiple paste hint={hint} onAccepted={live ? add : undefined} />
      <Field label="Alt text" help="What the image shows, for someone who cannot see it. Used for a single file; with several, describe each one in its details after it uploads.">
        <input className="cap-input" type="text" name="alt" autoComplete="off" value={alt} onChange={(event) => setAlt(event.target.value)} />
      </Field>
      {live ? null : (
        <div className="app-actions">
          <Button type="submit" name="intent" value="upload" variant="primary" pending={pending}>
            Upload
          </Button>
        </div>
      )}
      <p className="cap-sr-only" role="status">
        {inFlight > 0 ? `Uploading ${inFlight} ${inFlight === 1 ? "file" : "files"}.` : ""}
        {done > 0 && inFlight === 0 ? ` Uploaded ${done} ${done === 1 ? "file" : "files"}.` : ""}
        {failed > 0 ? ` ${failed} ${failed === 1 ? "file was" : "files were"} not uploaded.` : ""}
      </p>
      {shown.length > 0 ? (
        <div className="cap-media" data-size="s">
          <ul className="cap-media-grid" role="list" aria-label="Uploads">
            {shown.map((entry) => (
              <MediaTile key={entry.key} item={record(entry)} selectable={false} onRetry={(key) => patch(key, { state: "waiting", progress: 0, error: undefined })} />
            ))}
          </ul>
          {failed > 0 ? (
            <div className="app-actions">
              <Button size="sm" onClick={() => setEntries((now) => now.map((e) => (e.state === "failed" ? { ...e, state: "waiting", progress: 0, error: undefined } : e)))}>
                Retry all
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setEntries((now) => now.filter((e) => e.state !== "failed"))}>
                Clear the failed
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Form>
  );
}
