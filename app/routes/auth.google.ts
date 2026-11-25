// Connect Google: /auth/google/start sends the Owner to Google's consent screen for
// drive.file alone; /auth/google/callback is where Google sends the browser back. Both sit behind
// Access at the browser door, and the one-use state ties the callback to a start made here.

import { logEvent } from "@dustinedwards/site-runtime/log";
import { redirect } from "react-router";

import { getEnv, getViewer } from "~/lib/context";
import { finishAuth, startAuth } from "~/lib/google/oauth.server";
import { GOOGLE_MESSAGES } from "~/lib/google/messages";
import { GoogleNotConnected } from "~/lib/google/service-account.server";

import type { Route } from "./+types/auth.google";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  if (!viewer.isOwner) throw new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const done = (code: keyof typeof GOOGLE_MESSAGES, detail?: string) => {
    if (detail) logEvent("google.connect-failed", { detail }, { level: "error" });
    return redirect(`/manuscripts?google=${code}`);
  };
  try {
    if (params.step === "start") return redirect(await startAuth(env, viewer, url.origin));
    if (params.step === "callback") {
      const result = await finishAuth(env, viewer, url.searchParams, url.origin);
      return result.ok ? done("connected") : done("failed", result.message);
    }
  } catch (error) {
    if (error instanceof GoogleNotConnected) return done("failed", error.detail);
    throw error;
  }
  throw new Response("Not found", { status: 404 });
}
