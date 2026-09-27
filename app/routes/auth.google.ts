// Connect Google (setup step 9): /auth/google/start sends the Owner to Google's consent screen for
// drive.file alone; /auth/google/callback is where Google sends the browser back. Both sit behind
// Access at the browser door, and the one-use state ties the callback to a start made here.

import { redirect } from "react-router";

import { getEnv, getViewer } from "~/lib/context";
import { finishAuth, startAuth } from "~/lib/google/oauth.server";
import { GoogleNotConnected } from "~/lib/google/service-account.server";

import type { Route } from "./+types/auth.google";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  if (!viewer.isOwner) throw new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const done = (message: string) => redirect(`/?google=${encodeURIComponent(message)}`);
  try {
    if (params.step === "start") return redirect(await startAuth(env, viewer, url.origin));
    if (params.step === "callback") {
      const result = await finishAuth(env, viewer, url.searchParams, url.origin);
      return done(result.ok ? "Google is connected for Send to Docs and Import (drive.file only)." : result.message);
    }
  } catch (error) {
    if (error instanceof GoogleNotConnected) return done(error.detail);
    throw error;
  }
  throw new Response("Not found", { status: 404 });
}
