// Writing help on the AI switch: continue a post or a book file, suggest edits, and the search description. Each job runs
// on the engine its setting names (site-runtime ./ai-engine): the API writes it, the subscription's routine is told to
// write it with Carrel's own MCP tools. Either way the result is an AI draft beside Dustin's text, never over it, and
// only a button press starts one (CLAUDE.md: AI never rewrites his prose unasked). The voice excerpts, the writing rules
// and the draft stores are the ones the MCP tools use; nothing here duplicates them.

import { runAi } from "@dustinedwards/site-runtime/ai-engine";
import { structured, untrusted, UNTRUSTED_DATA_RULE } from "@dustinedwards/site-runtime/anthropic";
import { WRITING_RULES } from "@dustinedwards/site-runtime/prose";
import { joinSource } from "@drdustinedwards/site-helpers/frontmatter";

import {
  aiRun,
  type FeatureKey,
  meteredOptions,
  monthSpendMicros,
  onlyEngine,
  readAiChoices,
  readAiSettings,
  suggestSeo,
  workingParts,
} from "~/lib/ai-engine.server";
import { AiRefusal, saveAiDraft, type AiSession } from "~/lib/ai.server";
import {
  changeInDoc,
  commentInDoc,
  indexed,
  readGoogleDoc,
  type EditAsked,
  type Skipped,
} from "~/lib/google/docs.server";
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

/** What one job did: the API's result, the routine's session, or why neither ran. */
type Ran<T> =
  | ({ ok: true; engine: "api" } & T)
  | { ok: true; engine: "subscription"; sessionUrl: string | null }
  | { ok: false; error: string; engine?: "api" | "subscription" | null };

export type WriteResult = Ran<{ draftId: number }>;

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
 * Runs one writing job on the engine its setting names (or the one Dustin forced for this run). `api` does the job and
 * returns what it made (a stored draft's id, the suggestions laid in a Doc); `routine` is the prompt the subscription's
 * routine is fired with, once a minute per job.
 */
async function runWrite<T extends object>(
  env: Env,
  job: FeatureKey,
  only: Only,
  routine: { key: string; prompt: string },
  api: (choices: Choices) => Promise<({ ok: true } & T) | { ok: false; error: string }>,
  fetcher?: typeof fetch,
): Promise<Ran<T>> {
  const [settings, choices] = await Promise.all([readAiSettings(env.DB), readAiChoices(env.DB)]);
  let made: ({ ok: true } & T) | undefined;
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
          const result = await api(choices);
          if (result.ok) made = result;
          return result;
        },
  });
  if (!ran.ok) return { ok: false, error: ran.error, engine: ran.engine };
  if (ran.engine === "api") return { ...made!, engine: "api" };
  const fire = ran.fire as { sessionUrl?: string };
  return { ok: true, engine: "subscription", sessionUrl: fire.sessionUrl ?? null };
}

/** The new text of a job: the passage added after what is written, or the whole edited text. */
const nextText = (job: "continue" | "edit", before: string, written: string) =>
  job === "continue" ? `${before.replace(/\s+$/, "")}\n\n${written}\n` : written;

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

type DocJob = "docs-edit" | "docs-write" | "docs-review";

const QUOTE_RULE =
  "Every quote is copied exactly from the Doc's text, sits inside one paragraph, is long enough to appear only once, and leaves out anything marked {+like this+} or [-like this-]: those are pending suggestions.";

const DOC_INSTRUCTION: Record<DocJob, string> = {
  "docs-edit":
    'Dustin asks for changes to his Google Doc. Make only the changes his request asks for. Each edit has kind "replace" (quote: the words to change; text: what replaces them, "" deletes them) or kind "insert" (quote: the words the text goes right after). Keep his voice, sentence rhythm and word choices, and leave everything the request does not touch exactly as written. Give each edit a one-line reason.',
  "docs-write":
    'Dustin asks for new text in his Google Doc. Write it in his own voice, taken from his passages in the Doc, as edits of kind "insert": quote is the words the new text goes right after, and text starts with the space or line break it needs. Write only what the request asks for and change none of his words. Give each edit a one-line reason.',
  "docs-review":
    "Dustin asks for a review of his Google Doc. Answer with comments, each on the words it is about: what is wrong, unclear or missing, and why, in a few sentences. Suggest wording only inside a comment; change nothing. Comment only where it helps, at most 20 times.",
};

const EDITS_SCHEMA = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["replace", "insert"] },
          quote: { type: "string" },
          text: { type: "string" },
          reason: { type: "string" },
        },
        required: ["kind", "quote", "text", "reason"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: ["edits", "note"],
  additionalProperties: false,
};

