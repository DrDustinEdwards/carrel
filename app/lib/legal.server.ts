// The shared sections of legal pages, and what a write to a legal page needs from them. The
// sections live here and are the Owner's to change; a page picks them up when it is next published.

import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { legalSections } from "~/db/schema";
import type { ContentDoc } from "@dustinedwards/site-api";
import { expandShared, legalTypeOf, pathOf, prepareLegalWrite, SECTION_KEY, valuesOf, type SharedSection } from "~/lib/legal";
import { splitSource } from "~/lib/frontmatter";
import type { Viewer } from "~/lib/people.server";
import type { SiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteEntry } from "~/lib/sites.server";

export type StoredSection = SharedSection & { updatedAt: string };

export async function listSections(db: D1Database): Promise<StoredSection[]> {
  return drizzle(db)
    .select({ key: legalSections.key, title: legalSections.title, body: legalSections.body, updatedAt: legalSections.updatedAt })
    .from(legalSections)
    .orderBy(asc(legalSections.key))
    .all();
}

export type SectionOutcome = { ok: true } | { ok: false; message: string };

/** Shared text reaches every site's public page, so only the Owner changes it. */
export async function saveSection(db: D1Database, project: { role: SiteProject["role"] }, viewer: Viewer, input: { key: string; title: string; body: string }): Promise<SectionOutcome> {
  if (!can(project.role, "manage")) throw new Response("Forbidden", { status: 403 });
  const key = input.key.trim();
  const title = input.title.trim();
  const body = input.body.replace(/\r\n/g, "\n").trim();
  if (!SECTION_KEY.test(key)) return { ok: false, message: "A section's name is lowercase words joined by hyphens, like cloudflare-hosting." };
  if (!title || !body) return { ok: false, message: "A section needs a title and its text." };
  const dash = /[–—]/.exec(body + title);
  if (dash) return { ok: false, message: `The text has a wide dash (${dash[0]}); the site's pages refuse it. Use a comma, period or colon.` };
  await drizzle(db)
    .insert(legalSections)
    .values({ key, title, body, updatedBy: viewer.id })
    .onConflictDoUpdate({ target: legalSections.key, set: { title, body, updatedBy: viewer.id, updatedAt: new Date().toISOString() } });
  return { ok: true };
}

export async function deleteSection(db: D1Database, project: { role: SiteProject["role"] }, key: string): Promise<void> {
  if (!can(project.role, "manage")) throw new Response("Forbidden", { status: 403 });
  await drizzle(db).delete(legalSections).where(eq(legalSections.key, key));
}

export type LegalCheck = { ok: true; source: string } | { ok: false; message: string };

/**
 * What Carrel does to a write before the site sees it, for a legal page or an item the site keeps
 * public: refuse to take a kept-public page down or move it, then expand shared sections and stamp
 * `last_updated`. Any other item passes through unchanged.
 */
export async function checkLegalWrite(
  db: D1Database,
  project: SiteProject,
  itemId: string,
  request: { action: "save" | "publish" | "schedule" | "unpublish"; source?: string },
  current: ContentDoc | null,
  now: Date,
): Promise<LegalCheck> {
  const keptPublic = siteEntry(project.site).keepPublic.includes(itemId);
  if (keptPublic && request.action === "unpublish") {
    return { ok: false, message: "This page is the license named by the site's data. Carrel keeps it public; change its wording instead." };
  }
  const source = request.source;
  if (source === undefined) return { ok: true, source: "" };
  const legal = keptPublic || legalTypeOf(source) !== null || (current !== null && legalTypeOf(current.source) !== null);
  if (!legal) return { ok: true, source };
  if (current && pathOf(current.source) !== pathOf(source)) {
    return { ok: false, message: `A legal page's path is fixed in Carrel (${pathOf(current.source) ?? "none"}): the site's code and its data name it.` };
  }
  if (request.action === "schedule") return { ok: true, source };
  const live = request.action === "publish" || (request.action === "save" && current !== null && current.status !== "draft");
  const prepared = prepareLegalWrite({
    source,
    stored: current?.source ?? null,
    storedPublic: current !== null && current.status !== "draft",
    sections: await listSections(db),
    public: live,
    today: now.toISOString().slice(0, 10),
  });
  return prepared.ok ? { ok: true, source: prepared.source } : prepared;
}

/** Whether a page's body still matches what its shared sections now say, for the Legal tab. */
export async function sectionsCurrent(db: D1Database, source: string): Promise<boolean> {
  const body = splitSource(source).body;
  return expandShared(body, await listSections(db), valuesOf(source)).text === body;
}
