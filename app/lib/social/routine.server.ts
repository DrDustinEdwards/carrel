// The Claude Code routine that drafts brand posts when no session drafted them ahead (design decision
// 5, second step). Carrel only fires it: a POST to the routine's API trigger with the waiting items
// as text. The routine runs on Dustin's subscription, drafts each post in the account's voice, and
// stores it through Carrel's MCP tools; Carrel sends it later with no AI at runtime. No API key and no
// subscription token is ever stored: the trigger token reaches this one routine and can read nothing.
//
// Contract (platform.claude.com/docs/en/api/claude-code/routines-fire, 2026-09-27): POST the fire URL
// with `Authorization: Bearer <token>` and `anthropic-version: 2023-06-01`, body `{ "text": ... }` of
// at most 65,536 characters; 200 returns the session; 429 is the hourly limit, with Retry-After.

type Fetch = typeof fetch;

const FIRE_URL = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9_-]+\/fire$/;
const MAX_TEXT = 65_536;

export type RoutineConfig = { url: string; token: string };

export function routineConfig(env: Env): RoutineConfig | { missing: string } {
  const url = env.SOCIAL_ROUTINE_URL?.trim() ?? "";
  const token = env.SOCIAL_ROUTINE_TOKEN?.trim() ?? "";
  if (!url || !token) return { missing: "SOCIAL_ROUTINE_URL and SOCIAL_ROUTINE_TOKEN are not both set." };
  if (!FIRE_URL.test(url)) return { missing: "SOCIAL_ROUTINE_URL is not a routine's /fire URL (https://api.anthropic.com/v1/claude_code/routines/trig_.../fire)." };
  return { url, token };
}

export type FireResult =
  | { ok: true; sessionUrl: string }
  /** Try again later: the hourly limit, or the service briefly down. */
  | { ok: false; retry: true; error: string }
  /** Will not work until something changes: bad token, paused routine, no access. */
  | { ok: false; retry: false; error: string };

export async function fireRoutine(config: RoutineConfig, text: string, fetcher: Fetch = fetch): Promise<FireResult> {
  let res: Response;
  try {
    res = await fetcher(config.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, MAX_TEXT) }),
    });
  } catch (error) {
    return { ok: false, retry: true, error: `The routine could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { claude_code_session_url?: string };
    return { ok: true, sessionUrl: body.claude_code_session_url ?? "" };
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string } };
  const error = `${res.status} ${body.error?.type ?? ""}${body.error?.message ? `: ${body.error.message}` : ""}`.trim();
  if (res.status === 429 || res.status >= 500) return { ok: false, retry: true, error };
  return { ok: false, retry: false, error };
}

/** What the routine is told: the items waiting, per account, and how to store a draft for each. */
export function routinePrompt(items: { eventId: number; account: string; platform: string; voiceGuide: string; title: string; url: string; summary: string }[]): string {
  const lines = [
    "Draft one social post for each item below, in that account's voice, and store each with Carrel's draft_social_post tool (event id, text). Do not post anything and do not reply to anyone.",
    "Rules: the post announces the item and links it; plain, direct sentences; no AI-writing tells; no em dashes; nothing the item does not say.",
    "",
  ];
  for (const i of items) {
    lines.push(`- event ${i.eventId} for ${i.account} (${i.platform}): "${i.title}" ${i.url}`);
    if (i.summary) lines.push(`  Dustin's summary: ${i.summary}`);
    if (i.voiceGuide) lines.push(`  Voice: ${i.voiceGuide}`);
  }
  return lines.join("\n");
}
