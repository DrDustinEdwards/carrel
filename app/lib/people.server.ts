import { and, asc, eq, isNull, not, like } from "drizzle-orm";
import { adminEmails, isAdminEmail, isMainAdmin } from "@dustinedwards/site-runtime/access";
import { drizzle } from "drizzle-orm/d1";

import { people, projectMembers, projects } from "~/db/schema";
import { agentEmail } from "~/lib/agent-keys.server";
import { can, type Action, type Role } from "~/lib/roles";

export type Viewer = {
  id: number;
  email: string;
  name: string;
  isOwner: boolean;
  /** Another company's AI agent that reads and flags through MCP (design B6). Never writes or publishes. */
  isReviewer: boolean;
};

export type VisibleProject = {
  id: number;
  slug: string;
  name: string;
  role: Role;
  /** A site's projects open at /p/, a book's at /b/. A project that is neither has no view yet. */
  kind: "site" | "book" | null;
};

function projectKindOf(row: { site: string | null; book: string | null }): VisibleProject["kind"] {
  return row.site ? "site" : row.book ? "book" : null;
}

type AdminEnv = { ADMIN_EMAIL?: string; CO_OWNER_EMAILS?: string };

/**
 * The active person with this email, or null. Email matching is case-insensitive, as the column is.
 *
 * The Owner is the admin roster (site-runtime ./access, the one model of every site): ADMIN_EMAIL, the main
 * admin, and CO_OWNER_EMAILS, who have the Owner's use of Carrel. The roster decides, not the row: an admin is
 * the Owner on every project, is never disabled, and gets a row on first sign-in if the table has none. The
 * table's one `is_owner` row follows the main admin, so a main admin's change in Cloudflare moves it here.
 * Everyone else is what their row says, and a row flagged Owner whose email is not on the roster is no Owner.
 */
export async function findViewer(
  db: D1Database,
  env: AdminEnv,
  email: string,
): Promise<Viewer | null> {
  const d = drizzle(db);
  const admin = isAdminEmail(env, email);
  const select = () =>
    d
      .select({
        id: people.id,
        email: people.email,
        name: people.name,
        isOwner: people.isOwner,
        isReviewer: people.isReviewer,
        disabledAt: people.disabledAt,
      })
      .from(people)
      .where(eq(people.email, email.trim()))
      .get();
  let row = await select();
  if (!row && admin) {
    const address = email.trim().toLowerCase();
    await d
      .insert(people)
      .values({ email: address, name: address.split("@")[0], isOwner: false })
      .onConflictDoNothing();
    row = await select();
  }
  if (!row || (row.disabledAt && !admin)) return null;
  if (admin && isMainAdmin(env, email) && !row.isOwner) {
    await db.batch([
      db.prepare("UPDATE people SET is_owner = 0 WHERE is_owner = 1 AND id != ?").bind(row.id),
      db.prepare("UPDATE people SET is_owner = 1, disabled_at = NULL WHERE id = ?").bind(row.id),
    ]);
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    isOwner: admin,
    isReviewer: admin ? false : row.isReviewer,
  };
}

/**
 * Everyone the Desk lets in: the active people who are neither a reviewer nor an agent (an agent's row carries
 * `agent:<name>`, which Access can never present). This is the list `carrel-desk-login`'s policies must match, the
 * Owner's `carrel-admin` and the co-authors' `carrel-people` together, which the Access drift check reads hashed.
 */
export async function deskPeopleEmails(db: D1Database, env: AdminEnv): Promise<string[]> {
  const rows = await drizzle(db)
    .select({ email: people.email })
    .from(people)
    .where(
      and(
        isNull(people.disabledAt),
        eq(people.isReviewer, false),
        not(like(people.email, `${agentEmail("")}%`)),
      ),
    )
    .all();
  // The admin roster is let in whether or not it has a row yet (findViewer adds it on first sign-in).
  const all = new Map<string, string>();
  for (const email of [...rows.map((row) => row.email), ...adminEmails(env)])
    all.set(email.toLowerCase(), email);
  return [...all.values()];
}

/**
 * The active person row for a named agent key ("agent:<name>"), or null. The row is where the agent's
 * role lives: the key proves who is knocking and grants nothing. An agent is never the Owner: a row flagged
 * Owner is refused here, whatever the table says.
 */
export async function findAgentViewer(db: D1Database, name: string): Promise<Viewer | null> {
  const viewer = await findViewer(db, {}, agentEmail(name));
  if (!viewer) return null;
  const flagged = await drizzle(db)
    .select({ one: people.id })
    .from(people)
    .where(and(eq(people.id, viewer.id), eq(people.isOwner, true)))
    .get();
  return flagged ? null : viewer;
}

async function roleOn(db: D1Database, viewer: Viewer, projectId: number): Promise<Role | null> {
  if (viewer.isOwner) return "owner";
  const row = await drizzle(db)
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.personId, viewer.id)))
    .get();
  return row?.role ?? null;
}

/**
 * A person's role on a project now, by id: null when they have none or are disabled. A file's room
 * asks this of a connection it already holds, so a role changed or taken away reaches an open editor.
 */
export async function currentRole(
  db: D1Database,
  env: AdminEnv,
  personId: number,
  projectId: number,
): Promise<Role | null> {
  const row = await drizzle(db)
    .select({ email: people.email, role: projectMembers.role })
    .from(people)
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.personId, people.id), eq(projectMembers.projectId, projectId)),
    )
    .where(and(eq(people.id, personId), isNull(people.disabledAt)))
    .get();
  return row && isAdminEmail(env, row.email) ? "owner" : (row?.role ?? null);
}

/** Every project the viewer may read: all of them for the Owner, shared ones for everyone else. */
export async function visibleProjects(db: D1Database, viewer: Viewer): Promise<VisibleProject[]> {
  const d = drizzle(db);
  if (viewer.isOwner) {
    const rows = await d
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        site: projects.site,
        book: projects.book,
      })
      .from(projects)
      .orderBy(asc(projects.name))
      .all();
    return rows.map(({ site, book, ...r }) => ({
      ...r,
      role: "owner" as const,
      kind: projectKindOf({ site, book }),
    }));
  }
  const rows = await d
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      role: projectMembers.role,
      site: projects.site,
      book: projects.book,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.personId, viewer.id))
    .orderBy(asc(projects.name))
    .all();
  return rows.map(({ site, book, ...r }) => ({ ...r, kind: projectKindOf({ site, book }) }));
}

/**
 * Throws a 404 when the viewer has no role on the project, so a project that is not shared with
 * someone is indistinguishable from one that does not exist, and a 403 when the role is too low.
 */
export async function requireAction(
  db: D1Database,
  viewer: Viewer,
  projectId: number,
  action: Action,
): Promise<Role> {
  const role = await roleOn(db, viewer, projectId);
  if (role === null) throw new Response("Not found", { status: 404 });
  if (!can(role, action)) throw new Response("Forbidden", { status: 403 });
  return role;
}
