// Managing who is in Carrel (Owner only): add a person, set or remove their role on a project,
// disable or re-enable them. Every change goes through here, with the Owner check inside each
// function, so the page and any later tool meet the same rule.
//
// Carrel's rows decide what a person may do once they are in. Getting in is Cloudflare Access, which
// Carrel does not manage: adding a person here does not let them past Access (people.tsx says where).

import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { people, projectMembers, projects } from "~/db/schema";
import type { Viewer } from "~/lib/people.server";
import type { Role } from "~/lib/roles";

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

export type PersonRow = {
  id: number;
  email: string;
  name: string;
  isOwner: boolean;
  isReviewer: boolean;
  disabledAt: string | null;
  roles: { projectId: number; role: Exclude<Role, "owner"> }[];
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
  const name = input.name.trim().slice(0, 200);
  const d = drizzle(db);
  const existing = await d.select({ id: people.id }).from(people).where(eq(people.email, email)).get();
  if (existing) throw new PeopleRefusal(`${email} is already in Carrel.`);
  const [row] = await d
    .insert(people)
    .values({ email, name, isOwner: false, isReviewer: input.reviewer })
    .returning({ id: people.id, email: people.email, name: people.name, isOwner: people.isOwner, isReviewer: people.isReviewer, disabledAt: people.disabledAt });
  return { ...row!, roles: [] };
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
 * so a reviewer can be a Reader and never an Editor.
 */
export async function setProjectRole(db: D1Database, viewer: Viewer, personId: number, projectId: number, role: "reader" | "editor" | null): Promise<void> {
  requireOwner(viewer);
  const person = await target(db, personId);
  if (person.isOwner) throw new PeopleRefusal("The Owner's role cannot be changed: the Owner is the Owner on every project.");
  if (role === "editor" && person.isReviewer) throw new PeopleRefusal(`${person.email} is a reviewer. Reviewers read and flag only, so they can be a Reader, never an Editor.`);
  const d = drizzle(db);
  const project = await d.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new PeopleRefusal("No such project.");
  if (role === null) {
    await d.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.personId, personId)));
    return;
  }
  await d
    .insert(projectMembers)
    .values({ projectId, personId, role })
    .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.personId], set: { role } });
}

/**
 * Disables a person (they are refused at both doors at once, because every request looks the person
 * up again) or re-enables them. The Owner cannot be disabled: that would lock Carrel with no one able
 * to undo it.
 */
export async function setDisabled(db: D1Database, viewer: Viewer, personId: number, disabled: boolean, now = new Date()): Promise<void> {
  requireOwner(viewer);
  const person = await target(db, personId);
  if (person.isOwner || person.id === viewer.id) throw new PeopleRefusal("The Owner cannot be disabled.");
  await drizzle(db)
    .update(people)
    .set({ disabledAt: disabled ? now.toISOString() : null })
    .where(disabled ? and(eq(people.id, personId), isNull(people.disabledAt)) : eq(people.id, personId));
}
