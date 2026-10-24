// The AI-habits lint on every post (design section 5, "Social"), and the checks a post needs before
// it can go: it fits the platform, it is not a reply in disguise, it is not empty. A post with any
// finding is held for Dustin; the lint flags and he decides.
//
// The habits are the shared check's (site-runtime ./prose) with stage 4's words on top (SEED_WORDS, the
// AI-tells list first kept in capsid/conventions.md): one check for books, posts and drafts.

import { checkProse } from "@dustinedwards/site-runtime/prose";

import { SEED_WORDS } from "~/lib/novels/checks";

import { graphemes, type Platform } from "./platforms.server";

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
  for (const issue of checkProse(t, { phrases: SEED_WORDS })) out.push(issue.message);
  if (/!\s*$/.test(t) && /!.*!/.test(t)) out.push("More than one exclamation mark.");
  return out;
}
