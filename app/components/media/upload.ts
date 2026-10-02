// The editor's image upload: one file to Carrel's per-project media endpoint, which hands it to the site
// through the site API. Never rejects with anything but an Error that says why, so the editor shows it.

export type EditorMedia = {
  /** Carrel's media endpoint for this project: GET lists for the picker, POST uploads. */
  endpoint: string;
  /** The types the site accepts, for the file chooser's `accept`. A hint, not a control: the site checks. */
  accept: string;
  /** The site's own Markdown for an image with its alt text. */
  figure: (url: string, alt: string) => string;
};

export type Uploaded = {
  /** What the Markdown carries: the site's own address for the file. */
  url: string;
  /** Where Carrel's page loads it from, since Carrel is a different host. */
  src: string;
};

export async function uploadImage(endpoint: string, file: File): Promise<Uploaded> {
  let response: Response;
  try {
    const form = new FormData();
    form.set("file", file);
    response = await fetch(endpoint, { method: "POST", body: form });
  } catch (error) {
    throw new Error(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await response.json().catch(() => ({}))) as { url?: string; src?: string; error?: string };
  if (!response.ok || !body.url) throw new Error(body.error ?? `Upload failed (${response.status}).`);
  return { url: body.url, src: body.src ?? body.url };
}
