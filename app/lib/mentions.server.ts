// Webmentions on a site project over the content kit (site-api's admin half): Carrel and every site's
// own admin run the same loader and the same intents, and the screen is Capsomer's MentionsList.
// Mentions are text strangers chose, so the list shows them as text; each decision is one site write,
// in order, and one failing never stops the rest.
//
// Roles: the inbox belongs to Dustin alone (his design decision, 2026-09-26), so reading the queue
// (read_mentions) and deciding (decide_mention) are both the Owner's, refused before the site is asked.
// Change roles.ts, not this file, to open it wider.
//
// Authorship: every write the site carried out writes one row in mention_decisions (migration 0011),
// with the change id Carrel sent the site so the two histories join, and the status it left the
// mention in. A refused write writes nothing. The write and the site's cache purge are one unit on the
// site's side; Carrel reports its answer.

import {
  loadMentions,
  runMentionsIntent,
  type ContentSource,
  type IntentResult,
  type MentionsData as KitMentions,
  type MentionsQuery,
} from "@dustinedwards/site-api/admin";
import { SiteApiError, type SiteClient } from "@dustinedwards/site-api/client";
import type { MentionStatus } from "@dustinedwards/site-api";
import { drizzle } from "drizzle-orm/d1";

import { mentionDecisions } from "~/db/schema";
import type { Viewer } from "~/lib/people.server";
import { answer, kitBase } from "~/lib/kit.server";
import { requireSiteProject, type SiteProject } from "~/lib/projects.server";
import { siteClient, SiteNotConnected } from "~/lib/sites.server";

const ACTIONS: Record<string, (typeof mentionDecisions.$inferInsert)["action"]> = {
  "mention-approve": "approve",
  "mention-reject": "reject",
  "mention-reset": "reset",
  "mention-delete": "delete",
  "mention-sweep": "sweep",
};

/** The site's client, noting the status each decision left a mention in, by change id, for the record. */
function noting(client: SiteClient, after: Map<string, MentionStatus>): SiteClient {
  const mentions = client.mentions;
  return {
    ...client,
    mentions: {
      ...mentions,
      async decide(id, input) {
        const written = await mentions.decide(id, input);
        after.set(input.changeId, written.status);
        return written;
      },
    },
  };
}

/** One site's mention queue, as the content kit reads and decides it for this person. */
export function mentionsSource(
  env: Env,
  project: SiteProject,
  viewer: Viewer,
  fetcher?: typeof fetch,
): ContentSource {
  const after = new Map<string, MentionStatus>();
  return {
    ...kitBase(env, project),
    client: noting(siteClient(env, project.site, fetcher), after),
    editorHref: (id) => `/p/${encodeURIComponent(project.slug)}/e/${encodeURIComponent(id)}`,
    async record({ kind, ids, changeId }) {
      const action = ACTIONS[kind];
      if (!action) return;
      await drizzle(env.DB)
        .insert(mentionDecisions)
        .values({
          projectId: project.id,
          personId: viewer.id,
          mentionId: action === "sweep" ? null : (ids[0] ?? null),
          action,
          statusAfter: after.get(changeId) ?? null,
          changeId,
        });
    },
  };
}

/** A site that is not connected or cannot be reached, said plainly instead of a crash. null for anything else. */
export function unreachable(error: unknown): string | null {
  if (error instanceof SiteNotConnected) return error.detail;
  if (error instanceof SiteApiError)
    return "The site did not answer, so its mentions cannot be listed. Try again in a moment.";
  return null;
}

/** One posted intent, as the kit runs it. The same for the list's forms with no script, the mentions endpoint's and the MCP tools'. */
export async function runIntent(
  env: Env,
  viewer: Viewer,
  slug: string | undefined,
  form: FormData | Record<string, string | string[]>,
  fetcher?: typeof fetch,
): Promise<IntentResult> {
  // Refused on the role before the site is asked anything: only the Owner reaches it. The kit asks before a delete or a
  // sweep, and reads the versions and statuses a form did not post (site-api v0.26.0).
  const project = await requireSiteProject(env.DB, viewer, slug, "decide_mention");
  return answer(
    () => runMentionsIntent(mentionsSource(env, project, viewer, fetcher), form),
    unreachable,
  );
}

/** One page of a site's queue for the Owner, as the kit reads it: the mentions tools' read. */
export async function readMentions(
  env: Env,
  viewer: Viewer,
  slug: string,
  query: MentionsQuery,
  fetcher?: typeof fetch,
): Promise<KitMentions> {
  const project = await requireSiteProject(env.DB, viewer, slug, "read_mentions");
  return loadMentions(mentionsSource(env, project, viewer, fetcher), query);
}
