// Writing help on the AI switch: continue a post or a book file, suggest edits, and the search description. Each job runs
// on the engine its setting names (site-runtime ./ai-engine): the API writes it now, the subscription's routine is told to
// write it with Carrel's own MCP tools. Either way the result is an AI draft beside Dustin's text, never over it, and
// only a button press starts one (CLAUDE.md: AI never rewrites his prose unasked). The voice excerpts, the writing rules
// and the draft stores are the ones the MCP tools use; nothing here duplicates them.

import { runAi } from "@dustinedwards/site-runtime/ai-engine";
import { structured, untrusted, UNTRUSTED_DATA_RULE } from "@dustinedwards/site-runtime/anthropic";
import { WRITING_RULES } from "@dustinedwards/site-runtime/prose";
import { joinSource } from "@drdustinedwards/site-helpers/frontmatter";

import {
  aiRun,
  meteredOptions,
  monthSpendMicros,
  onlyEngine,
  readAiChoices,
  readAiSettings,
  suggestSeo,
  workingParts,
} from "~/lib/ai-engine.server";
import { saveAiDraft } from "~/lib/ai.server";
import { bookVoice, saveBookAiDraft, type BookProject } from "~/lib/books.server";
import type { Viewer } from "~/lib/people.server";
import type { SiteProject } from "~/lib/projects.server";
import { getEnv, getViewer } from "~/lib/context";
import { readForm } from "~/lib/form.server";
import { d1FireStore, fireOnce, routineConfig } from "~/lib/social/routine.server";
import { briefOf, readVoicePack } from "~/lib/voice.server";

export type WriteJob = "seo" | "continue" | "edit";

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

type Only = "api" | "subscription" | undefined;
type Choices = Awaited<ReturnType<typeof readAiChoices>>;

/**
 * Runs one writing job on the engine its setting names (or the one Dustin forced for this run). `api` writes and stores
 * the draft and returns its id; `routine` is the prompt the subscription's routine is fired with, once a minute per job.
 */
async function runWrite(
  env: Env,
  job: WriteJob,
  only: Only,
  routine: { key: string; prompt: string },
  api: (choices: Choices) => Promise<{ ok: true; draftId: number } | { ok: false; error: string }>,
  fetcher?: typeof fetch,
): Promise<WriteResult> {
  const [settings, choices] = await Promise.all([readAiSettings(env.DB), readAiChoices(env.DB)]);
  let draftId = 0;
  const ran = await runAi({
    settings: onlyEngine(settings, job, only),
    feature: job,
    spentMicros: await monthSpendMicros(env.DB),
    routine: routineFor(
      env,
      `${routine.key}:${Math.floor(Date.now() / 60_000)}`,
      routine.prompt,
      fetcher,
    ),
    api: !env.ANTHROPIC_API_KEY
      ? undefined
      : async () => {
          const made = await api(choices);
          if (made.ok) draftId = made.draftId;
          return made;
        },
  });
  if (!ran.ok) return { ok: false, error: ran.error, engine: ran.engine };
  if (ran.engine === "api") return { ok: true, engine: "api", draftId };
  const fire = ran.fire as { sessionUrl?: string };
  return { ok: true, engine: "subscription", sessionUrl: fire.sessionUrl ?? null };
}

/** The new text of a job: the passage added after what is written, or the whole edited text. */
const nextText = (job: "continue" | "edit", before: string, written: string) =>
  job === "continue" ? `${before.replace(/\s+$/, "")}\n\n${written}\n` : written;

