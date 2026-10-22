// The default fetch for every outbound call: GitHub, Google, the sites, social and the routine. A hung
// upstream would otherwise hold the request, or the cron tick, until the runtime cut it off (Grok audit
// 2026-10-21, CR-4). A caller's own signal wins.

const OUTBOUND_TIMEOUT_MS = 20_000;

export const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) });
