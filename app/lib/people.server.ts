import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { people, projectMembers, projects } from "~/db/schema";
import { can, type Action, type Role } from "~/lib/roles";

export type Viewer = {
  id: number;
  email: string;
  name: string;
  isOwner: boolean;
};

export type VisibleProject = {
  id: number;
  slug: string;
  name: string;
  role: Role;
};

/** The active person with this email, or null. Email matching is case-insensitive, as the column is. */
export async function findViewer(db: D1Database, email: string): Promise<Viewer | null> {
  const row = await drizzle(db)
    .select({ id: people.id, email: people.email, name: people.name, isOwner: people.isOwner })
    .from(people)
    .where(and(eq(people.email, email.trim()), isNull(people.disabledAt)))
    .get();
  return row ?? null;
}

export async function roleOn(db: D1Database, viewer: Viewer, projectId: number): Promise<Role | null> {
  if (viewer.isOwner) return "owner";
  const row = await drizzle(db)
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.personId, viewer.id)))
    .get();
  return row?.role ?? null;
}

/** Every project the viewer may read: all of them for the Owner, shared ones for everyone else. */
export async function visibleProjects(db: D1Database, viewer: Viewer): Promise<VisibleProject[]> {
  const d = drizzle(db);
  if (viewer.isOwner) {
    const rows = await d
      .select({ id: projects.id, slug: projects.slug, name: projects.name })
      .from(projects)
      .orderBy(asc(projects.name))
      .all();
    return rows.map((r) => ({ ...r, role: "owner" as const }));
  }
  return d
    .select({ id: projects.id, slug: projects.slug, name: projects.name, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.personId, viewer.id))
    .orderBy(asc(projects.name))
    .all();
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