/** One writing job on a post. */
export function writePost(
  env: Env,
  project: SiteProject,
  viewer: Viewer,
  itemId: string,
  job: WriteJob,
  only?: Only,
  fetcher?: typeof fetch,
): Promise<WriteResult> {
  return runWrite(
    env,
    job,
    only,
    {
      key: `write:${project.slug}:${itemId}:${job}`,
      prompt: postPrompt(project.slug, itemId, job),
    },
    async (choices) => {
      if (job === "seo") {
        const made = await suggestSeo(env, project, viewer, itemId, aiRun(choices, "seo"));
        return made.ok ? { ok: true, draftId: made.draftId } : made;
      }
      const working = await workingParts(env, project, viewer, itemId);
      if (!working.ok) return working;
      const { parts } = working;
      const brief = briefOf(await readVoicePack(env.DB, project));
      const written = await writeText(env, job, parts.body, brief, choices, fetcher);
      if (!written.ok) return written;
      const saved = await saveAiDraft(
        env,
        project,
        { viewer, client: "Carrel (Claude API)" },
        itemId,
        {
          source: joinSource({ ...parts, body: nextText(job, parts.body, written.text) }),
          note: written.note,
        },
      );
      return { ok: true, draftId: saved.id };
    },
    fetcher,
  );
}

/** One writing job on a book file. The search description is a post's; a book file has none. */
export function writeBookFile(
  env: Env,
  project: BookProject,
  viewer: Viewer,
  path: string,
  job: "continue" | "edit",
  source: string,
  only?: Only,
  fetcher?: typeof fetch,
): Promise<WriteResult> {
  return runWrite(
    env,
    job,
    only,
    {
      key: `write:${project.slug}:${path}:${job}`,
      prompt: bookPrompt(project.slug, path, job),
    },
    async (choices) => {
      const voice = await bookVoice(env.DB, project, path);
      const brief = { rules: "", guide: "", excerpts: voice.excerpts };
      const written = await writeText(env, job, source, brief, choices, fetcher);
      if (!written.ok) return written;
      const saved = await saveBookAiDraft(
        env.DB,
        project,
        { viewer, client: "Carrel (Claude API)" },
        path,
        { source: nextText(job, source, written.text), note: written.note },
      );
      return { ok: true, draftId: saved.id };
    },
    fetcher,
  );
}

/** What both writing routes read first: who is asking, the environment, the form and the job it names. */
export async function writeRequest(request: Request, context: Parameters<typeof getEnv>[0]) {
  const form = await readForm(request);
  return {
    viewer: getViewer(context),
    env: getEnv(context),
    form,
    job: String(form.get("job") ?? ""),
  };
}

/** The engine a run was forced onto by the "run it on the other engine" button, from the form. */
export function engineFrom(form: FormData): Only {
  const engine = form.get("engine");
  return engine === "api" || engine === "subscription" ? engine : undefined;
}

/** What the writing buttons show for a result, with the job so the other-engine button can repeat it. */
export function writeAnswer(
  made: WriteResult,
  job: string,
  noun: "text" | "file",
  draftHref?: string,
) {
  if (!made.ok) return { error: made.error, engine: made.engine ?? null, job };
  return made.engine === "api"
    ? {
        engine: made.engine,
        job,
        message: `Written through the Claude API and saved beside your ${noun}.`,
        href: draftHref ? `${draftHref}/${made.draftId}` : null,
      }
    : {
        engine: made.engine,
        job,
        message: `Sent to your subscription's routine. The draft appears beside your ${noun} when it finishes.`,
        href: made.sessionUrl,
      };
}

async function writeText(
  env: Env,
  job: "continue" | "edit",
  text: string,
  brief: { rules: string; guide: string; excerpts: string[] },
  choices: Choices,
  fetcher?: typeof fetch,
): Promise<{ ok: true; text: string; note: string } | { ok: false; error: string }> {
  const run = aiRun(choices, job);
  const result = await structured<{ text: string; note: string }>(
    env,
    "carrel",
    {
      ...run,
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
    { ...meteredOptions(env, job, run.output_config.effort), ...(fetcher ? { fetcher } : {}) },
  );
  if (!result.ok) return { ok: false, error: result.error };
  const out = result.value.text.trim();
  if (!out) return { ok: false, error: "The model wrote nothing." };
  return { ok: true, text: out, note: result.value.note.trim().slice(0, 500) };
}
