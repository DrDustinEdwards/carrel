import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";

export const testEnv = env as unknown as Env & { TEST_D1_MIGRATIONS: D1Migration[] };

/** Clears every table, so each test states the people and projects it relies on. */
export async function resetDb(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM ai_publications"),
    testEnv.DB.prepare("DELETE FROM ai_drafts"),
    testEnv.DB.prepare("DELETE FROM findings"),
    testEnv.DB.prepare("DELETE FROM mcp_sessions"),
    testEnv.DB.prepare("DELETE FROM authorship"),
    testEnv.DB.prepare("DELETE FROM book_files"),
    testEnv.DB.prepare("DELETE FROM novels_shared"),
    testEnv.DB.prepare("DELETE FROM google_keys_seen"),
    testEnv.DB.prepare("DELETE FROM google_tokens"),
    testEnv.DB.prepare("DELETE FROM google_oauth_states"),
    testEnv.DB.prepare("DELETE FROM manuscripts"),
    testEnv.DB.prepare("DELETE FROM sent_docs"),
    testEnv.DB.prepare("DELETE FROM search_console_pages"),
    testEnv.DB.prepare("DELETE FROM social_posts"),
    testEnv.DB.prepare("DELETE FROM social_events"),
    testEnv.DB.prepare("DELETE FROM social_routine_runs"),
    testEnv.DB.prepare("DELETE FROM social_accounts"),
    testEnv.DB.prepare("DELETE FROM legal_sections"),
    testEnv.DB.prepare("DELETE FROM changes"),
    testEnv.DB.prepare("DELETE FROM drafts"),
    testEnv.DB.prepare("DELETE FROM site_items"),
    testEnv.DB.prepare("DELETE FROM site_items_fts"),
    testEnv.DB.prepare("DELETE FROM project_members"),
    testEnv.DB.prepare("DELETE FROM projects"),
    testEnv.DB.prepare("DELETE FROM people"),
    testEnv.DB.prepare("DELETE FROM health_state"),
  ]);
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
