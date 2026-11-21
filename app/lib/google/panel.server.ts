// The Docs panel: Carrel's add-on in Google Docs, an Apps Script Workspace add-on installed
// in Dustin's account alone (addon/). It sends the Doc, his request and the words he selected here, on the AI door's
// host, and Carrel's own engine does the work through writeInDoc, the same path every AI's "Carrel writes it" takes.
//
// Who is asking is proved by Google, not by Access, which an add-on cannot pass: the request carries the Google ID
// token Apps Script issues for him (ScriptApp.getIdentityToken), checked like every JWT in the family (site-runtime's
// verifyJwt: RS256 by Google's published keys, Google as issuer, in date), for the add-on's own client
// (GOOGLE_PANEL_CLIENT_ID, a var: Apps Script's own client in the add-on's Cloud project, so a token Google issued to any other app is refused), naming a verified email that is the
// Owner's. The answer to a token that fails is a bare 403, except that a token valid in every way but its audience is
// told the audience it carries, so setting the add-on up needs no guessing; that id is not a secret.

import { remoteKeys, verifyJwt, type KeySource } from "@dustinedwards/site-runtime/access-login";
import { fromBase64urlText } from "@dustinedwards/site-runtime/encoding";
import {
  errorMessage,
  logEvent,
  OWASP_EVENTS,
  requestFields,
} from "@dustinedwards/site-runtime/log";

import { writeInDoc } from "~/lib/ai-write.server";
import { AiRefusal } from "~/lib/ai.server";
import { findViewer } from "~/lib/people.server";

export const PANEL_PATH = "/docs-panel";

const GOOGLE_KEYS = "https://www.googleapis.com/oauth2/v3/certs";
/** Google's ID tokens name either issuer (its OpenID Connect guide). */
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const JOBS = { edit: "docs-edit", new: "docs-write", review: "docs-review" } as const;

function refuse(request: Request, reason: string, status = 403, text = "Forbidden"): Response {
  logEvent(
    OWASP_EVENTS.authorizationFailure,
    { door: "docs-panel", reason, ...requestFields(request) },
    { level: "warn" },
  );
  return Response.json({ error: text }, { status });
}

/** The token's claims before any check, to pick its issuer and, once Google's signature holds, name its audience. */
function claimsOf(token: string): Record<string, unknown> {
  try {
    const claims: unknown = JSON.parse(fromBase64urlText(token.split(".")[1] ?? ""));
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The verified email of the token, or why not. */
async function googleEmail(
  token: string,
  client: string,
  keys: KeySource,
): Promise<{ email: string } | { reason: string; audience?: string }> {
  const claims = claimsOf(token);
  const issuer = GOOGLE_ISSUERS.find((i) => i === claims.iss) ?? GOOGLE_ISSUERS[0]!;
  const verdict = await verifyJwt(token, keys, { issuer, audience: client });
  if (!verdict.ok)
    // verifyJwt checks the signature and issuer before the audience, so this token is Google's own.
    return verdict.reason === "audience" && typeof claims.aud === "string"
      ? { reason: "audience", audience: claims.aud }
      : { reason: verdict.reason };
  const { email, email_verified: verified } = verdict.claims;
  if (typeof email !== "string" || verified !== true) return { reason: "email-unverified" };
  return { email };
}

/** One request from the panel: POST JSON { doc, ask, job: edit | new | review, mode?: suggest | write, selection? }. */
export async function panelAnswer(
  request: Request,
  env: Env,
  keys: KeySource = remoteKeys(GOOGLE_KEYS),
  fetcher?: typeof fetch,
): Promise<Response> {
  if (request.method !== "POST") return refuse(request, "method", 405, "POST only.");
  const token = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!token) return refuse(request, "no-token");
  const who = await googleEmail(token, env.GOOGLE_PANEL_CLIENT_ID?.trim() ?? "", keys);
  if ("reason" in who) {
    if (who.reason === "audience" && who.audience)
      return refuse(
        request,
        "audience",
        403,
        `Carrel does not know this add-on yet. Its client id is ${who.audience}: set it as GOOGLE_PANEL_CLIENT_ID.`,
      );
    return refuse(request, who.reason);
  }
  const viewer = await findViewer(env.DB, env, who.email);
  if (!viewer?.isOwner) return refuse(request, "not-owner");
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "The request is not JSON." }, { status: 400 });
  }
  const text = (key: string, max: number) =>
    typeof body[key] === "string" ? (body[key] as string).trim().slice(0, max) : "";
  const job = JOBS[text("job", 10) as keyof typeof JOBS];
  const mode = text("mode", 10) === "write" ? "write" : "suggest";
  if (!job) return Response.json({ error: "job is edit, new or review." }, { status: 400 });
  try {
    const ran = await writeInDoc(
      env,
      { viewer, client: "Docs panel" },
      text("doc", 200),
      { job, ask: text("ask", 2000), mode, selection: text("selection", 5000) || undefined },
      fetcher,
    );
    if (!ran.ok) return Response.json({ error: ran.error }, { status: 422 });
    return Response.json(ran);
  } catch (error) {
    if (error instanceof AiRefusal) return Response.json({ error: error.message }, { status: 422 });
    logEvent("docs_panel_failed", { error: errorMessage(error) }, { level: "error" });
    return Response.json({ error: "Carrel could not do it. Try again." }, { status: 500 });
  }
}
