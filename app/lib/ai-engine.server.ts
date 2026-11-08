// Which engine does Carrel's AI work: Dustin's Claude subscription (a routine) or the Anthropic API. The deciding is
// site-runtime's ./ai-engine; this keeps the settings in D1, records every API call so the month's spend is known and
// can be capped, and holds the two jobs Carrel runs itself (social post drafts, search title and description).
// A draft the API writes is saved beside Dustin's own, never over it (CLAUDE.md: AI never rewrites his prose unasked).

import {
  costMicros,
  normalizeSettings,
  type EngineSettings,
} from "@dustinedwards/site-runtime/ai-engine";
import {
  MODEL_IDS,
  structured,
  untrusted,
  UNTRUSTED_DATA_RULE,
  type CallOptions,
  type CallRecord,
} from "@dustinedwards/site-runtime/anthropic";
import { WRITING_RULES } from "@dustinedwards/site-runtime/prose";
import {
  joinSource,
  readKey,
  setBlock,
  splitSource,
} from "@drdustinedwards/site-helpers/frontmatter";
import { desc, eq, gte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { aiSettings, aiUsage } from "~/db/schema";
import { saveAiDraft } from "~/lib/ai.server";
import { readDoc, readDraft } from "~/lib/content.server";
import type { Viewer } from "~/lib/people.server";
import type { SiteProject } from "~/lib/projects.server";
import { socialFieldsOf } from "~/lib/seo-checks";

/** The jobs that can run on either engine. `subscription` says whether a routine can do it. */
export const FEATURES = [
  {
    key: "social",
    label: "Social post drafts",
    subscription: true,
    note: "The subscription fires a routine that drafts every waiting post in one run. The API drafts them in the same pass.",
  },
  {
    key: "seo",
    label: "Search title and description",
    subscription: false,
    note: "The API writes it as a draft beside yours. On the subscription, ask a Claude session to write it.",
  },
] as const;
export type FeatureKey = (typeof FEATURES)[number]["key"];

/**
 * The saved settings. Until Dustin saves some, everything stays on the subscription, as before the switch existed: the
 * API spends money, so it is never the default.
 */
export async function readAiSettings(db: D1Database): Promise<EngineSettings> {
  const row = await drizzle(db).select().from(aiSettings).where(eq(aiSettings.id, 1)).get();
  try {
    if (!row) return { ...(normalizeSettings(null) as EngineSettings), master: "subscription" };
    return normalizeSettings(JSON.parse(row.json)) as EngineSettings;
  } catch {
    return { ...(normalizeSettings(null) as EngineSettings), master: "subscription" };
  }
}

export async function saveAiSettings(
  db: D1Database,
  viewer: Viewer,
  input: unknown,
): Promise<EngineSettings> {
  if (!viewer.isOwner) throw new Response("Not found", { status: 404 });
  const settings = normalizeSettings(input) as EngineSettings;
  const json = JSON.stringify(settings);
  await drizzle(db)
    .insert(aiSettings)
    .values({ id: 1, json })
    .onConflictDoUpdate({ target: aiSettings.id, set: { json } });
  return settings;
}

const monthStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

/** What the API has cost this month (UTC), in millionths of a dollar. */
export async function monthSpendMicros(db: D1Database, now = new Date()): Promise<number> {
  const row = await drizzle(db)
    .select({ total: sql<number>`coalesce(sum(${aiUsage.micros}), 0)` })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, monthStart(now)))
    .get();
  return row?.total ?? 0;
}

export async function usageThisMonth(db: D1Database, now = new Date()) {
  return drizzle(db)
    .select({
      feature: aiUsage.feature,
      calls: sql<number>`count(*)`,
      micros: sql<number>`sum(${aiUsage.micros})`,
    })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, monthStart(now)))
    .groupBy(aiUsage.feature)
    .orderBy(desc(sql`sum(${aiUsage.micros})`))
    .all();
}

/** Call options that record the call's cost under `feature`, even when the call failed (it still spent tokens). */
export function metered(db: D1Database, feature: FeatureKey): CallOptions {
  return {
    feature,
    onResult: async (r: CallRecord) => {
      await drizzle(db)
        .insert(aiUsage)
        .values({
          feature,
          model: r.model,
          micros: costMicros(r.model, r) ?? 0,
          promptSize: r.input + r.cacheRead + r.cacheWrite,
          answerSize: r.output,
          ok: r.ok,
        });
    },
  };
}