const COMMENTS_SCHEMA = {
  type: "object",
  properties: {
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: { quote: { type: "string" }, text: { type: "string" } },
        required: ["quote", "text"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: ["comments", "note"],
  additionalProperties: false,
};

/** What Carrel's engine laid in the Doc: the change's answer, or the comments, and what it could not place. */
type DocDone = {
  model: string;
  note: string;
  comments?: { id: string | null; quote: string }[];
  skipped?: Skipped[];
} & Partial<Awaited<ReturnType<typeof changeInDoc>>>;

type DocAsk = {
  job: DocJob;
  /** Dustin's request, as the AI or the panel passed it on. */
  ask: string;
  mode?: "suggest" | "write";
  tab?: string;
  heading?: string;
  /** The words Dustin selected in the Doc (the Docs panel), which the request is about. */
  selection?: string;
};

/** What the routine is told: the same job, done with Carrel's own Docs tools. */
function docPrompt(docId: string, input: DocAsk): string {
  const how =
    input.job === "docs-review"
      ? "leave comments with carrel_comment_doc and change nothing"
      : input.mode === "write"
        ? 'make the change with carrel_change_doc in mode "write": Dustin asked for a direct write'
        : "lay the change in as suggestions with carrel_change_doc";
  return [
    `Carrel asks for one job in the Google Doc ${untrusted("doc", docId)}${input.tab ? `, tab ${untrusted("tab", input.tab)}` : ""}${input.heading ? `, section ${untrusted("heading", input.heading)}` : ""}. Dustin's request: ${untrusted("request", input.ask)}.${input.selection ? ` It is about these words in the Doc: ${untrusted("selection", input.selection)}.` : ""} Read the Doc with carrel_read_doc, then ${how}. Do only what he asked for.`,
    DOC_INSTRUCTION[input.job],
    UNTRUSTED_DATA_RULE,
  ].join("\n\n");
}

/**
 * "Carrel writes it": Dustin's request about a Doc, passed on by any AI or the Docs panel, done by Carrel's own engine
 * with the model and effort set on the AI page, so the result is the same whichever AI he asked. The API's answer goes
 * through the same Docs functions every AI uses, labeled as Carrel's engine for the AI that asked; the subscription's
 * routine is told to do it with the Docs tools. The Doc's lock and the Owner check apply before anything is spent.
 */
export async function writeInDoc(
  env: Env,
  session: AiSession,
  docId: string,
  input: DocAsk,
  fetcher?: typeof fetch,
) {
  const ask = input.ask.trim();
  if (!ask) throw new AiRefusal("ask is Dustin's request, in his words.");
  const review = input.job === "docs-review";
  await indexed(
    env,
    session.viewer,
    docId,
    input.mode === "write" && !review ? "write" : "suggest",
  );
  const doc = await readGoogleDoc(
    env,
    session.viewer,
    docId,
    { tab: input.tab, heading: input.heading },
    fetcher,
  );
  if (doc.truncated && !input.tab && !input.heading)
    throw new AiRefusal(
      "This Doc is too long to hand over whole. Name a tab or heading for the part the request is about.",
    );
  const carrel: AiSession = {
    viewer: session.viewer,
    client: `Carrel (Claude API) for ${session.client}`,
  };
  return runWrite<DocDone>(
    env,
    input.job,
    undefined,
    { key: `docs:${docId}:${input.job}:${ask.slice(0, 100)}`, prompt: docPrompt(docId, input) },
    async (choices) => {
      const run = aiRun(choices, input.job);
      const result = await structured<{
        edits?: { kind: "replace" | "insert"; quote: string; text: string; reason: string }[];
        comments?: { quote: string; text: string }[];
        note: string;
      }>(
        env,
        "carrel",
        {
          ...run,
          max_tokens: 16_000,
          system: [DOC_INSTRUCTION[input.job], QUOTE_RULE, WRITING_RULES, UNTRUSTED_DATA_RULE].join(
            "\n\n",
          ),
          messages: [
            {
              role: "user",
              content: [
                untrusted("request", ask),
                input.selection ? untrusted("selection", input.selection) : "",
                untrusted("doc", doc.text),
              ].join("\n"),
            },
          ],
        },
        review ? COMMENTS_SCHEMA : EDITS_SCHEMA,
        {
          ...meteredOptions(env, input.job, run.output_config.effort),
          ...(fetcher ? { fetcher } : {}),
        },
      );
      if (!result.ok) return { ok: false as const, error: result.error };
      const note = result.value.note.trim().slice(0, 500);
      const reason = `Dustin asked: ${ask}`.slice(0, 300);
      if (review) {
        const comments: { id: string | null; quote: string }[] = [];
        const skipped: Skipped[] = [];
        for (const c of (result.value.comments ?? []).slice(0, 20)) {
          try {
            const made = await commentInDoc(
              env,
              session.viewer,
              carrel,
              docId,
              { quote: c.quote, text: c.text, tab: input.tab, model: run.model },
              fetcher,
            );
            comments.push({ id: made.id, quote: c.quote });
          } catch (error) {
            if (!(error instanceof AiRefusal)) throw error;
            skipped.push({ quote: c.quote, why: error.message });
          }
        }
        if (comments.length === 0 && skipped.length)
          return { ok: false as const, error: skipped[0]!.why };
        return { ok: true as const, model: run.model, note, comments, skipped };
      }
      const edits: EditAsked[] = (result.value.edits ?? []).map((e) =>
        e.kind === "insert"
          ? { insert_after: e.quote, text: e.text, reason: e.reason }
          : { find: e.quote, replace: e.text, reason: e.reason },
      );
      if (edits.length === 0)
        return { ok: false as const, error: note || "The model wrote no edits." };
      const changed = await changeInDoc(
        env,
        session.viewer,
        carrel,
        docId,
        { edits, reason, tab: input.tab, model: run.model, mode: input.mode, skipUnfound: true },
        fetcher,
      );
      return { ok: true as const, model: run.model, note, ...changed };
    },
    fetcher,
  );
}
