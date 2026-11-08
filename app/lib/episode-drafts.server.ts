// Episode summaries and chapters, drafted without a button: when a Germomics episode has its transcript but no summary
// or no chapters, Carrel fires the Claude Code routine once. The routine runs on Dustin's subscription, reads the
// episode through carrel_read_item (the transcript comes with it, read only) and stores what it writes with
// carrel_save_draft, an AI draft beside his own. Nothing goes live; Carrel runs no model and holds no API key.
// The fire and its once-only guard are site-runtime's ./routine, as for the social posts (./social/routine.server.ts).

import { untrusted, UNTRUSTED_DATA_RULE } from "@dustinedwards/site-runtime/anthropic";
import { WRITING_RULES } from "@dustinedwards/site-runtime/prose";

import { d1FireStore, fireOnce, routineConfig } from "./social/routine.server";
import { siteClient } from "~/lib/sites.server";

const SITE = "germomics";
const PROJECT = "germomics";

/** Whether a Markdown source with JSON front matter leaves its summary or its chapters empty. */
export function needsDraft(source: string): boolean {
  const front = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? "";
  const value = (key: string): string =>
    new RegExp(`^${key}:\\s*(.*)$`, "m").exec(front)?.[1]?.trim() ?? "";
  const empty = (v: string) => v === "" || v === '""' || v === "null" || v === "[]";
  return empty(value("excerpt")) || empty(value("chapters"));
}

function episodePrompt(slug: string, title: string): string {
  return [
    `Draft the summary and the chapters for the Germomics episode below, and store them as one AI draft with Carrel's carrel_save_draft tool (project "${PROJECT}"). Do not publish anything.`,
    `Read it first with carrel_read_item: its transcript comes with it. Keep every other field of the source exactly as it is, and fill only \`excerpt\` (the summary) and \`chapters\` (a list of {"start": seconds, "title": ...}) where they are empty. Take chapter times only from the transcript's own timestamps; if it has none, leave chapters as they are and say so in the note.`,
    WRITING_RULES,
    UNTRUSTED_DATA_RULE,
    `Episode ${untrusted("slug", slug)}: ${untrusted("title", title)}`,
  ].join("\n\n");
}

/**
 * One pass, run by the cron: every unpublished Germomics episode with a transcript and an empty summary or chapters gets
 * the routine once per transcript (keyed by its length, so a replaced transcript is drafted again). Returns what it did.
 */
export async function draftEpisodes(
  env: Env,
  fetcher?: typeof fetch,
  now = new Date(),
): Promise<{ fired: string[]; errors: string[] }> {
  const out = { fired: [] as string[], errors: [] as string[] };
  const config = routineConfig(env);
  if ("missing" in config) return out;
  const client = siteClient(env, SITE, fetcher);
  const list = await client.list({ kind: "episode", status: "draft", limit: 50 });
  for (const item of list.items) {
    const doc = await client.get(item.id);
    if (!doc?.transcript?.trim() || !needsDraft(doc.source)) continue;
    const fired = await fireOnce(
      d1FireStore(env.DB),
      `episode-draft:${item.id}:${doc.transcript.length}`,
      config,
      episodePrompt(item.id, item.title),
      { fetcher, now },
    );
    if (fired.ok) out.fired.push(item.id);
    else if (fired.outcome !== "already_fired") out.errors.push(`${item.id}: ${fired.error}`);
  }
  return out;
}
