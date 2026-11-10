// Writing's two additions to the list in desk.server.ts: the peek (one post's record, opened from its
// row without leaving the list) and the bulk actions across sites. A bulk action names posts on several
// sites at once; each site's share goes through that site's own posts intent (posts.server.ts runIntent,
// the kit's runPostsIntent), so its roles, refusals and Undo are the site's, exactly as on its own list.
// What comes back is merged: one outcome per post, one Undo that undoes every site's part, and one
// confirm for the posts a site asked about first (a Trash where other posts link to one).

import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { findings, projects, siteItems } from "~/db/schema";
import type { Viewer, VisibleProject } from "~/lib/people.server";
import { runIntent } from "~/lib/posts.server";
import { can } from "~/lib/roles";
import { siteConnection, isSiteId } from "~/lib/sites.server";
import { waitingWork } from "~/lib/waiting.server";

/** The intents Writing offers across sites. Each site still decides for its own posts. */
const WRITING_INTENTS = ["tag-add", "tag-remove", "unpublish", "trash"] as const;

/** A post across sites is named "<site slug>/<item id>": a slug never holds a slash, an item id may. */
export const postKey = (slug: string, itemId: string) => `${slug}/${itemId}`;
function splitKey(key: string): { slug: string; itemId: string } | null {
  const at = key.indexOf("/");
  if (at <= 0 || at === key.length - 1) return null;
  return { slug: key.slice(0, at), itemId: key.slice(at + 1) };
}

export type Peek = {
  key: string;
  site: string;
  siteSlug: string;
  itemId: string;
  title: string;
  kind: string;
  status: "draft" | "scheduled" | "published";
  path: string | null;
  liveUrl: string | null;
  publishAt: string | null;
  updateAt: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  syncedAt: string;
  aiDrafts: number;
  ownDraft: boolean;
  flags: number;
  editHref: string;
  historyHref: string;
  siteHref: string;
};

/** One post's record for the peek, or null when the viewer may not read it or it is not indexed. */
export async function peekOf(
  env: Env,
  viewer: Viewer,
  visible: VisibleProject[],
  key: string,
): Promise<Peek | null> {
  const named = splitKey(key);
  if (!named) return null;
  const project = visible.find(
    (p) => p.kind === "site" && p.slug === named.slug && can(p.role, "read"),
  );
  if (!project) return null;
  const d = drizzle(env.DB);
  const [row, open, waiting] = await Promise.all([
    d
      .select()
      .from(siteItems)
      .where(and(eq(siteItems.projectId, project.id), eq(siteItems.itemId, named.itemId)))
      .get(),
    d
      .select({ n: count() })
      .from(findings)
      .where(
        and(
          eq(findings.projectId, project.id),
          eq(findings.path, named.itemId),
          eq(findings.status, "open"),
        ),
      )
      .get(),
    waitingWork(env.DB, { id: project.id, role: project.role }, viewer),
  ]);
  if (!row) return null;
  const site = await siteOf(env, project.id);
  const connection = site ? siteConnection(env, site) : null;
  const w = waiting.find((x) => x.itemId === named.itemId);
  const base = `/p/${encodeURIComponent(project.slug)}`;
  const item = encodeURIComponent(named.itemId);
  return {
    key,
    site: project.name,
    siteSlug: project.slug,
    itemId: named.itemId,
    title: row.title || named.itemId,
    kind: row.kind,
    status: row.status,
    path: row.path,
    liveUrl:
      row.status === "published" && row.path && connection?.state === "connected"
        ? new URL(row.path, connection.origin).href
        : null,
    publishAt: row.publishAt,
    updateAt: row.updateAt,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    syncedAt: row.syncedAt,
    aiDrafts: w?.aiDrafts ?? 0,
    ownDraft: w?.ownDraft ?? false,
    flags: open?.n ?? 0,
    editHref: `${base}/e/${item}`,
    historyHref: `${base}/e/${item}/history`,
    siteHref: base,
  };
}

async function siteOf(env: Env, projectId: number) {
  const row = await drizzle(env.DB)
    .select({ site: projects.site })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  return row && isSiteId(row.site) ? row.site : null;
}

type WritingOutcome = { id: string; label: string; ok: boolean; message?: string };
export type WritingResult = {
  ok: boolean;
  message: string;
  outcomes: WritingOutcome[];
  /** Posted back as it is to undo every site's part. */
  undo?: { intent: "undo"; plan: string };
  /** The posts a site asked about before acting; the others were done. */
  confirm?: {
    intent: string;
    title: string;
    lead: string;
    action: string;
    items: string[];
    ids: string[];
    tag: string;
    typeToConfirm: string;
  };
};

type Plan = Array<{ slug: string; intent: string; fields: Record<string, string | string[]> }>;

const DONE: Record<string, string> = {
  "tag-add": "Tagged",
  "tag-remove": "Untagged",
  unpublish: "Unpublished",
  trash: "Moved to the Trash",
  undo: "Undid",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function formOf(fields: Record<string, string | string[]>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields))
    for (const one of Array.isArray(v) ? v : [v]) form.append(k, one);
  return form;
}

/** Why a site's whole share failed, in words: a refusal the app threw, or the site not answering. */
function failure(error: unknown): string {
  if (error instanceof Response)
    return error.status === 403
      ? "You cannot change posts on this site."
      : error.status === 404
        ? "That site is not in Carrel."
        : `The site answered ${error.status}.`;
  return error instanceof Error ? error.message : "The site could not be reached.";
}

/**
 * One site's answer as one outcome per post. A site that refused the whole request says it once: each of
 * its posts it did not name carries the reason.
 */
