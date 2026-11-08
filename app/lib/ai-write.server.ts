// Writing help on the AI switch: continue a post or a book file, suggest edits, and the search description. Each job runs
// on the engine its setting names (site-runtime ./ai-engine): the API writes it now, the subscription's routine is told to
// write it with Carrel's own MCP tools. Either way the result is an AI draft beside Dustin's text, never over it, and
// only a button press starts one (CLAUDE.md: AI never rewrites his prose unasked). The voice excerpts, the writing rules
// and the draft stores are the ones the MCP tools use; nothing here duplicates them.

import { runAi } from "@dustinedwards/site-runtime/ai-engine";
import { structured, untrusted, UNTRUSTED_DATA_RULE } from "@dustinedwards/site-runtime/anthropic";
import { WRITING_RULES } from "@dustinedwards/site-runtime/prose";
import { joinSource, splitSource } from "@drdustinedwards/site-helpers/frontmatter";

import {
  aiModel,
  meteredOptions,
  monthSpendMicros,
  onlyEngine,
  readAiModels,
  readAiSettings,
  suggestSeo,
} from "~/lib/ai-engine.server";
import { saveAiDraft } from "~/lib/ai.server";
import { bookVoice, saveBookAiDraft, type BookProject } from "~/lib/books.server";
import { readDoc, readDraft } from "~/lib/content.server";
import type { Viewer } from "~/lib/people.server";
import type { SiteProject } from "~/lib/projects.server";
import { d1FireStore, fireOnce, routineConfig } from "~/lib/social/routine.server";
import { briefOf, readVoicePack } from "~/lib/voice.server";

export type WriteJob = "seo" | "continue" | "edit";

/** The feature key a job is switched under, in ai-engine.server's FEATURES. */
export const FEATURE_OF: Record<WriteJob, "seo" | "continue" | "edit"> = {
  seo: "seo",
  continue: "continue",
  edit: "edit",
};

const WRITE_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" }, note: { type: "string" } },
  required: ["text", "note"],
  additionalProperties: false,
};

const INSTRUCTION: Record<"continue" | "edit", string> = {
  continue:
    "Continue the text below from where it stops, in the author's own voice, for about as long as the part already written, and return only the new passage. Do not repeat or change anything already written. Take no facts, names or claims the text does not already give; if the next step is unclear, write the most natural next passage and say so in the note.",
  edit: "Edit the text below for clarity and correctness, keeping the author's voice, sentence rhythm and word choices. Change a sentence only where it is wrong, unclear or clumsy; leave every other sentence exactly as written. Return the whole edited text, and say in the note what you changed and why.",
};

export type WriteResult =
  | { ok: true; engine: "api"; draftId: number }
  | { ok: true; engine: "subscription"; sessionUrl: string | null }
  | { ok: false; error: string; engine?: "api" | "subscription" | null };

/** What the routine is told for a post: read it, write it, store it with the tools. */
function postPrompt(project: string, item: string, job: WriteJob): string {
  const task =
    job === "seo"
      ? "Write the page's search description (and a separate search title where the site keeps one), set them in the front matter, and change nothing else."
      : INSTRUCTION[job];
  return [
    `Carrel asks for one writing job on the post ${untrusted("item", item)} of project ${untrusted("project", project)}. Read it with carrel_read_item and read carrel_voice_brief first, write from the excerpts, then check it with carrel_check_post_text. Store the result with carrel_save_draft (the whole post, front matter included, and a one-line note). Do not publish anything.`,
    task,
    UNTRUSTED_DATA_RULE,
  ].join("\n\n");
}

function bookPrompt(project: string, path: string, job: "continue" | "edit"): string {
  return [
    `Carrel asks for one writing job on the book file ${untrusted("path", path)} of project ${untrusted("project", project)}. Read it with carrel_read_book_file (its voice excerpts come with it), write from them, then check it with carrel_check_book_text. Store the result with carrel_save_book_draft (the whole file, header included, and a one-line note). Never commit anything to Git.`,
    INSTRUCTION[job],
    UNTRUSTED_DATA_RULE,
  ].join("\n\n");
}

/** The routine's fire, or no route at all when it is not set up: the engine then reports it, and Automatic uses the API. */
function routineFor(env: Env, key: string, prompt: string, fetcher?: typeof fetch) {
  const config = routineConfig(env);
  if ("missing" in config) return undefined;
  return () => fireOnce(d1FireStore(env.DB), key, config, prompt, fetcher ? { fetcher } : {});
}

