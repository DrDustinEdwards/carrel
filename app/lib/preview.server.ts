// The preview: the site renders the draft with its own pipeline, and Carrel serves that page into a
// sandboxed iframe. The page is the site's markup, so it runs with no script, no forms, no network
// but the site's own styles and images, and an opaque origin that cannot reach Carrel.

/** The policy for a preview document. `sandbox` in the header holds even if the iframe attribute is lost. */
export function previewPolicy(siteOrigin: string): string {
  return [
    "sandbox",
    "default-src 'none'",
    `style-src ${siteOrigin} 'unsafe-inline'`,
    `img-src ${siteOrigin} data:`,
    `font-src ${siteOrigin}`,
    `media-src ${siteOrigin}`,
    "script-src 'none'",
    "form-action 'none'",
    `base-uri ${siteOrigin}`,
    "frame-ancestors 'self'",
  ].join("; ");
}

/**
 * Relative URLs in the site's page (its stylesheets, images) must resolve against the site, not
 * Carrel, so a <base> goes first in <head>. Any <base> the page carries is removed first.
 */
export function withSiteBase(html: string, siteOrigin: string): string {
  const base = `<base href="${siteOrigin}/">`;
  const stripped = html.replace(/<base\b[^>]*>/gi, "");
  if (/<head\b[^>]*>/i.test(stripped)) return stripped.replace(/<head\b[^>]*>/i, (head) => `${head}${base}`);
  return `${base}${stripped}`;
}

export function previewResponse(html: string, siteOrigin: string): Response {
  return new Response(withSiteBase(html, siteOrigin), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": previewPolicy(siteOrigin),
      "X-Frame-Options": "SAMEORIGIN",
    },
  });
}

export function previewFailure(message: string): Response {
  const escaped = message.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Preview unavailable</title></head><body><p>${escaped}</p></body></html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'self'",
        "X-Frame-Options": "SAMEORIGIN",
      },
    },
  );
}
