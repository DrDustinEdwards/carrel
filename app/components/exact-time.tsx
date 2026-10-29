// A time said exactly, in the words of Capsomer's Time ("3 November 2026, 08:00 CST (14:00 UTC)"):
// the one form Carrel uses for a scheduled time, wherever it appears. The server knows no viewer's
// zone, so it says UTC until the page is live and the browser's zone after, which keeps hydration
// clean. Capsomer 0.36's <Time format="exact"> does not: in a zone other than UTC its first client
// render adds a span the server never drew, and React refuses the page's hydration (error 418). Drawn
// as plain text in a <time>, also because 0.36's .cap-time sets tabular figures, which space out the
// comma and the colon ("14 : 00"); Capsomer 0.37 drops them for exact times.

import { useEffect, useState } from "react";
import { exact, parse } from "capsomer/behavior/time";

/** False on the server and in the render that hydrates, true after: for what only the browser knows. */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

/** The exact time as text, for a string prop (a dialog's lead, a gate's hold). */
export function useExactTime(): (iso: string) => string {
  const local = useHydrated();
  return (iso) => exact(parse(iso), local ? undefined : "UTC");
}

export function ExactTime({ at }: { at: string }) {
  const say = useExactTime();
  const t = parse(at);
  return Number.isFinite(t) ? <time dateTime={new Date(t).toISOString()}>{say(at)}</time> : <>{say(at)}</>;
}
