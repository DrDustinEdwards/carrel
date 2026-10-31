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

import { askFirst, readMentionsQuery, runMentionsIntent, type ContentSource, type IntentResult, type MentionsData as KitMentions, type MentionsQuery } from "@dustinedwards/site-api/admin";
import type { MentionsData } from "capsomer/react/mentions-list";
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
export function mentionsSource(env: Env, project: SiteProject, viewer: Viewer, fetcher?: typeof fetch): ContentSource {
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
        .values({ projectId: project.id, personId: viewer.id, mentionId: action === "sweep" ? null : (ids[0] ?? null), action, statusAfter: after.get(changeId) ?? null, changeId });
    },
  };
}

const VIEWS = ["pending", "failed", "approved", "rejected", "all"] as const;
type View = (typeof VIEWS)[number];

/** The kit's query from the list's address: the list names its tab `view`, the kit's filter is `status`. */
export function mentionsQuery(search: URLSearchParams): MentionsQuery {
  const view = search.get("view");
  const cursor = search.get("cursor");
  return readMentionsQuery(new URLSearchParams({ ...(view ? { status: view } : {}), ...(cursor ? { cursor } : {}) }));
}

/**
 * The kit's page as MentionsList renders it: each mention in the queue's words (the sender's name, the
 * source's host as text, never a link), the counts with All, and what the site offers.
 */
export function mentionsView(kit: KitMentions, search: URLSearchParams): MentionsData {
  const open = search.get("open");
  const view: View = (VIEWS as readonly string[]).includes(kit.filter) ? (kit.filter as View) : "all";
  return {
    site: { name: kit.site.name },
    query: { view, ...(kit.query.cursor ? { cursor: kit.query.cursor } : {}), ...(open ? { open } : {}) },
    rows: kit.rows.map((m) => ({
      id: m.id,
      author: m.authorName ?? "An unnamed sender",
      host: URL.canParse(m.sourceUrl) ? new URL(m.sourceUrl).host : m.sourceUrl,
      url: m.sourceUrl,
      excerpt: m.excerpt ?? "",
      post: m.targetId,
      postHref: m.postHref,
      at: m.receivedAt,
      state: m.status,
      ...(m.decidedAt ? { decidedAt: m.decidedAt } : {}),
      ...(m.failureReason ? { failureReason: m.failureReason } : {}),
      version: m.version,
    })),
    page: kit.page,
    counts: { ...kit.counts, all: Object.values(kit.counts).reduce((a, b) => a + b, 0) },
    expiring: kit.expiring,
    offers: { reset: kit.offers.reset, delete: true, sweep: true },
    can: kit.can,
  };
}

/** A site that is not connected or cannot be reached, said plainly instead of a crash. null for anything else. */
export function unreachable(error: unknown): string | null {
  if (error instanceof SiteNotConnected) return error.detail;
  if (error instanceof SiteApiError) return "The site did not answer, so its mentions cannot be listed. Try again in a moment.";
  return null;
}

const SEEN_PAGES = 10;

/**
 * The form with what the kit reads for each mention: its version and the status it had. The list's row
 * form posts one `version` and its bulk form none (Capsomer 0.53.0), and neither posts the statuses, which
 * the kit needs to choose each Undo. A version the form names is kept, so a mention changed since is still
 * refused as stale; for the rest the site's own is read, as the bulk decide did before the kit. An Undo
 * carries its own versions and statuses and is passed on as it came.
 */
async function withSeen(client: SiteClient, form: FormData): Promise<{ seen: FormData; names: Map<string, string> }> {
  const ids = form.getAll("ids").map(String);
  const names = new Map<string, string>();
  if (ids.length === 0 || form.getAll("statuses").length > 0) return { seen: form, names };
  const posted = form.getAll("versions").map(String);
  const single = ids.length === 1 ? String(form.get("version") ?? "") : "";
  const found = new Map<string, { version: string; status: MentionStatus }>();
  let cursor: string | undefined;
  for (let page = 0; page < SEEN_PAGES && found.size < ids.length; page++) {
    const list = await client.mentions.list({ limit: 200, ...(cursor ? { cursor } : {}) });
    for (const m of list.items) {
      if (!ids.includes(m.id)) continue;
      found.set(m.id, { version: m.version, status: m.status });
      names.set(m.id, `${m.authorName ?? "An unnamed sender"} on ${m.targetId}`);
    }
    if (!list.nextCursor) break;
    cursor = list.nextCursor;
  }
  const out = new FormData();
  for (const [key, value] of form) if (key !== "versions" && key !== "statuses" && key !== "version") out.append(key, value);
  ids.forEach((id, i) => {
    out.append("versions", posted[i] || single || found.get(id)?.version || "");
    out.append("statuses", found.get(id)?.status ?? "");
  });
  return { seen: out, names };
}

/** One posted intent, as the kit runs it. The same for the list's forms with no script and the mentions endpoint's. */
export async function runIntent(env: Env, viewer: Viewer, slug: string | undefined, form: FormData): Promise<IntentResult> {
  // Refused on the role before the site is asked anything: only the Owner reaches it.
  const project = await requireSiteProject(env.DB, viewer, slug, "decide_mention");
  return answer(async () => {
    const source = mentionsSource(env, project, viewer);
    // The sweep removes the only copy of what each sender sent, so the list asks first; the kit sweeps when told.
    if (form.get("intent") === "sweep" && form.get("confirm") !== "sweep") {
      const { expiring } = await source.client.mentions.list({ limit: 1 });
      const n = expiring.failed + expiring.rejected;
      const title = `Remove ${n} expired mention${n === 1 ? "" : "s"}?`;
      return {
        ok: false,
        message: title,
        confirm: {
          intent: "sweep",
          title,
          lead: "The site removes these permanently. Nothing else has a copy of them.",
          action: `Remove ${n}`,
          items: [`${expiring.failed} failed`, `${expiring.rejected} rejected`],
          fields: { confirm: "sweep" },
        },
      };
    }
    const { seen, names } = await withSeen(source.client, form);
    // A delete removes the only copy too, so it asks first with the count to type; the kit deletes when told.
    if (seen.get("intent") === "delete") {
      const ids = seen.getAll("ids").map(String);
      const ask = askFirst(seen, {
        intent: "delete",
        title: `Delete ${ids.length} mention${ids.length === 1 ? "" : "s"} permanently?`,
        lead: `Each mention below is removed from ${source.site.name}. This removes the only copy of what the sender sent; nothing else has one. Reject it instead if you may want it back.`,
        action: `Delete ${ids.length}`,
        items: ids.map((id) => names.get(id) ?? `Mention ${id}`),
        fields: { ids, versions: seen.getAll("versions").map(String), statuses: seen.getAll("statuses").map(String) },
      });
      if (ask) return ask;
    }
    return await runMentionsIntent(source, seen);
  }, unreachable);
}
