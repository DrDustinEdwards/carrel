// The Content Security Policy for every page Carrel renders. Every response is private and
// `no-store`, so a fresh nonce per request is sound; it goes on React Router's scripts and on
// CodeMirror's inline <style>, which cannot be turned off. A route that sets its own policy (the
// preview) keeps it.

export function appPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    // The editor's palettes are placed with style attributes, which nonces do not cover.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    // The preview iframe, which is Carrel's own route serving the site's page under its own policy.
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A nonce from the platform's randomness; a derived or fixed value would pass every test and protect nothing. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** Adds the app policy unless the route set its own. Rebuilds the response when its headers are immutable. */
export function withPolicy(response: Response, nonce: string): Response {
  if (response.headers.has("Content-Security-Policy")) return response;
  try {
    response.headers.set("Content-Security-Policy", appPolicy(nonce));
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", appPolicy(nonce));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}