/** One writing job on a post. */
export async function writePost(
  env: Env,
  project: SiteProject,
  viewer: Viewer,
  itemId: string,
  job: WriteJob,
  only?: "api" | "subscription",
  fetcher?: typeof fetch,
): Promise<WriteResult> {
  const [settings, models] = await Promise.all([readAiSettings(env.DB), readAiModels(env.DB)]);
  const minute = Math.floor(Date.now() / 60_000);
  let draftId = 0;
  const ran = await runAi({
    settings: onlyEngine(settings, FEATURE_OF[job], only),
    feature: FEATURE_OF[job],
    spentMicros: await monthSpendMicros(env.DB),
    routine: routineFor(
      env,
      `write:${project.slug}:${itemId}:${job}:${minute}`,
      postPrompt(project.slug, itemId, job),
      fetcher,
    ),
    api: !env.ANTHROPIC_API_KEY
      ? undefined
      : async () => {
          if (job === "seo") {
            const made = await suggestSeo(
              env,
              project,
              viewer,
              itemId,
              aiModel(models, "seo", "standard"),
            );
            if (made.ok) draftId = made.draftId;
            return made;
          }
          const working =
            (await readDraft(env.DB, project, viewer, itemId))?.source ??
            (await readDoc(env, project, itemId))?.source;
          if (!working) return { ok: false, error: "This item has no text yet." };
          const parts = splitSource(working.replace(/\r\n/g, "\n"));
          const brief = briefOf(await readVoicePack(env.DB, project));
          const written = await writeText(env, job, parts.body, brief, models, fetcher);
          if (!written.ok) return written;
          const body =
            job === "continue"
              ? `${parts.body.replace(/\s+$/, "")}\n\n${written.text}\n`
              : written.text;
          const saved = await saveAiDraft(
            env,
            project,
            { viewer, client: "Carrel (Claude API)" },
            itemId,
            { source: joinSource({ ...parts, body }), note: written.note },
          );
          draftId = saved.id;
          return { ok: true };
        },
  });
  return answer(ran, () => draftId);
}

/** One writing job on a book file. The search description is a post's; a book file has none. */
export async function writeBookFile(
  env: Env,
  project: BookProject,
  viewer: Viewer,
  path: string,
  job: "continue" | "edit",
  source: string,
  only?: "api" | "subscription",
  fetcher?: typeof fetch,
): Promise<WriteResult> {
  const [settings, models] = await Promise.all([readAiSettings(env.DB), readAiModels(env.DB)]);
  const minute = Math.floor(Date.now() / 60_000);
  let draftId = 0;
  const ran = await runAi({
    settings: onlyEngine(settings, FEATURE_OF[job], only),
    feature: FEATURE_OF[job],
    spentMicros: await monthSpendMicros(env.DB),
    routine: routineFor(
      env,
      `write:${project.slug}:${path}:${job}:${minute}`,
      bookPrompt(project.slug, path, job),
      fetcher,
    ),
    api: !env.ANTHROPIC_API_KEY
      ? undefined
      : async () => {
          const voice = await bookVoice(env.DB, project, path);
          const brief = { rules: "", guide: "", excerpts: voice.excerpts };
          const written = await writeText(env, job, source, brief, models, fetcher);
          if (!written.ok) return written;
          const next =
            job === "continue"
              ? `${source.replace(/\s+$/, "")}\n\n${written.text}\n`
              : written.text;
          const saved = await saveBookAiDraft(
            env.DB,
            project,
            { viewer, client: "Carrel (Claude API)" },
            path,
            { source: next, note: written.note },
          );
          draftId = saved.id;
          return { ok: true };
        },
  });
  return answer(ran, () => draftId);
}

function answer(ran: Awaited<ReturnType<typeof runAi>>, draftId: () => number): WriteResult {
  if (!ran.ok) return { ok: false, error: ran.error, engine: ran.engine };
  if (ran.engine === "api") return { ok: true, engine: "api", draftId: draftId() };
  const fire = ran.fire as { sessionUrl?: string };
  return { ok: true, engine: "subscription", sessionUrl: fire.sessionUrl ?? null };
}

async function writeText(
  env: Env,
  job: "continue" | "edit",
  text: string,
  brief: { rules: string; guide: string; excerpts: string[] },
  models: Awaited<ReturnType<typeof readAiModels>>,
  fetcher?: typeof fetch,
): Promise<{ ok: true; text: string; note: string } | { ok: false; error: string }> {
  const result = await structured<{ text: string; note: string }>(
    env,
    "carrel",
    {
      model: aiModel(models, job, "deep"),
      max_tokens: 16_000,
      system: [INSTRUCTION[job], WRITING_RULES, brief.rules, UNTRUSTED_DATA_RULE]
        .filter(Boolean)
        .join("\n\n"),
      messages: [
        {
          role: "user",
          content: [
            brief.guide ? untrusted("voice-guide", brief.guide) : "",
            ...brief.excerpts.map((e) => untrusted("voice-excerpt", e)),
            untrusted("text", text.slice(0, 300_000)),
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    },
    WRITE_SCHEMA,
    { ...meteredOptions(env, job), ...(fetcher ? { fetcher } : {}) },
  );
  if (!result.ok) return { ok: false, error: result.error };
  const out = result.value.text.trim();
  if (!out) return { ok: false, error: "The model wrote nothing." };
  return { ok: true, text: out, note: result.value.note.trim().slice(0, 500) };
}
