import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";

export const testEnv = env as unknown as Env & { TEST_D1_MIGRATIONS: D1Migration[] };

/** Clears every table, so each test states the people and projects it relies on. */
export async function resetDb(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM project_members"),
    testEnv.DB.prepare("DELETE FROM projects"),
    testEnv.DB.prepare("DELETE FROM people"),
    testEnv.DB.prepare("DELETE FROM health_state"),
  ]);
}

export async function addPerson(email: string, opts: { owner?: boolean; disabled?: boolean } = {}): Promise<number> {
  const row = await testEnv.DB.prepare(
    "INSERT INTO people (email, name, is_owner, disabled_at) VALUES (?, ?, ?, ?) RETURNING id",
  )
    .bind(email, email.split("@")[0], opts.owner ? 1 : 0, opts.disabled ? "2026-09-26T00:00:00Z" : null)
    .first<{ id: number }>();
  return row!.id;
}

export async function addProject(slug: string): Promise<number> {
  const row = await testEnv.DB.prepare("INSERT INTO projects (slug, name) VALUES (?, ?) RETURNING id")
    .bind(slug, slug)
    .first<{ id: number }>();
  return row!.id;
}

export async function share(projectId: number, personId: number, role: "reader" | "editor"): Promise<void> {
  await testEnv.DB.prepare("INSERT INTO project_members (project_id, person_id, role) VALUES (?, ?, ?)")
    .bind(projectId, personId, role)
    .run();
}
