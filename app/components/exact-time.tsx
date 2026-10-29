// A time said exactly, in the words of Capsomer's Time ("3 November 2026, 08:00 CST (14:00 UTC)"):
// the one form Carrel uses for a scheduled time, wherever it appears. The server knows no viewer's
// zone, so it says UTC until the page is live and the browser's zone after, which keeps hydration
// clean. Drawn as plain text in a <time>: Capsomer 0.36's .cap-time sets tabular figures, which
// space out the comma and the colon ("14 : 00"); Capsomer 0.37 drops them for exact times.

import { useEffect, useState } from "react";
import { exact, parse } from "capsomer/behavior/time";

/** The exact time as text, for a string prop (a dialog's lead, a gate's hold). */
export function useExactTime(): (iso: string) => string {
  const [local, setLocal] = useState(false);
  useEffect(() => setLocal(true), []);
  return (iso) => exact(parse(iso), local ? undefined : "UTC");
}

export function ExactTime({ at }: { at: string }) {
  const say = useExactTime();
  const t = parse(at);
  return Number.isFinite(t) ? <time dateTime={new Date(t).toISOString()}>{say(at)}</time> : <>{say(at)}</>;
}
