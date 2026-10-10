import { resetDb as resetTables } from "@dustinedwards/devkit/d1";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";

export const testEnv = env as unknown as Env & { TEST_D1_MIGRATIONS: D1Migration[] };

/** Clears every table, so each test states the people and projects it relies on. The tables are read from the
 * schema by devkit, so one a migration adds is cleared without being listed here. */
export async function resetDb(): Promise<void> {
  await resetTables(testEnv.DB);
}

export async function addPerson(email: string, opts: { owner?: boolean; disabled?: boolean; reviewer?: boolean } = {}): Promise<number> {
  const row = await testEnv.DB.prepare(
    "INSERT INTO people (email, name, is_owner, disabled_at, is_reviewer) VALUES (?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(email, email.split("@")[0], opts.owner ? 1 : 0, opts.disabled ? "2026-09-26T00:00:00Z" : null, opts.reviewer ? 1 : 0)
    .first<{ id: number }>();
  return row!.id;
}

export async function addProject(slug: string, site: string | null = null): Promise<number> {
  const row = await testEnv.DB.prepare("INSERT INTO projects (slug, name, site) VALUES (?, ?, ?) RETURNING id")
    .bind(slug, slug, site)
    .first<{ id: number }>();
  return row!.id;
}

export async function addBook(slug: string, folder = slug): Promise<number> {
  const row = await testEnv.DB.prepare("INSERT INTO projects (slug, name, book) VALUES (?, ?, ?) RETURNING id")
    .bind(slug, `Book ${slug}`, folder)
    .first<{ id: number }>();
  return row!.id;
}

export async function share(projectId: number, personId: number, role: "reader" | "editor"): Promise<void> {
  await testEnv.DB.prepare("INSERT INTO project_members (project_id, person_id, role) VALUES (?, ?, ?)")
    .bind(projectId, personId, role)
    .run();
}
