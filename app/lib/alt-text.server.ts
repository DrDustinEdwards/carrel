// Alt text for the pictures a site's library holds without it, on the AI switch. The API route asks the site's own suggester
// (site-api's mediaSuggester, the one the library's Suggest button uses) for each file and sets what it returns through
// the Desk's own alt step, which refuses a bad alt. The subscription route fires the routine, which looks at each picture
// and sets the alt with carrel_list_media and carrel_set_media_alt. Neither overwrites an alt that exists: both work from
// the `no-alt` lens.

import { runAi } from "@dustinedwards/site-runtime/ai-engine";
import { untrusted, UNTRUSTED_DATA_RULE } from "@dustinedwards/site-runtime/anthropic";

import {
  monthSpendMicros,
  onlyEngine,
  readAiSettings,
  recordForeignCall,
} from "~/lib/ai-engine.server";
import { listMediaFiles, setMediaAlt, suggestMediaAlt } from "~/lib/media.server";
import type { Viewer } from "~/lib/people.server";
import { d1FireStore, fireOnce, routineConfig } from "~/lib/social/routine.server";
import { plural } from "@drdustinedwards/site-helpers/text";

/** Files one press handles through the API: a page of the library, so a request stays inside the Worker's subrequest budget. */
const API_BATCH = 20;

export type AltResult =
  | { ok: true; engine: "api"; set: number; skipped: number; message: string }
  | { ok: true; engine: "subscription"; message: string; sessionUrl: string | null }
  | { ok: false; error: string };

function prompt(slug: string): string {
  return [
    `Write the missing alt text for the pictures in the media library of project ${untrusted("project", slug)}. List the files that have none with carrel_list_media (its default lens is the files with no alt), look at each picture at its url, and set its alt with carrel_set_media_alt: one plain sentence of at most 25 words saying what the picture shows, with any legible text in it, never beginning "Image of" or "Photo of", and never guessing at names, places or feelings. Mark a picture decorative only when it carries no information. Never change an alt that already exists, and delete nothing.`,
    UNTRUSTED_DATA_RULE,
  ].join("\n\n");
}

export async function writeAltText(
  env: Env,
  viewer: Viewer,
  slug: string,
  only?: "api" | "subscription",
  fetcher?: typeof fetch,
): Promise<AltResult> {
  const settings = await readAiSettings(env.DB);
  const config = routineConfig(env);
  const hour = Math.floor(Date.now() / 3_600_000);
  const tally = { set: 0, skipped: 0, first: "" };
  const ran = await runAi({
    settings: onlyEngine(settings, "alt", only),
    feature: "alt",
    spentMicros: await monthSpendMicros(env.DB),
    routine:
      "missing" in config
        ? undefined
        : () =>
            fireOnce(
              d1FireStore(env.DB),
              `alt:${slug}:${hour}`,
              config,
              prompt(slug),
              fetcher ? { fetcher } : {},
            ),
    api: async () => {
      const page = await listMediaFiles(env, viewer, slug, { lens: "no-alt" }, fetcher);
      if (!page.ok) return { ok: false, error: page.message };
      for (const file of page.files.slice(0, API_BATCH)) {
        const id = String(file.id);
        const made = await suggestMediaAlt(env, viewer, slug, id, fetcher);
        if (!made.ok) return { ok: false, error: made.message };
        await recordForeignCall(env, "alt", made.model, made.usage);
        if (!made.alt) {
          tally.skipped++;
          continue;
        }
        const wrote = await setMediaAlt(
          env,
          viewer,
          slug,
          { id, alt: made.alt, decorative: false },
          fetcher,
        );
        if (wrote.ok) tally.set++;
        else {
          tally.skipped++;
          tally.first ||= wrote.message;
        }
      }
      return { ok: true };
    },
  });
  if (!ran.ok) return { ok: false, error: ran.error };
  if (ran.engine === "api")
    return {
      ok: true,
      engine: "api",
      set: tally.set,
      skipped: tally.skipped,
      message: `Alt text set on ${plural(tally.set, "file")}${tally.skipped ? `; ${tally.skipped} skipped${tally.first ? ` (${tally.first})` : ""}` : ""}. The next press does the next ${API_BATCH}.`,
    };
  const fire = ran.fire as { sessionUrl?: string };
  return {
    ok: true,
    engine: "subscription",
    message:
      "Sent to your subscription's routine. It sets the alt text as it works through the files.",
    sessionUrl: fire.sessionUrl ?? null,
  };
}
