// The AI-habits lint on every post (design section 5, "Social"), and the checks a post needs before
// it can go: it fits the platform, it is not a reply in disguise, it is not empty. A post with any
// finding is held for Dustin; the lint flags and he decides.
//
// The word list is the AI-tells list in capsid/conventions.md, as stage 4's checks seed it. Once
// stage 4 is merged, this and its checkAiHabits become one.

import { graphemes, type Platform } from "./platforms.server";

export const HABIT_WORDS = [
  "delve", "tapestry", "spans", "landscape", "realm", "navigate", "testament to", "boasts", "stands as",
  "compelling", "must-read", "journey", "explore", "dive into", "discover", "it's worth noting",
  "importantly", "furthermore",
];

const NOT_JUST = [
  /(?:\bnot|n['\u2019]t)\s+(?:just|only|merely|simply)\s+[^.!?;:,]{1,60}[,;:]\s*(?:it|this|that|he|she|they|we|you)(?:['\u2019](?:s|re)|\s+(?:is|was|are|were))\b/iu,
  /\b(?:it|this|that)(?:['\u2019]s\s+not|\s+is\s+not|\s+was\s+not|\s+isn['\u2019]t|\s+wasn['\u2019]t)\s+[^.!?;:]{1,50}[.,;:]\s*(?:it|this|that)(?:['\u2019]s|\s+(?:is|was))\b/iu,
];

/** X counts every link as 23 characters, however long; Bluesky counts graphemes. */
function length(text: string, platform: Platform): number {
  if (platform === "bluesky") return graphemes(text);
  return [...text.replace(/https?:\/\/\S+/g, "x".repeat(23))].length;
}

const LIMIT: Record<Platform, number> = { bluesky: 300, x: 280 };

export function lintPost(text: string, platform: Platform): string[] {
  const out: string[] = [];
  const t = text.trim();
  if (!t) return ["The post is empty."];
  const n = length(t, platform);
  if (n > LIMIT[platform]) out.push(`${n} characters, over ${platform === "x" ? "X" : "Bluesky"}'s ${LIMIT[platform]}.`);
  // A post that opens on a handle is threaded as a reply by readers, and replies are never Carrel's.
  if (/^[.\s]*@\w/.test(t)) out.push("It opens with an @handle, which reads as a reply.");
  for (const word of HABIT_WORDS) {
    const re = new RegExp(`(?<![\\p{L}'\u2019])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['\u2019]")}(?![\\p{L}])`, "iu");
    if (re.test(t)) out.push(`"${word}" is on the AI-habits list.`);
  }
  if (NOT_JUST.some((re) => re.test(t))) out.push(`The "not X, it's Y" construction.`);
  if (/!\s*$/.test(t) && /!.*!/.test(t)) out.push("More than one exclamation mark.");
  return out;
}
