// THE SIGNED-IN CRAWL (completeness area 2). devkit's live check has no Access session, so it sees only Desk's
// redirect to Access. Each quarter hour this grades the pages behind it with site-runtime's crawl (./signed-in-crawl),
// against Desk's registry entry, and stores the report; the AI door serves it at SIGNED_IN_REPORT_PATH, where devkit's
// scoreboard reads it as the reported check "signed-in-security" (devkit live/areas.json). Like Capsid's Portal crawl,
// it runs in-process: the Worker's own browser door after Access (workers/gate.ts `admit`), as the Owner, so no Access
// token or service token exists for it and Desk's Access gate is unchanged.
//
// GET only, so it can never act as the Owner. Desk's actions take form bodies on purpose (every form works with no
// script) and the door refuses a cross-site one by Fetch Metadata, so R4's JSON probe does not apply here and is noted.
// The report holds findings only: a URL, a status and an item, never a page body or a cookie.

import { crawlApp, guardedCrawl, signedInReport, signedInSummary, SIGNED_IN_MISSING_PATH } from "@dustinedwards/site-runtime/signed-in-crawl";
import { carrelDesk } from "@dustinedwards/site-runtime/sites";
import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { people, reports } from "~/db/schema";
import { deployedSha } from "~/lib/deployed";
import { visibleProjects, type Viewer } from "~/lib/people.server";

export const SIGNED_IN_REPORT_NAME = "signed-in-security";

/** The browser door after Access, for one viewer (workers/app.ts). */
export type DeskAs = (request: Request, viewer: Viewer) => Promise<Response>;

const R4_NOTE =
  "not probed on Desk: its actions take form bodies by design (no-script forms) and the door refuses a cross-site one by Fetch Metadata; the crawl only reads (GET)";

async function findOwner(db: D1Database): Promise<Viewer | null> {
  const row = await drizzle(db)
    .select({ id: people.id, email: people.email, name: people.name, isOwner: people.isOwner, isReviewer: people.isReviewer })
    .from(people)
    .where(and(eq(people.isOwner, true), eq(people.isReviewer, false), isNull(people.disabledAt)))
    .orderBy(asc(people.id))
    .get();
  return row ?? null;
}

/** Crawls Desk as the Owner and stores the report. Returns the log line. */
export async function runSignedInCrawl(env: Env, deskAs: DeskAs, now = new Date()): Promise<string> {
  const origin = carrelDesk.origin;
  const desk = await guardedCrawl(async () => {
    const owner = await findOwner(env.DB);
    if (!owner) throw new Error("Carrel has no active Owner to crawl as");
    // The home page first (a refusal there is "error"), then the pages every project and the Owner's tools open, the
    // first site and book project, and a signed-in 404.
    const projects = await visibleProjects(env.DB, owner);
    const site = projects.find((p) => p.kind === "site");
    const book = projects.find((p) => p.kind === "book");
    const pages = ["/", "/people", "/social", ...(site ? [`/p/${site.slug}`, `/p/${site.slug}/media`] : []), ...(book ? [`/b/${book.slug}`] : []), SIGNED_IN_MISSING_PATH];
    return crawlApp({ origin, fetch: (request) => deskAs(request, owner), headers: {}, pages, r4Note: R4_NOTE });
  });
  const report = signedInReport({ [origin]: desk }, { at: now, ref: `carrel ${deployedSha(env).slice(0, 12)}` });
  const body = JSON.stringify(report);
  const at = report.at;
  await drizzle(env.DB).insert(reports).values({ name: SIGNED_IN_REPORT_NAME, body, at }).onConflictDoUpdate({ target: reports.name, set: { body, at } });
  const line = signedInSummary(report);
  return line;
}
