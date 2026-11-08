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
import { sendEmail } from "@dustinedwards/site-runtime/email";
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
import { d1FireStore } from "~/lib/social/routine.server";
import type { Viewer } from "~/lib/people.server";
import type { SiteProject } from "~/lib/projects.server";
import { socialFieldsOf } from "~/lib/seo-checks";

/**
 * The jobs that can run on either engine. `subscription` says whether a routine can do it; `engine` is the setting the job
 * starts with until Dustin changes it. Background jobs nobody waits on start on the API (it answers at once and is
 * metered); long writing he steers himself starts on Automatic, the subscription first.
 */
export const FEATURES = [
  {
    key: "social",
    label: "Social post drafts",
    subscription: true,
    engine: "api",
    note: "The subscription fires a routine that drafts every waiting post in one run. The API drafts them in the same pass.",
  },
  {
    key: "episode",
    label: "Germomics episode summaries and chapters",
    subscription: true,
    engine: "api",
    note: "The subscription fires a routine per episode that has a transcript. The API drafts them from the transcript. Either way it is a draft beside yours.",
  },
  {
    key: "seo",
    label: "Search title and description",
    subscription: true,
    engine: "api",
    note: "The API writes it as a draft beside yours. The subscription's routine writes it with Carrel's tools.",
  },
  {
    key: "alt",
    label: "Alt text for pictures without it",
    subscription: true,
    engine: "api",
    note: "The API asks the site's own picture suggester for each file and sets what it writes. The subscription's routine looks at each picture and sets the alt with Carrel's tools. Never overwrites an alt that exists.",
  },
  {
    key: "continue",
    label: "Continue my draft (posts and book files)",
    subscription: true,
    engine: "auto",
    note: "Writes the next passage from your own text and voice, as a draft beside yours. Starts on the subscription and uses the API when it is refused.",
  },
  {
    key: "edit",
    label: "Suggest edits (posts and book files)",
    subscription: true,
    engine: "auto",
    note: "Edits for clarity and correctness in your voice, as a draft beside yours. Starts on the subscription and uses the API when it is refused.",
  },
] as const;
type FeatureKey = (typeof FEATURES)[number]["key"];

/** The API cap a month before Dustin sets one: a guard well inside his monthly API credit. */
export const DEFAULT_CAP_MICROS = 20_000_000;

/** The settings before any are saved: Automatic, with each job on the engine it starts with. */
export function defaultAiSettings(): EngineSettings {
  return normalizeSettings({
    master: "auto",
    features: Object.fromEntries(FEATURES.map((f) => [f.key, f.engine])),
    apiCapMicros: DEFAULT_CAP_MICROS,
  }) as EngineSettings;
}

/**
 * The settings for one run that must use one engine: Dustin pressed "run it on the other engine". Only the job's own
 * setting changes, so the cap and the override still apply as they do to any run.
 */
export function onlyEngine(
  settings: EngineSettings,
  feature: string,
  engine: "api" | "subscription" | undefined,
): EngineSettings {
  if (!engine) return settings;
  return { ...settings, override: null, features: { ...settings.features, [feature]: engine } };
}

/** The saved settings, or the defaults when none are saved (or the saved row is unreadable). */
export async function readAiSettings(db: D1Database): Promise<EngineSettings> {
  const row = await drizzle(db).select().from(aiSettings).where(eq(aiSettings.id, 1)).get();
  try {
    return row ? (normalizeSettings(JSON.parse(row.json)) as EngineSettings) : defaultAiSettings();
  } catch {
    return defaultAiSettings();
  }
}

const TIERS = ["fast", "standard", "deep"] as const;
type Tier = (typeof TIERS)[number];
export type AiModels = Partial<Record<string, Tier>>;

function modelsOf(raw: unknown): AiModels {
  const given = (raw as { models?: Record<string, unknown> } | null)?.models;
  const out: AiModels = {};
  for (const [feature, tier] of Object.entries(given ?? {}))
    if (TIERS.includes(tier as Tier)) out[feature] = tier as Tier;
  return out;
}

/** The model each job runs on when the API does it: fast, standard or deep (site-runtime's MODEL_IDS). A job with none saved uses its own default. */
export async function readAiModels(db: D1Database): Promise<AiModels> {
  const row = await drizzle(db).select().from(aiSettings).where(eq(aiSettings.id, 1)).get();
  try {
    return row ? modelsOf(JSON.parse(row.json)) : {};
  } catch {
    return {};
  }
}

/** The model id for a job: its saved tier, else `fallback`. */
export function aiModel(models: AiModels, feature: string, fallback: Tier): string {
  return MODEL_IDS[models[feature] ?? fallback];
}

