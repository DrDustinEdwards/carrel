import { resetDb as resetTables } from "@dustinedwards/devkit/d1";
import type { Jwk, KeySource } from "@dustinedwards/site-runtime/access-login";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";

export const testEnv = env as unknown as Env & { TEST_D1_MIGRATIONS: D1Migration[] };

/** The Access team's published keys, as the gate reads them, served from these public keys instead of the network. */
export function localKeys(...keys: Jwk[]): KeySource {
  return async (kid) => keys.find((key) => key.kid === kid);
}

/** Clears every table, so each test states the people and projects it relies on. The tables are read from the
 * schema by devkit, so one a migration adds is cleared without being listed here. mcp_calls is kept: it is
 * append-only by a trigger that refuses DELETE (drizzle/0012_mcp_calls.sql), which a test asserts. */
export async function resetDb(): Promise<void> {
  await resetTables(testEnv.DB, { keep: ["mcp_calls"] });
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

/** A fresh database with one book shared the usual way: an owner, an editor and a reader. */
export async function sharedBook(slug: string): Promise<number> {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const reader = await addPerson("reader@test.invalid");
  const id = await addBook(slug);
  await share(id, editor, "editor");
  await share(id, reader, "reader");
  return id;
}
