// Every action's form, read to a byte ceiling as it arrives (site-runtime ./body): the platform's formData() holds the
// whole body in memory before anything can refuse it. Over the ceiling is a thrown 413, never a cut form.

import { readCappedBytes } from "@dustinedwards/site-runtime/body";

/** Text forms: the site API refuses a body over 4 MB (site-api server/http.ts), and prose is far smaller. */
const FORM_MAX_BYTES = 4_000_000;

/** A form carrying one media file: the site API's largest file (MAX_MEDIA_BYTES, 25 MiB) and its fields. */
export const UPLOAD_MAX_BYTES = 26 * 1024 * 1024;

export async function readForm(request: Request, max = FORM_MAX_BYTES): Promise<FormData> {
  const bytes = await readCappedBytes(request, max);
  if (bytes === null) throw new Response("The form is too large.", { status: 413, headers: { "Cache-Control": "private, no-store" } });
  // readCappedBytes joins the chunks into a fresh ArrayBuffer.
  return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": request.headers.get("Content-Type") ?? "" } }).formData();
}
