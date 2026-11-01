// The Claude Code routine that drafts brand posts when no session drafted them ahead (design decision
// 5, second step). Carrel only fires it: a POST to the routine's API trigger with the waiting items
// as text. The routine runs on Dustin's subscription, drafts each post in the account's voice, and
// stores it through Carrel's MCP tools; Carrel sends it later with no AI at runtime. No API key and no
// subscription token is ever stored: the trigger token reaches this one routine and can read nothing.
//
// The fire itself, its duplicate guard (fireOnce, keyed by the run, on D1's routine_fires table) and
// the check that the URL is Anthropic's, are site-runtime's ./routine, shared with germomics' drafting
// routine.

import { untrusted, UNTRUSTED_DATA_RULE } from "@dustinedwards/site-runtime/anthropic";
import { WRITING_RULES } from "@dustinedwards/site-runtime/prose";
import { routineConfig as checkRoutine, type RoutineConfig } from "@dustinedwards/site-runtime/routine";

export { d1FireStore, fireOnce } from "@dustinedwards/site-runtime/routine";

export function routineConfig(env: Env): RoutineConfig | { missing: string } {
  const url = env.SOCIAL_ROUTINE_URL?.trim() ?? "";
  const token = env.SOCIAL_ROUTINE_TOKEN?.trim() ?? "";
  if (!url || !token) return { missing: "SOCIAL_ROUTINE_URL and SOCIAL_ROUTINE_TOKEN are not both set." };
  return checkRoutine(url, token);
}

/**
 * What the routine is told: the items waiting, per account, and how to store a draft for each. Titles,
 * summaries, addresses and voice guides go in as delimited data (site-runtime's `untrusted`), so a title
 * that reads like an instruction stays text; the style rules are the family's WRITING_RULES.
 */
export function routinePrompt(items: { eventId: number; account: string; platform: string; voiceGuide: string; title: string; url: string; summary: string }[]): string {
  const lines = [
    "Draft one social post for each item below, in that account's voice, and store each with Carrel's carrel_draft_social_post tool (event id, text). Do not post anything and do not reply to anyone.",
    "Rules: the post announces the item and links it, and says nothing the item does not say.",
    WRITING_RULES,
    UNTRUSTED_DATA_RULE,
    "",
  ];
  for (const i of items) {
    lines.push(`- event ${i.eventId} for ${i.account} (${i.platform}): ${untrusted("title", i.title)} ${untrusted("url", i.url)}`);
    if (i.summary) lines.push(`  Dustin's summary: ${untrusted("summary", i.summary)}`);
    if (i.voiceGuide) lines.push(`  Voice: ${untrusted("voice-guide", i.voiceGuide)}`);
  }
  return lines.join("\n");
}
