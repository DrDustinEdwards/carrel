// Every action's form, read to a byte ceiling as it arrives (site-runtime ./body): the platform's formData() holds the
// whole body in memory before anything can refuse it. Over the ceiling is a thrown 413, never a cut form.

import { readForm as readCappedForm } from "@dustinedwards/site-runtime/body";

/** Text forms: the site API refuses a body over 4 MB (site-api server/http.ts), and prose is far smaller. */
const FORM_MAX_BYTES = 4_000_000;

/** A form carrying one media file: the site API's largest file (MAX_MEDIA_BYTES, 25 MiB) and its fields. */
export const UPLOAD_MAX_BYTES = 26 * 1024 * 1024;

/** The form, read to the ceiling (site-runtime ./body): a thrown 413 over it. */
export const readForm = (request: Request, max = FORM_MAX_BYTES): Promise<FormData> =>
  readCappedForm(request, max);
