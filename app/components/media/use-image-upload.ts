// Copied from DrDustinEdwards/dustinedwards-info@f84b978 (app/components/admin/use-image-upload.ts).
// Changed: the upload goes to Carrel's per-project media endpoint, which hands it to the site through
// the site API, instead of the site's own /admin/media/upload; the figure markup comes from the site's
// entry in Carrel (its own dialect) instead of being written here; and a file picked from the library
// takes the same path as an upload, straight to the alt prompt.

import type { EditorView } from "@codemirror/view";
import { useState } from "react";

import { insertBlock } from "~/components/editor/md-editor-commands";

export type EditorMedia = {
  /** Carrel's media endpoint for this project: GET lists for the picker, POST uploads. */
  endpoint: string;
  /** The types the site accepts, for the file chooser's `accept`. A hint, not a control: the site checks. */
  accept: string;
  /** The site's own Markdown for an image with its alt text. */
  figure: (url: string, alt: string) => string;
};

type Upload = { url: string; src: string; name: string };

/**
 * The upload: one file to Carrel's endpoint. Never rejects, so a caller that `void`s it still shows
 * every failure: Carrel's or the site's refusal, a status when the body is not JSON, or the network.
 */
async function uploadTo(endpoint: string, file: File): Promise<Upload | { error: string }> {
  try {
    const form = new FormData();
    form.set("file", file);
    const response = await fetch(endpoint, { method: "POST", body: form });
    const body = (await response.json().catch(() => ({}))) as { url?: string; src?: string; error?: string };
    if (!response.ok || !body.url) return { error: body.error ?? `Upload failed (${response.status}).` };
    return { url: body.url, src: body.src ?? body.url, name: file.name };
  } catch (error) {
    return { error: `Upload failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * The markdown editor's dropped, pasted, chosen or picked image: the upload, its failure, the alt
 * prompt, and the figure it inserts once alt text exists.
 */
export function useImageUpload(viewRef: React.RefObject<EditorView | null>, media: EditorMedia | undefined) {
  // `url` is what the Markdown carries (the site's own address); `src` is where Carrel's page loads it.
  const [upload, setUpload] = useState<Upload | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [alt, setAlt] = useState("");

  const uploadFile = async (file: File) => {
    if (!media) return;
    setUploadError(null);
    setUpload({ url: "", src: "", name: file.name });
    const result = await uploadTo(media.endpoint, file);
    if ("error" in result) {
      setUpload(null);
      setUploadError(result.error);
      return;
    }
    setUpload(result);
    setAlt("");
  };

  /** A file already in the library: no upload, straight to the alt prompt, with the alt it already has. */
  const pickExisting = (picked: { url: string; src: string; name: string; alt: string }) => {
    setUploadError(null);
    setUpload({ url: picked.url, src: picked.src, name: picked.name });
    setAlt(picked.alt);
  };

  const insertFigure = () => {
    const view = viewRef.current;
    if (!view || !media || !upload?.url || !alt.trim()) return;
    insertBlock(view, media.figure(upload.url, alt.trim()));
    setUpload(null);
    setAlt("");
  };

  return { upload, setUpload, uploadError, alt, setAlt, uploadFile, pickExisting, insertFigure };
}
