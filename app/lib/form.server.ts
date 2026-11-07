// The byte ceilings for the forms read with site-runtime's readForm (./body): it reads to the ceiling as the body
// arrives, since the platform's formData() holds the whole body in memory first, and throws a 413 over it.

/** Text forms: the site API refuses a body over 4 MB (site-api server/http.ts), and prose is far smaller. */
export const FORM_MAX_BYTES = 4_000_000;

/** A form carrying one media file: the site API's largest file (MAX_MEDIA_BYTES, 25 MiB) and its fields. */
export const UPLOAD_MAX_BYTES = 26 * 1024 * 1024;