function siteOutcomes(
  slug: string,
  ids: string[],
  result: {
    ok: boolean;
    message: string;
    outcomes?: { id: string; ok: boolean; message: string }[];
  },
  labels: (key: string) => string,
): WritingOutcome[] {
  const out: WritingOutcome[] = [];
  const seen = new Set<string>();
  for (const o of result.outcomes ?? []) {
    seen.add(o.id);
    const id = postKey(slug, o.id);
    out.push({ id, label: labels(id), ok: o.ok, message: o.message || undefined });
  }
  for (const itemId of ids.filter((i) => !seen.has(i))) {
    const id = postKey(slug, itemId);
    out.push({
      id,
      label: labels(id),
      ok: result.ok,
      message: result.ok ? undefined : result.message,
    });
  }
  return out;
}

/**
 * Runs one Writing intent on posts across sites, each site's posts through that site's own posts intent.
 * `labels` names each post for the outcomes ("<title> · <site>"); it is the list's own text, never trusted for access.
 */
export async function runWritingIntent(
  env: Env,
  viewer: Viewer,
  form: FormData,
  labels: (key: string) => string,
): Promise<WritingResult> {
  const intent = String(form.get("intent") ?? "");
  if (intent === "undo") return runPlan(env, viewer, String(form.get("plan") ?? ""), labels);
  if (!(WRITING_INTENTS as readonly string[]).includes(intent))
    return { ok: false, message: "That is not something Writing can do.", outcomes: [] };
  const keys = [...new Set(form.getAll("ids").map(String))];
  if (keys.length === 0)
    return { ok: false, message: "Tick at least one post first.", outcomes: [] };
  const bySite = new Map<string, string[]>();
  const outcomes: WritingOutcome[] = [];
  for (const key of keys) {
    const named = splitKey(key);
    if (!named) {
      outcomes.push({ id: key, label: key, ok: false, message: "That is not a post." });
      continue;
    }
    bySite.set(named.slug, [...(bySite.get(named.slug) ?? []), named.itemId]);
  }
  const tag = String(form.get("tag") ?? "");
  const confirmed = String(form.get("confirm") ?? "").trim();
  const plan: Plan = [];
  const asked: { slug: string; ids: string[]; title: string; lead: string; action: string }[] = [];
  await Promise.all(
    [...bySite].map(async ([slug, ids]) => {
      const fields: Record<string, string | string[]> = { intent, ids };
      if (tag) fields.tag = tag;
      // The person confirmed the whole list once; each site checks its own count.
      if (confirmed !== "" && confirmed === String(keys.length))
        fields.confirm = String(ids.length);
      try {
        const result = await runIntent(env, viewer, slug, formOf(fields));
        if (result.confirm) {
          asked.push({
            slug,
            ids,
            title: result.confirm.title,
            lead: result.confirm.lead ?? "",
            action: result.confirm.action,
          });
          return;
        }
        outcomes.push(...siteOutcomes(slug, ids, result, labels));
        if (result.undo)
          plan.push({ slug, intent: result.undo.intent, fields: result.undo.fields });
      } catch (error) {
        outcomes.push(...siteOutcomes(slug, ids, { ok: false, message: failure(error) }, labels));
      }
    }),
  );
  return merged(intent, outcomes, plan, asked, tag, labels);
}

async function runPlan(
  env: Env,
  viewer: Viewer,
  raw: string,
  labels: (key: string) => string,
): Promise<WritingResult> {
  let plan: Plan;
  try {
    plan = JSON.parse(raw) as Plan;
    if (!Array.isArray(plan)) throw new Error("not a list");
  } catch {
    return { ok: false, message: "That Undo could not be read.", outcomes: [] };
  }
  const outcomes: WritingOutcome[] = [];
  // Each step is checked by its site's intent exactly as a fresh request: an Undo can do only what the person may.
  await Promise.all(
    plan.slice(0, 20).map(async (step) => {
      const ids = ([] as string[]).concat(step.fields?.ids ?? []);
      try {
        const result = await runIntent(
          env,
          viewer,
          String(step.slug),
          formOf({ ...step.fields, intent: String(step.intent) }),
        );
        outcomes.push(...siteOutcomes(step.slug, ids, result, labels));
      } catch (error) {
        outcomes.push(
          ...siteOutcomes(step.slug, ids, { ok: false, message: failure(error) }, labels),
        );
      }
    }),
  );
  return merged("undo", outcomes, [], [], "", labels);
}

function merged(
  intent: string,
  outcomes: WritingOutcome[],
  plan: Plan,
  asked: { slug: string; ids: string[]; title: string; lead: string; action: string }[],
  tag: string,
  labels: (key: string) => string,
): WritingResult {
  const done = outcomes.filter((o) => o.ok).length;
  const left = outcomes.length - done;
  const parts = [
    done > 0 ? `${DONE[intent] ?? "Done"}: ${plural(done, "post")}.` : "",
    left > 0 ? `${plural(left, "post")} left as ${left === 1 ? "it was" : "they were"}.` : "",
  ].filter(Boolean);
  const result: WritingResult = {
    ok: left === 0 && asked.length === 0,
    message: parts.join(" ") || (asked.length > 0 ? "Confirm first." : "Nothing was changed."),
    outcomes,
  };
  if (plan.length > 0) result.undo = { intent: "undo", plan: JSON.stringify(plan) };
  if (asked.length > 0) {
    const ids = asked.flatMap((a) => a.ids.map((i) => postKey(a.slug, i)));
    result.confirm = {
      intent,
      title:
        asked.length === 1 ? asked[0]!.title : `Move ${plural(ids.length, "post")} to the Trash?`,
      lead: asked.map((a) => a.lead).join(" "),
      action: asked[0]!.action,
      items: ids.map(labels),
      ids,
      tag,
      typeToConfirm: String(ids.length),
    };
  }
  return result;
}