// ---------- social post drafts through the API

const POST_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

type SocialItem = {
  account: string;
  platform: string;
  voiceGuide: string;
  title: string;
  url: string;
  summary: string;
};

/** One post for one item, from the account's voice. The caller stores it and lints it like any other draft. */
export async function draftPostViaApi(env: Env, item: SocialItem, fetcher?: typeof fetch) {
  const maxChars = item.platform === "x" ? 280 : 300;
  return structured<{ text: string }>(
    env,
    "carrel",
    {
      model: MODEL_IDS.standard,
      max_tokens: 600,
      system: [
        `Draft one ${item.platform} post for ${item.account} announcing the item below, in the account's voice. The post announces the item and links it, says nothing the item does not say, and is at most ${maxChars} characters including the link.`,
        WRITING_RULES,
        UNTRUSTED_DATA_RULE,
      ].join("\n\n"),
      messages: [
        {
          role: "user",
          content: [
            untrusted("title", item.title),
            untrusted("url", item.url),
            item.summary ? untrusted("summary", item.summary) : "",
            item.voiceGuide ? untrusted("voice-guide", item.voiceGuide) : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    },
    POST_SCHEMA,
    { ...metered(env.DB, "social"), ...(fetcher ? { fetcher } : {}) },
  );
}

// ---------- search title and description through the API

const SEO_SCHEMA = {
  type: "object",
  properties: { description: { type: "string" }, title: { type: "string" } },
  required: ["description", "title"],
  additionalProperties: false,
};

export type SeoSuggestion = { ok: true; draftId: number } | { ok: false; error: string };

/**
 * Writes the page's search description (and its search title, on a site that keeps one apart from the post's title) and
 * saves the page with those fields set as an AI draft beside the working text. Nothing else in the text changes.
 */
export async function suggestSeo(
  env: Env,
  project: SiteProject,
  viewer: Viewer,
  itemId: string,
): Promise<SeoSuggestion> {
  const working =
    (await readDraft(env.DB, project, viewer, itemId))?.source ??
    (await readDoc(env, project, itemId))?.source;
  if (!working) return { ok: false, error: "This item has no text yet." };
  const parts = splitSource(working.replace(/\r\n/g, "\n"));
  if (parts.front === null)
    return { ok: false, error: "This page has no front matter to put a description in." };
  const { front, body } = { front: parts.front, body: parts.body };
  const keys = socialFieldsOf(project.site);
  const descriptionKey = keys.description[0]!;
  // The post's own title is Dustin's; only a separate search title is written.
  const titleKey = keys.title[0] !== "title" ? keys.title[0]! : null;
  const result = await structured<{ description: string; title: string }>(
    env,
    "carrel",
    {
      model: MODEL_IDS.standard,
      max_tokens: 500,
      system: [
        "Write the search description for the web page below, and a search title. The description says in one or two plain sentences what the reader gets from the page, 110 to 155 characters, in the author's own register. The title is at most 60 characters. No keyword lists, no questions to the reader, nothing the page does not say.",
        WRITING_RULES,
        UNTRUSTED_DATA_RULE,
      ].join("\n\n"),
      messages: [
        {
          role: "user",
          content: [
            untrusted("current-title", readKey(front, "title")),
            untrusted("page", body.slice(0, 40_000)),
          ].join("\n"),
        },
      ],
    },
    SEO_SCHEMA,
    metered(env.DB, "seo"),
  );
  if (!result.ok) return { ok: false, error: result.error };
  let next = front;
  const set = (key: string, value: string) => {
    const v = value.replace(/\s+/g, " ").trim();
    if (v) next = setBlock(next, key, [`${key}: ${JSON.stringify(v)}`]);
  };
  set(descriptionKey, result.value.description);
  if (titleKey) set(titleKey, result.value.title);
  const saved = await saveAiDraft(env, project, { viewer, client: "Carrel (Claude API)" }, itemId, {
    source: joinSource({ ...parts, front: next }),
    note: `Search description${titleKey ? " and title" : ""} written through the Claude API; nothing else changed.`,
  });
  return { ok: true, draftId: saved.id };
}