export async function saveAiSettings(
  db: D1Database,
  viewer: Viewer,
  input: unknown,
): Promise<EngineSettings> {
  if (!viewer.isOwner) throw new Response("Not found", { status: 404 });
  const settings = normalizeSettings(input) as EngineSettings;
  // The model per job rides in the same row; site-runtime's settings do not know it.
  const json = JSON.stringify({ ...settings, models: modelsOf(input) });
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

/**
 * Records an API call another service made for Carrel's job and metered itself (the site's picture suggester), at no cost
 * here: the call is counted, and its tokens are in that site's own log (`anthropic_call`).
 */
export async function recordForeignCall(db: D1Database, feature: FeatureKey, model: string) {
  await drizzle(db)
    .insert(aiUsage)
    .values({ feature, model, micros: 0, promptSize: 0, answerSize: 0, ok: true });
}

/** The share of the monthly cap at which Dustin is emailed, once a month. */
const CAP_ALERT_AT = 0.8;

/**
 * Emails the alert address once a month when the API spend reaches 80% of the cap, so the cap closing never comes as a
 * surprise. A failed email never fails the call that spent: the page shows the spend too.
 */
export async function capAlert(env: Env, now = new Date()): Promise<boolean> {
  try {
    const settings = await readAiSettings(env.DB);
    if (settings.apiCapMicros <= 0) return false;
    const spent = await monthSpendMicros(env.DB, now);
    if (spent < settings.apiCapMicros * CAP_ALERT_AT) return false;
    const month = now.toISOString().slice(0, 7);
    if (!(await d1FireStore(env.DB).add(`ai-cap-alert:${month}`, now.toISOString()))) return false;
    const sent = await sendEmail(env.EMAIL, {
      from: env.ALERT_FROM,
      to: env.ALERT_EMAIL,
      subject: "Carrel: the API is at 80% of this month's cap",
      text: [
        `Carrel's AI work has spent $${(spent / 1_000_000).toFixed(2)} of the $${(settings.apiCapMicros / 1_000_000).toFixed(2)} monthly API cap.`,
        "At the cap the API closes: jobs set to the API use the subscription instead, and Automatic stops falling back.",
        "Raise the cap or switch jobs to the subscription on the AI engine page.",
        "",
      ].join("\n"),
    });
    return sent.sent;
  } catch {
    return false;
  }
}

/** Call options that record the call's cost under `feature`, even when the call failed (it still spent tokens). */
export function meteredOptions(env: Env, feature: FeatureKey): CallOptions {
  const db = env.DB;
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
      await capAlert(env);
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
  const models = await readAiModels(env.DB);
  return structured<{ text: string }>(
    env,
    "carrel",
    {
      model: aiModel(models, "social", "standard"),
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
    { ...meteredOptions(env, "social"), ...(fetcher ? { fetcher } : {}) },
  );
}

// ---------- an episode's summary and chapters through the API

const EPISODE_SCHEMA = {
  type: "object",
  properties: {
    excerpt: { type: "string" },
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: { start: { type: "integer" }, title: { type: "string" } },
        required: ["start", "title"],
        additionalProperties: false,
      },
    },
  },
  required: ["excerpt", "chapters"],
  additionalProperties: false,
};

const isEmpty = (v: string) => v === "" || v === '""' || v === "null" || v === "[]";

/**
 * Drafts an episode's empty summary and chapters from its transcript and saves the episode as an AI draft beside the
 * working text, as the routine does. Fields that already hold something are left as they are; chapter times come only
 * from the transcript's own timestamps.
 */
export async function draftEpisodeViaApi(
  env: Env,
  project: SiteProject,
  viewer: Viewer,
  episode: { id: string; title: string; source: string; transcript: string },
  fetcher?: typeof fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parts = splitSource(episode.source.replace(/\r\n/g, "\n"));
  if (parts.front === null) return { ok: false, error: "The episode has no front matter." };
  const front = parts.front;
  const models = await readAiModels(env.DB);
  const needSummary = isEmpty(readKey(front, "excerpt").trim());
  const needChapters = isEmpty(readKey(front, "chapters").trim());
  if (!needSummary && !needChapters) return { ok: true };
  const result = await structured<{
    excerpt: string;
    chapters: { start: number; title: string }[];
  }>(
    env,
    "carrel",
    {
      model: aiModel(models, "episode", "standard"),
      max_tokens: 4000,
      system: [
        "Write a summary and chapters for the podcast episode below from its transcript. The summary is two or three plain sentences saying what the listener learns. Chapters are a list of { start, title }, start in whole seconds. Take chapter times only from the transcript's own timestamps; if it has none, return an empty list.",
        WRITING_RULES,
        UNTRUSTED_DATA_RULE,
      ].join("\n\n"),
      messages: [
        {
          role: "user",
          content: [
            untrusted("title", episode.title),
            untrusted("transcript", episode.transcript.slice(0, 300_000)),
          ].join("\n"),
        },
      ],
    },
    EPISODE_SCHEMA,
    { ...meteredOptions(env, "episode"), ...(fetcher ? { fetcher } : {}) },
  );
  if (!result.ok) return { ok: false, error: result.error };
  let next = front;
  const summary = result.value.excerpt.replace(/\s+/g, " ").trim();
  if (needSummary && summary)
    next = setBlock(next, "excerpt", [`excerpt: ${JSON.stringify(summary)}`]);
  const chapters = result.value.chapters
    .filter((c) => Number.isInteger(c.start) && c.start >= 0 && c.title.trim())
    .map((c) => ({ start: c.start, title: c.title.trim() }));
  if (needChapters && chapters.length)
    next = setBlock(next, "chapters", [`chapters: ${JSON.stringify(chapters)}`]);
  if (next === front) return { ok: true };
  await saveAiDraft(env, project, { viewer, client: "Carrel (Claude API)" }, episode.id, {
    source: joinSource({ ...parts, front: next }),
    note: "Summary and chapters written through the Claude API from the transcript; nothing else changed.",
  });
  return { ok: true };
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
  model: string = MODEL_IDS.standard,
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
      model: model,
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
    meteredOptions(env, "seo"),
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
