// Awareness: Google tells Carrel when a file the service account can see changes, through one
// Drive changes.watch channel, and the manuscripts index refreshes then, recounting the AI suggestions still open in
// each Doc that changed (drive.server.ts refreshManuscripts), so Home's "suggestions wait" row is current. The quarter
// hour refresh stays the floor: a lost notice delays the index, never loses it.
//
// The channel lasts a week at most (Google's push guide), so the quarter-hour job opens a new one a day before the old
// one ends and stops the old. A notice is believed only with the channel's id and its random token, which Google sends
// back on every notice; a burst of edits refreshes the index once a minute at most.

import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { errorMessage, logEvent } from "@dustinedwards/site-runtime/log";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { driveWatch } from "~/db/schema";
import { mcpOrigin } from "~/lib/mcp/door";

import { refreshManuscripts } from "./drive.server";
import { saClient } from "./service-account.server";

export const WATCH_PATH = "/drive-changes";

const CHANGES = "https://www.googleapis.com/drive/v3/changes";
const DAY_MS = 86_400_000;
/** Google's longest channel for changes is a week; a new one opens when a day is left. */
const LIFETIME_MS = 7 * DAY_MS;
const RENEW_MS = DAY_MS;
const REFRESH_GAP_MS = 60_000;

/** Opens the channel when there is none or it ends within a day, and stops the one it replaces. */
export async function keepWatching(
  env: Env,
  fetcher?: typeof fetch,
  now = new Date(),
): Promise<"watching" | "renewed"> {
  const d = drizzle(env.DB);
  const old = await d.select().from(driveWatch).get();
  if (old && Date.parse(old.expiresAt) - now.getTime() > RENEW_MS) return "watching";
  const sa = saClient(env, fetcher);
  const start = await sa.request("GET", `${CHANGES}/startPageToken?supportsAllDrives=true`);
  if (!start.ok) throw new Error(`Drive did not give a start page token (${start.status}).`);
  const { startPageToken } = (await start.json()) as { startPageToken: string };
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  const res = await sa.request(
    "POST",
    `${CHANGES}/watch?pageToken=${encodeURIComponent(startPageToken)}`,
    {
      id,
      type: "web_hook",
      address: `${mcpOrigin(env)}${WATCH_PATH}`,
      token,
      expiration: now.getTime() + LIFETIME_MS,
    },
  );
  if (!res.ok) throw new Error(`Drive did not open the change channel (${res.status}).`);
  const channel = (await res.json()) as { resourceId: string; expiration?: string };
  const expiresAt = new Date(Number(channel.expiration) || now.getTime() + LIFETIME_MS);
  await d.delete(driveWatch);
  await d
    .insert(driveWatch)
    .values({ id, resourceId: channel.resourceId, token, expiresAt: expiresAt.toISOString() });
  if (old) {
    // A channel left open only sends notices this endpoint now refuses, so a failed stop is logged, not thrown.
    const stop = await sa
      .request("POST", "https://www.googleapis.com/drive/v3/channels/stop", {
        id: old.id,
        resourceId: old.resourceId,
      })
      .catch((error: unknown) => ({ ok: false, status: errorMessage(error) }));
    if (!stop.ok) logEvent("drive_watch_stop_failed", { status: stop.status }, { level: "warn" });
  }
  return "renewed";
}

/** One notice from Google: 200 to its own channel (refreshing the index on a change), 404 to anything else. */
export async function driveNotice(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  fetcher?: typeof fetch,
  now = new Date(),
): Promise<Response> {
  if (request.method !== "POST") return new Response("POST only.", { status: 405 });
  const d = drizzle(env.DB);
  const channel = await d.select().from(driveWatch).get();
  const ok =
    channel &&
    (await safeEqual(request.headers.get("X-Goog-Channel-ID") ?? "", channel.id)) &&
    (await safeEqual(request.headers.get("X-Goog-Channel-Token") ?? "", channel.token));
  if (!ok) return new Response("Not found", { status: 404 });
  const last = channel.refreshedAt ? Date.parse(channel.refreshedAt) : 0;
  if (
    request.headers.get("X-Goog-Resource-State") === "change" &&
    now.getTime() - last >= REFRESH_GAP_MS
  ) {
    await d
      .update(driveWatch)
      .set({ refreshedAt: now.toISOString() })
      .where(eq(driveWatch.id, channel.id));
    ctx.waitUntil(
      refreshManuscripts(env, fetcher).catch((error: unknown) =>
        logEvent("drive_notice_refresh_failed", { error: errorMessage(error) }, { level: "error" }),
      ),
    );
  }
  return new Response(null, { status: 200 });
}
