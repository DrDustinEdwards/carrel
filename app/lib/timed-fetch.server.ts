// The default fetch for every outbound call: GitHub, Google, the sites, social and the routine. A hung
// upstream would otherwise hold the request, or the cron tick, until the runtime cut it off (Grok audit
// 2026-10-21, CR-4). A caller's own signal wins.

const OUTBOUND_TIMEOUT_MS = 20_000;

export const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) });

/**
 * The fetch for one MCP tool call (checklist P11): `fetcher` (default timedFetch, so its timeout still holds) with the
 * call's abort signal joined to the request's own, so a client that closes the stream stops the outbound calls too.
 */
export function fetchUntil(signal: AbortSignal | undefined, fetcher?: typeof fetch): typeof fetch | undefined {
  if (!signal) return fetcher;
  const base = fetcher ?? timedFetch;
  return (input, init) =>
    base(input, { ...init, signal: AbortSignal.any([init?.signal ?? AbortSignal.timeout(OUTBOUND_TIMEOUT_MS), signal]) });
}
