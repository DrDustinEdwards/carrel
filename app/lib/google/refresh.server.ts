// The cron's Google work: the manuscripts index (so files added to the folder appear), the channel on which Google
// tells Carrel of a change sooner (watch.server.ts), and each
// site's Search Console rows (at most daily). Nothing runs until the service account is set up; a
// failure is logged, and the health check is where a broken key, or a property not shared with the service account,
// is reported. An unshared property is skipped here, not retried as an error every quarter hour.

import { manuscriptsFolder, refreshManuscripts } from "./drive.server";
import { refreshSearchConsole, searchConsoleAccess } from "./search-console.server";
import { saConnection } from "./service-account.server";
import { keepWatching } from "./watch.server";

import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
export async function refreshGoogle(
  env: Env,
  fetcher?: typeof fetch,
): Promise<Record<string, unknown>> {
  if (saConnection(env).state !== "connected") return { skipped: "service account not connected" };
  const out: Record<string, unknown> = {};
  const note = (key: string, error: unknown) => {
    const message = errorMessage(error);
    logEvent("google.refresh-failed", { key, error: message }, { level: "error" });
    out[key] = `failed: ${message}`;
  };
  if (manuscriptsFolder(env)) {
    try {
      out.manuscripts = await refreshManuscripts(env, fetcher);
    } catch (error) {
      note("manuscripts", error);
    }
    try {
      out.watch = await keepWatching(env, fetcher);
    } catch (error) {
      note("watch", error);
    }
  }
  // A refused list throws, and the job is recorded failed: that is Google refusing the key, not a setup step.
  const { sites } = await searchConsoleAccess(env, fetcher);
  for (const row of sites) {
    const key = `search-console:${row.slug}`;
    try {
      out[key] = row.shared ? await refreshSearchConsole(env, row, fetcher) : "not shared";
    } catch (error) {
      note(key, error);
    }
  }
  return out;
}
