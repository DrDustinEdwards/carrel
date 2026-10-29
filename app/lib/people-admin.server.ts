// Managing who is in Carrel (Owner only): add a person, set or remove their role on a project,
// disable or re-enable them. Every change goes through here, with the Owner check inside each
// function, so the page and any later tool meet the same rule.
//
// Carrel's rows decide what a person may do once they are in. Getting in is Cloudflare Access: each
// change below that can change who is allowed in returns an AccessChange, and the caller passes it to
// syncAccess (access-sync.server.ts), which posts the whole allow list to Capsid. Adding a person
// changes nothing there, since a person with no role is not on the list.

import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { people, projectMembers, projects } from "~/db/schema";
import { syncAccess, type SyncOutcome } from "~/lib/access-sync.server";
import { agentEmail, isAgentName } from "~/lib/agent-keys.server";
import type { Viewer } from "~/lib/people.server";
import { isMemberRole, type MemberRole } from "~/lib/roles";

/** A refusal the Owner reads on the page: the rule said no, and nothing changed. */
export class PeopleRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeopleRefusal";
  }
}

/** Anyone but the Owner is answered as if the page did not exist. */
function requireOwner(viewer: Viewer) {
  if (!viewer.isOwner || viewer.isReviewer) throw new Response("Not found", { status: 404 });
}

/** Who a change may have taken out of Access, for syncAccess to free their seats. */
export type AccessChange = { removed: string[] };

export type PersonRow = {
  id: number;
  email: string;
  name: string;
  isOwner: boolean;
  isReviewer: boolean;
  disabledAt: string | null;
  roles: { projectId: number; role: MemberRole }[];
};

export type ProjectRow = { id: number; slug: string; name: string; kind: "site" | "book" | null };

export async function listPeople(db: D1Database, viewer: Viewer): Promise<{ people: PersonRow[]; projects: ProjectRow[] }> {
  requireOwner(viewer);
  const d = drizzle(db);
  const [rows, members, projectRows] = await Promise.all([
    d
      .select({ id: people.id, email: people.email, name: people.name, isOwner: people.isOwner, isReviewer: people.isReviewer, disabledAt: people.disabledAt })
      .from(people)
      .orderBy(asc(people.email))
      .all(),
    d.select().from(projectMembers).all(),
    d.select({ id: projects.id, slug: projects.slug, name: projects.name, site: projects.site, book: projects.book }).from(projects).orderBy(asc(projects.name)).all(),
  ]);
  return {
    // The Owner first: the one row nothing here can change.
    people: rows
      .map((p) => ({ ...p, roles: members.filter((m) => m.personId === p.id).map(({ projectId, role }) => ({ projectId, role })) }))
      .sort((a, b) => Number(b.isOwner) - Number(a.isOwner)),
    projects: projectRows.map(({ site, book, ...p }) => ({ ...p, kind: site ? "site" : book ? "book" : null })),
  };
}

const EMAIL = /^[^\s@'"<>]+@[^\s@'"<>]+\.[^\s@'"<>]+$/;

/**
 * Adds a person. Never an Owner: Carrel has one Owner, and this function cannot make another (the
 * database refuses a second as well). An email already in Carrel is refused rather than changed.
 */
export async function addPerson(db: D1Database, viewer: Viewer, input: { email: string; name: string; reviewer: boolean }): Promise<PersonRow> {
  requireOwner(viewer);
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw new PeopleRefusal("That is not an email address.");
  return insertPerson(db, { email, name: input.name.trim().slice(0, 200), isReviewer: input.reviewer });
}

/** Inserts a person who is never an Owner and has no role yet, refusing an email Carrel already has. */
async function insertPerson(db: D1Database, values: { email: string; name: string; isReviewer: boolean }): Promise<PersonRow> {
  const d = drizzle(db);
  const existing = await d.select({ id: people.id }).from(people).where(eq(people.email, values.email)).get();
  if (existing) throw new PeopleRefusal(`${values.email} is already in Carrel.`);
  const [row] = await d
    .insert(people)
    .values({ ...values, isOwner: false })
    .returning({ id: people.id, email: people.email, name: people.name, isOwner: people.isOwner, isReviewer: people.isReviewer, disabledAt: people.disabledAt });
  return { ...row!, roles: [] };
}

/**
 * Adds a named AI agent: the person row "agent:<name>" that an AGENT_KEY_<NAME> secret resolves to at
 * the AI door. Never an Owner, never a reviewer, and it starts with no role on any project. Adding the
 * row grants nothing by itself: the key is a Worker secret the Owner sets, and the role is set below.
 */
export async function addAgent(db: D1Database, viewer: Viewer, input: { name: string; label?: string }): Promise<PersonRow> {
  requireOwner(viewer);
  const name = input.name.trim().toLowerCase();
  if (!isAgentName(name)) throw new PeopleRefusal("An agent's name is letters, digits, hyphens and underscores, up to 32, such as grok.");
  return insertPerson(db, { email: agentEmail(name), name: input.label?.trim().slice(0, 200) || name, isReviewer: false });
}

