// The Claude Code routine that drafts brand posts when no session drafted them ahead (design decision
// 5, second step). Carrel only fires it: a POST to the routine's API trigger with the waiting items
// as text. The routine runs on Dustin's subscription, drafts each post in the account's voice, and
// stores it through Carrel's MCP tools; Carrel sends it later with no AI at runtime. No API key and no
// subscription token is ever stored: the trigger token reaches this one routine and can read nothing.
//
// The fire itself, and the check that the URL is Anthropic's, are site-runtime's ./routine, shared with
// germomics' drafting routine.

import { routineConfig as checkRoutine, type RoutineConfig } from "@dustinedwards/site-runtime/routine";

export { fireRoutine, type FireResult } from "@dustinedwards/site-runtime/routine";

export function routineConfig(env: Env): RoutineConfig | { missing: string } {
  const url = env.SOCIAL_ROUTINE_URL?.trim() ?? "";
  const token = env.SOCIAL_ROUTINE_TOKEN?.trim() ?? "";
  if (!url || !token) return { missing: "SOCIAL_ROUTINE_URL and SOCIAL_ROUTINE_TOKEN are not both set." };
  return checkRoutine(url, token);
}

/** What the routine is told: the items waiting, per account, and how to store a draft for each. */
export function routinePrompt(items: { eventId: number; account: string; platform: string; voiceGuide: string; title: string; url: string; summary: string }[]): string {
  const lines = [
    "Draft one social post for each item below, in that account's voice, and store each with Carrel's carrel_draft_social_post tool (event id, text). Do not post anything and do not reply to anyone.",
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