async function target(db: D1Database, personId: number) {
  const row = await drizzle(db)
    .select({ id: people.id, email: people.email, isOwner: people.isOwner, isReviewer: people.isReviewer, disabledAt: people.disabledAt })
    .from(people)
    .where(eq(people.id, personId))
    .get();
  if (!row) throw new PeopleRefusal("No such person.");
  return row;
}

/**
 * Sets a person's role on a project, or removes it (role null). The Owner has no per-project role to
 * set: the Owner is the Owner everywhere, and cannot be demoted here. A reviewer reads and flags only,
 * so a reviewer can be a Reader and never an Editor or an Author. An Author publishes their own posts,
 * so the role is for people on a site project: never an AI agent (agents never publish), and never on
 * a book, which has no posts.
 */
export async function setProjectRole(db: D1Database, viewer: Viewer, personId: number, projectId: number, role: MemberRole | null): Promise<AccessChange> {
  requireOwner(viewer);
  const person = await target(db, personId);
  if (person.isOwner) throw new PeopleRefusal("The Owner's role cannot be changed: the Owner is the Owner on every project.");
  if ((role === "editor" || role === "author") && person.isReviewer) {
    throw new PeopleRefusal(`${person.email} is a reviewer. Reviewers read and flag only, so they can be a Reader, never an Editor or an Author.`);
  }
  if (role === "author" && person.email.startsWith(agentEmail(""))) throw new PeopleRefusal(`${person.email} is an AI agent. Agents never publish, so they can be a Reader or an Editor, never an Author.`);
  const d = drizzle(db);
  const project = await d.select({ id: projects.id, site: projects.site }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new PeopleRefusal("No such project.");
  if (role === "author" && !project.site) throw new PeopleRefusal("Author is a role on a site's project: a book has no posts to publish. Make them an Editor here.");
  if (role === null) {
    await d.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.personId, personId)));
    // Removed only if that was their last role; syncAccess keeps anyone still on the list.
    return { removed: [person.email] };
  }
  await d
    .insert(projectMembers)
    .values({ projectId, personId, role })
    .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.personId], set: { role } });
  return { removed: [] };
}

export type ShareResult = { email: string; added: boolean; change: AccessChange };

/**
 * Shares one project with a coauthor by email, from the project's own page: someone new is added as
 * a person (never a reviewer) and given the role, someone already in Carrel just gets the role. The
 * rules are addPerson's and setProjectRole's, so the People page and this panel cannot disagree.
 */
export async function shareProject(db: D1Database, viewer: Viewer, projectId: number, input: { email: string; name: string; role: string }): Promise<ShareResult> {
  requireOwner(viewer);
  if (!isMemberRole(input.role)) throw new PeopleRefusal("Choose a role.");
  const email = input.email.trim().toLowerCase();
  const existing = await drizzle(db).select({ id: people.id }).from(people).where(eq(people.email, email)).get();
  const id = existing?.id ?? (await addPerson(db, viewer, { email, name: input.name, reviewer: false })).id;
  try {
    return { email, added: !existing, change: await setProjectRole(db, viewer, id, projectId, input.role) };
  } catch (error) {
    // A new person the role was refused for (Author on a book) is not left behind with no role.
    if (!existing) await drizzle(db).delete(people).where(eq(people.id, id));
    throw error;
  }
}

export type ShareAnswer = { ok: true; email: string; added: boolean; access: SyncOutcome } | { ok: false; message: string };

/** The Share panel's form (app/components/share-panel.tsx), shared and then synced to Access. A refusal is answered, never thrown. */
export async function shareFromForm(env: Env, viewer: Viewer, projectId: number, form: FormData): Promise<ShareAnswer> {
  try {
    const shared = await shareProject(env.DB, viewer, projectId, {
      email: String(form.get("email") ?? ""),
      name: String(form.get("name") ?? ""),
      role: String(form.get("role") ?? ""),
    });
    return { ok: true, email: shared.email, added: shared.added, access: await syncAccess(env, shared.change) };
  } catch (error) {
    if (error instanceof PeopleRefusal) return { ok: false, message: error.message };
    throw error;
  }
}

/**
 * Disables a person (they are refused at both doors at once, because every request looks the person
 * up again) or re-enables them. The Owner cannot be disabled: that would lock Carrel with no one able
 * to undo it.
 */
export async function setDisabled(db: D1Database, viewer: Viewer, personId: number, disabled: boolean, now = new Date()): Promise<AccessChange> {
  requireOwner(viewer);
  const person = await target(db, personId);
  if (person.isOwner || person.id === viewer.id) throw new PeopleRefusal("The Owner cannot be disabled.");
  await drizzle(db)
    .update(people)
    .set({ disabledAt: disabled ? now.toISOString() : null })
    .where(disabled ? and(eq(people.id, personId), isNull(people.disabledAt)) : eq(people.id, personId));
  return { removed: disabled ? [person.email] : [] };
}
