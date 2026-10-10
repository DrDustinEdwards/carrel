// Books in the novels repository (design stage 4): the book behind a URL, Carrel's index of its
// files, a save that commits to Git with the version it expects to replace, the checks that run on
// every save, their findings, and the authorship record. Roles are checked here, not only in the
// routes, so every door (the UI now, MCP tools in stage 5) is held to the same rule.

import { and, asc, desc, eq, inArray, like, notInArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { aiDrafts, authorship, bookFiles, drafts, findings, novelsShared, people, projects } from "~/db/schema";
import { AiRefusal, type AiSession } from "~/lib/ai.server";
import { requireAction, type Viewer } from "~/lib/people.server";
import { can, type Action, type Role } from "~/lib/roles";
import { checkFile, fingerprints, readHabits, type BookContext, type Finding } from "~/lib/novels/checks";
import { parseFile } from "~/lib/novels/frontmatter";
import { describe, isBookFolder, isBookPath, kindOf, readingOrder, titleFromSegment, type Meta } from "~/lib/novels/layout";
import { GitConflict, novelsConnection, novelsRepo, type NovelsRepo } from "~/lib/novels/repo.server";
import { profileOf } from "~/lib/novels/voice";
import { takeUntyped } from "~/lib/writing.server";

export type BookProject = { id: number; slug: string; name: string; book: string; role: Role };

function forbid(): never {
  throw new Response("Forbidden", { status: 403 });
}

function requireCan(project: BookProject, action: Action) {
  if (!can(project.role, action)) forbid();
}

/** As requireSiteProject: a book that does not exist, is not shared, or is not a book all answer 404. */
export async function requireBookProject(db: D1Database, viewer: Viewer, slug: string | undefined, action: Action): Promise<BookProject> {
  const row = slug
    ? await drizzle(db)
        .select({ id: projects.id, slug: projects.slug, name: projects.name, book: projects.book, site: projects.site })
        .from(projects)
        .where(eq(projects.slug, slug))
        .get()
    : undefined;
  if (!row) throw new Response("Not found", { status: 404 });
  const role = await requireAction(db, viewer, row.id, action);
  if (!row.book || row.site) throw new Response("Not found", { status: 404 });
  return { id: row.id, slug: row.slug, name: row.name, book: row.book, role };
}

/** The repository, or why there is none yet: until the App is set up, books open read-only from the index. */
export function bookRepo(env: Env): { repo: NovelsRepo; detail: null } | { repo: null; detail: string } {
  const connection = novelsConnection(env);
  if (connection.state !== "connected") return { repo: null, detail: connection.detail };
  return { repo: novelsRepo(env), detail: null };
}

/** A new book: a project whose folder in the novels repository is `folder`. Nothing is written to Git. */
export async function createBook(db: D1Database, viewer: Viewer, input: { name: string; folder: string }) {
  if (!viewer.isOwner) forbid();
  const name = input.name.trim();
  if (!name || name.length > 120) return { ok: false as const, error: "Give the book a name of up to 120 characters." };
  if (!isBookFolder(input.folder)) return { ok: false as const, error: "Use lower-case letters, digits and single hyphens for the folder, such as paluxy-portal." };
  const d = drizzle(db);
  const taken = await d
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, input.folder))
    .get();
  if (taken) return { ok: false as const, error: `A project already uses ${input.folder}.` };
  const clash = await d.select({ id: projects.id }).from(projects).where(eq(projects.book, input.folder)).get();
  if (clash) return { ok: false as const, error: `Another book already uses the folder ${input.folder}.` };
  await d.insert(projects).values({ slug: input.folder, name, book: input.folder });
  return { ok: true as const, slug: input.folder };
}

// ---------- the index

export type IndexedFile = { path: string; kind: Meta["kind"]; sha: string; meta: Meta; words: number };

function parseMeta(json: string): Meta {
  try {
    return JSON.parse(json) as Meta;
  } catch {
    // A row written by an older shape: treated as a plain note until the next save re-indexes it.
    return { kind: "note" };
  }
}

export async function listFiles(db: D1Database, project: BookProject): Promise<IndexedFile[]> {
  requireCan(project, "read");
  const rows = await drizzle(db)
    .select({ path: bookFiles.path, kind: bookFiles.kind, sha: bookFiles.sha, meta: bookFiles.meta, words: bookFiles.words })
    .from(bookFiles)
    .where(eq(bookFiles.projectId, project.id))
    .orderBy(asc(bookFiles.path))
    .all();
  return rows.map((r) => ({ ...r, meta: parseMeta(r.meta) }));
}

export async function indexedFile(db: D1Database, project: BookProject, path: string) {
  requireCan(project, "read");
  const row = await drizzle(db)
    .select({ source: bookFiles.source, sha: bookFiles.sha, syncedAt: bookFiles.syncedAt })
    .from(bookFiles)
    .where(and(eq(bookFiles.projectId, project.id), eq(bookFiles.path, path)))
    .get();
  return row ?? null;
}

async function indexFile(db: D1Database, projectId: number, path: string, file: { source: string; sha: string }, now: string) {
  const { meta, words } = describe(path, file.source);
  const values = { kind: kindOf(path), sha: file.sha, source: file.source, meta: JSON.stringify(meta), words, syncedAt: now };
  await drizzle(db)
    .insert(bookFiles)
    .values({ projectId, path, ...values })
    .onConflictDoUpdate({ target: [bookFiles.projectId, bookFiles.path], set: values });
}

/** The context every check reads, from D1 alone, so a save costs no extra Git calls. */
export async function bookContext(db: D1Database, projectId: number): Promise<BookContext> {
  const d = drizzle(db);
  const rows = await d
    .select({ path: bookFiles.path, meta: bookFiles.meta })
    .from(bookFiles)
    .where(and(eq(bookFiles.projectId, projectId), inArray(bookFiles.kind, ["scene", "character", "place", "rule"])))
    .all();
  const context: BookContext = { bible: { characters: [], places: [], rules: [] }, scenes: [], habits: readHabits(null), voice: null };
  for (const row of rows) {
    const meta = parseMeta(row.meta);
    if (meta.kind === "scene") context.scenes.push({ path: row.path, header: meta.header });
    else if (meta.kind === "character") context.bible.characters.push(meta.entry);
    else if (meta.kind === "place") context.bible.places.push(meta.entry);
    else if (meta.kind === "rule") context.bible.rules.push(meta.entry);
  }
  const shared = await d.select({ path: novelsShared.path, source: novelsShared.source }).from(novelsShared).all();
  const habits = shared.find((s) => s.path === "shared/checks/ai-habits.md");
  context.habits = readHabits(habits?.source ?? null);
  context.voice = profileOf(shared.filter((s) => s.path.startsWith("shared/voice/") && !s.path.endsWith("README.md")).map((s) => parseFile(s.source).body));
  return context;
}

// ---------- findings

/**
 * Replaces the findings for each file with what the checks found now. A dismissed finding that is
 * found again stays dismissed; one that is no longer found is gone, whatever its state.
 */
/** The check names of flags added through MCP (ai.server.ts addFinding), which a recheck leaves alone. */
const SESSION_FLAGS = ["ai", "review"];

async function recordFindings(db: D1Database, projectId: number, byPath: Map<string, Finding[]>) {
  const d = drizzle(db);
  for (const [path, found] of byPath) {
    const keys = await fingerprints(found);
    // Flags a person's AI session or a reviewer added are not the checks' to withdraw.
    const existing = await d
      .select({ fingerprint: findings.fingerprint })
      .from(findings)
      .where(and(eq(findings.projectId, projectId), eq(findings.path, path), notInArray(findings.checkName, SESSION_FLAGS)))
      .all();
    const have = new Set(existing.map((e) => e.fingerprint));
    const keep = new Set(keys);
    const gone = [...have].filter((k) => !keep.has(k));
    if (gone.length > 0) {
      await d.delete(findings).where(and(eq(findings.projectId, projectId), eq(findings.path, path), inArray(findings.fingerprint, gone)));
    }
    const fresh = found.map((f, i) => ({ f, key: keys[i]! })).filter(({ key }) => !have.has(key));
    for (const { f, key } of fresh) {
      await d.insert(findings).values({ projectId, path, checkName: f.check, message: f.message, line: f.line, excerpt: f.excerpt, fingerprint: key });
    }
  }
}

/** Runs the checks over the given files (every scene when `paths` is "all") and records what they find. */
export async function recheck(db: D1Database, projectId: number, paths: string[] | "all") {
  if (paths !== "all" && paths.length === 0) return new Map<string, Finding[]>();
  const context = await bookContext(db, projectId);
  const d = drizzle(db);
  const rows = await d
    .select({ path: bookFiles.path, source: bookFiles.source })
    .from(bookFiles)
    .where(paths === "all" ? eq(bookFiles.projectId, projectId) : and(eq(bookFiles.projectId, projectId), inArray(bookFiles.path, paths)))
    .all();
  const byPath = new Map<string, Finding[]>();
  for (const row of rows) byPath.set(row.path, checkFile(row.path, row.source, context));
  await recordFindings(db, projectId, byPath);
  return byPath;
}

export type FindingRow = {
  id: number;
  path: string;
  check: string;
  message: string;
  line: number | null;
  excerpt: string | null;
  status: "open" | "dismissed";
};

export async function listFindings(db: D1Database, project: BookProject, opts: { path?: string; status?: "open" | "dismissed" } = {}): Promise<FindingRow[]> {
  requireCan(project, "read");
  const where = [eq(findings.projectId, project.id)];
  if (opts.path) where.push(eq(findings.path, opts.path));
  if (opts.status) where.push(eq(findings.status, opts.status));
  return drizzle(db)
    .select({
      id: findings.id,
      path: findings.path,
      check: findings.checkName,
      message: findings.message,
      line: findings.line,
      excerpt: findings.excerpt,
      status: findings.status,
    })
    .from(findings)
    .where(and(...where))
    .orderBy(asc(findings.path), asc(findings.line), asc(findings.id))
    .all();
}

/** Checks flag; a person decides. Dismissing a flag clears it for export, so it is the Owner's call. */
export async function dismissFinding(db: D1Database, project: BookProject, viewer: Viewer, id: number, now = new Date()) {
  requireCan(project, "publish");
  const result = await drizzle(db)
    .update(findings)
    .set({ status: "dismissed", dismissedBy: viewer.id, dismissedAt: now.toISOString() })
    .where(and(eq(findings.id, id), eq(findings.projectId, project.id)))
    .returning({ id: findings.id });
  if (result.length === 0) throw new Response("Not found", { status: 404 });
}

// ---------- refresh from Git

export type BookRefresh = { files: number; read: number; removed: number; shared: number; more: boolean };

/** How many files one refresh reads from Git; the rest wait for the next one. */
export const REFRESH_READ_CAP = 150;

/**
 * Brings the index in line with Git: files whose blob sha changed are read again, files gone from
 * Git are dropped, and the checks run again if anything changed. Git is the authority throughout.
 */
export async function refreshBook(db: D1Database, repo: NovelsRepo, project: BookProject, now = new Date()): Promise<BookRefresh> {
  requireCan(project, "read");
  const d = drizzle(db);
  const at = now.toISOString();
  const [tree, sharedTree] = await Promise.all([repo.tree(project.book), repo.tree("shared")]);
  const wanted = tree.filter((f) => isBookPath(f.path));
  const known = new Map(
    (await d.select({ path: bookFiles.path, sha: bookFiles.sha }).from(bookFiles).where(eq(bookFiles.projectId, project.id)).all()).map((r) => [r.path, r.sha]),
  );
  const stale = wanted.filter((f) => known.get(f.path) !== f.sha);
  const batch = stale.slice(0, REFRESH_READ_CAP);
  for (const f of batch) {
    const file = await repo.read(`${project.book}/${f.path}`);
    if (file) await indexFile(db, project.id, f.path, file, at);
  }
  const present = new Set(wanted.map((f) => f.path));
  const removed = [...known.keys()].filter((p) => !present.has(p));
  if (removed.length > 0) {
    await d.delete(bookFiles).where(and(eq(bookFiles.projectId, project.id), inArray(bookFiles.path, removed)));
    await d.delete(findings).where(and(eq(findings.projectId, project.id), inArray(findings.path, removed)));
  }

  // shared/voice/ and shared/checks/ai-habits.md, which every book's checks read.
  const sharedWanted = sharedTree
    .filter((f) => f.path.endsWith(".md") && (f.path.startsWith("voice/") || f.path === "checks/ai-habits.md"))
    .map((f) => ({ path: `shared/${f.path}`, sha: f.sha }));
  const sharedKnown = new Map((await d.select({ path: novelsShared.path, sha: novelsShared.sha }).from(novelsShared).all()).map((r) => [r.path, r.sha]));
  let sharedRead = 0;
  for (const f of sharedWanted) {
    if (sharedKnown.get(f.path) === f.sha) continue;
    const file = await repo.read(f.path);
    if (!file) continue;
    sharedRead++;
    await d
      .insert(novelsShared)
      .values({ path: f.path, sha: file.sha, source: file.source, syncedAt: at })
      .onConflictDoUpdate({ target: novelsShared.path, set: { sha: file.sha, source: file.source, syncedAt: at } });
  }
  const sharedPresent = new Set(sharedWanted.map((f) => f.path));
  const sharedGone = [...sharedKnown.keys()].filter((p) => !sharedPresent.has(p));
  if (sharedGone.length > 0) await d.delete(novelsShared).where(inArray(novelsShared.path, sharedGone));

  if (batch.length > 0 || removed.length > 0 || sharedRead > 0 || sharedGone.length > 0) await recheck(db, project.id, "all");
  return { files: wanted.length, read: batch.length, removed: removed.length, shared: sharedRead, more: stale.length > batch.length };
}

// ---------- saving

export type BookWrite =
  | { ok: true; version: string; commit: string; changeId: string; findings: Finding[] }
  | { ok: false; reason: "conflict"; currentVersion: string | null; message: string }
  | { ok: false; reason: "failed"; message: string };

function wordBag(text: string): Map<string, number> {
  const bag = new Map<string, number>();
  for (const w of parseFile(text).body.toLowerCase().match(/[\p{L}\p{N}]+(?:['\u2019][\p{L}]+)*/gu) ?? []) bag.set(w, (bag.get(w) ?? 0) + 1);
  return bag;
}

/**
 * Words added and removed between two versions, counted as a multiset difference: a moved word
 * counts as neither, a changed word as one of each. Approximate on purpose; it is a record of how
 * much each person or AI changed, not a diff.
 */
export function wordDelta(before: string | null, after: string): { added: number; removed: number } {
  const a = wordBag(before ?? "");
  const b = wordBag(after);
  let added = 0;
  let removed = 0;
  for (const [w, n] of b) added += Math.max(0, n - (a.get(w) ?? 0));
  for (const [w, n] of a) removed += Math.max(0, n - (b.get(w) ?? 0));
  return { added, removed };
}

/**
 * Commits one file. The checks run on the saved text and their findings come back with the result,
 * but no finding stops a save: a flag blocks only export. A stale expected version is refused by Git
 * and the person's text is kept in their draft.
 */
export async function saveBookFile(
  db: D1Database,
  repo: NovelsRepo,
  project: BookProject,
  viewer: Viewer,
  path: string,
  input: {
    source: string;
    expectedVersion: string | null;
    client?: string | null;
    /** Words in this text that were not typed (pasted or dropped since the last autosave), besides those already recorded. */
    untyped?: number;
  },
): Promise<BookWrite> {
  requireCan(project, "edit");
  if (!isBookPath(path)) throw new Response("Not found", { status: 404 });

  const before = input.expectedVersion ? await indexedFile(db, project, path) : null;
  const changeId = crypto.randomUUID();
  let written: { sha: string; commit: string };
  try {
    written = await repo.write(`${project.book}/${path}`, {
      source: input.source,
      expectedSha: input.expectedVersion,
      message: `Save ${project.book}/${path}\n\nCarrel-Change: ${changeId}`,
      author: { name: viewer.name || viewer.email, email: viewer.email },
    });
  } catch (error) {
    if (error instanceof GitConflict) {
      return {
        ok: false,
        reason: "conflict",
        currentVersion: error.currentSha,
        message: "This file changed in Git since you opened it. Your text is kept here as your draft; refresh the book to see Git's version before saving.",
      };
    }
    console.error(JSON.stringify({ book: "save-failed", path, error: String(error) }));
    return { ok: false, reason: "failed", message: "Git did not accept the save. Your text is kept here as your draft." };
  }

  const d = drizzle(db);
  // The index may not hold the version this replaced (a refresh was due); then the words are all counted as added.
  const known = input.expectedVersion === null || (before !== null && before.sha === input.expectedVersion);
  const delta = wordDelta(known ? (before?.source ?? null) : null, input.source);
  // Only typed words count toward the day (ruling 6). Pastes, drops and an AI draft taken as the
  // working draft were counted as they arrived, and come off here. An AI client's save counts for
  // nothing, and so does a save whose starting text the index does not hold: every word would read
  // as added.
  const untyped = (await takeUntyped(db, project.id, viewer.id, path)) + Math.max(0, input.untyped ?? 0);
  const wordsTyped = input.client || !known ? null : Math.max(0, delta.added - untyped);
  await d.insert(authorship).values({
    id: changeId,
    projectId: project.id,
    path,
    personId: viewer.id,
    client: input.client ?? null,
    wordsAdded: delta.added,
    wordsRemoved: delta.removed,
    versionBefore: input.expectedVersion,
    versionAfter: written.sha,
    commitSha: written.commit,
    wordsTyped,
  });
  await indexFile(db, project.id, path, { source: input.source, sha: written.sha }, new Date().toISOString());
  await d.delete(drafts).where(and(eq(drafts.projectId, project.id), eq(drafts.itemId, path), eq(drafts.personId, viewer.id)));

  // A bible entry can change what every scene's checks say; a scene can change its successor's timeline.
  const kind = kindOf(path);
  let paths: string[] | "all" = [path];
  if (kind === "character" || kind === "place" || kind === "rule") paths = "all";
  else if (kind === "scene") {
    const order = readingOrder((await d.select({ path: bookFiles.path }).from(bookFiles).where(eq(bookFiles.projectId, project.id)).all()));
    const at = order.findIndex((s) => s.path === path);
    const next = order[at + 1];
    if (next) paths = [path, next.path];
  }
  const found = await recheck(db, project.id, paths);
  return { ok: true, version: written.sha, commit: written.commit, changeId, findings: found.get(path) ?? [] };
}

/** The checks on text that has not been saved: nothing is recorded, nothing is committed. */
export async function checkDraft(db: D1Database, project: BookProject, path: string, source: string): Promise<Finding[]> {
  requireCan(project, "read");
  if (!isBookPath(path)) throw new Response("Not found", { status: 404 });
  const context = await bookContext(db, project.id);
  return checkFile(path, source, context);
}

// ---------- export and the authorship record

/** What scripts/import-docx.mjs writes where it could not convert something. */
export const IMPORT_MARKER = "<!-- import:";

/** Export sends a book out, so, like publish, it is the Owner's, and waits while any flag is open. */
export async function exportGate(db: D1Database, project: BookProject): Promise<{ ok: true } | { ok: false; open: number; message: string }> {
  requireCan(project, "publish");
  const d = drizzle(db);
  // The manuscript importer marks what it could not convert with these; none may reach a reader.
  const marked = await d
    .select({ path: bookFiles.path })
    .from(bookFiles)
    .where(and(eq(bookFiles.projectId, project.id), like(bookFiles.source, `%${IMPORT_MARKER}%`)))
    .all();
  if (marked.length > 0) {
    const paths = marked.map((m) => m.path).sort();
    return {
      ok: false,
      open: marked.length,
      message: `${paths.length} file${paths.length === 1 ? " still holds" : "s still hold"} an ${IMPORT_MARKER} ... --> marker from the Word import: ${paths.join(", ")}. Fix the text there and delete each marker before exporting.`,
    };
  }
  const open = await d
    .select({ id: findings.id })
    .from(findings)
    .where(and(eq(findings.projectId, project.id), eq(findings.status, "open")))
    .all();
  if (open.length === 0) return { ok: true };
  return {
    ok: false,
    open: open.length,
    message: `${open.length} flag${open.length === 1 ? " is" : "s are"} open. Fix the text or dismiss each flag before exporting.`,
  };
}

export type Assembled = {
  title: string;
  author: string;
  language: string;
  chapters: { slug: string; title: string; scenes: { path: string; body: string }[] }[];
};

/** The book in reading order, from the index (refresh first to export what Git holds). */
export async function assembleBook(db: D1Database, project: BookProject, viewer: Viewer): Promise<Assembled> {
  requireCan(project, "publish");
  const rows = await drizzle(db)
    .select({ path: bookFiles.path, source: bookFiles.source, meta: bookFiles.meta })
    .from(bookFiles)
    .where(eq(bookFiles.projectId, project.id))
    .all();
  const bookRow = rows.find((r) => r.path === "book.md");
  const meta = bookRow ? parseMeta(bookRow.meta) : null;
  const entry = meta?.kind === "book" ? meta.entry : null;
  const chapters: Assembled["chapters"] = [];
  for (const scene of readingOrder(rows)) {
    const slug = scene.path.split("/")[1]!;
    let chapter = chapters.at(-1);
    if (!chapter || chapter.slug !== slug) {
      chapter = { slug, title: titleFromSegment(slug), scenes: [] };
      chapters.push(chapter);
    }
    chapter.scenes.push({ path: scene.path, body: parseFile(scene.source).body.trim() });
  }
  return { title: entry?.title || project.name, author: entry?.author || viewer.name || viewer.email, language: entry?.language || "en", chapters };
}

export type AuthorshipRow = {
  id: string;
  path: string;
  who: string;
  client: string | null;
  wordsAdded: number;
  wordsRemoved: number;
  commit: string;
  at: string;
};

export async function authorshipRecord(db: D1Database, project: BookProject): Promise<AuthorshipRow[]> {
  requireCan(project, "read");
  const rows = await drizzle(db)
    .select({
      id: authorship.id,
      path: authorship.path,
      name: people.name,
      email: people.email,
      client: authorship.client,
      wordsAdded: authorship.wordsAdded,
      wordsRemoved: authorship.wordsRemoved,
      commit: authorship.commitSha,
      at: authorship.createdAt,
    })
    .from(authorship)
    .innerJoin(people, eq(people.id, authorship.personId))
    .where(eq(authorship.projectId, project.id))
    .orderBy(desc(authorship.createdAt))
    .all();
  return rows.map(({ name, email, ...r }) => ({ ...r, who: name || email }));
}

/** The record as a readable Markdown report: totals per person or AI client, then every change. */
export function authorshipReport(project: BookProject, rows: AuthorshipRow[], now = new Date()): string {
  const byWho = new Map<string, { changes: number; added: number; removed: number }>();
  for (const r of rows) {
    const who = r.client ? `${r.client} (AI, on ${r.who}'s instruction)` : r.who;
    const t = byWho.get(who) ?? { changes: 0, added: 0, removed: 0 };
    t.changes++;
    t.added += r.wordsAdded;
    t.removed += r.wordsRemoved;
    byWho.set(who, t);
  }
  const lines = [
    `# Authorship record: ${project.name}`,
    "",
    `Every change Carrel committed to ${project.book}/ in the novels repository, as of ${now.toISOString().slice(0, 10)}. Words are counted as added and removed between versions, so a changed word counts once each way.`,
    "",
    "## By person",
    "",
    "| Who | Changes | Words added | Words removed |",
    "| --- | ---: | ---: | ---: |",
    ...[...byWho].map(([who, t]) => `| ${who} | ${t.changes} | ${t.added} | ${t.removed} |`),
    "",
    "## Every change",
    "",
    "| When (UTC) | Who | File | Added | Removed | Commit |",
    "| --- | --- | --- | ---: | ---: | --- |",
    ...rows.map(
      (r) =>
        `| ${r.at.slice(0, 16).replace("T", " ")} | ${r.client ? `${r.client} (AI)` : r.who} | ${r.path} | ${r.wordsAdded} | ${r.wordsRemoved} | ${r.commit.slice(0, 7)} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

/** The Carrel drafts people are working on in this book, so the book view can show them before Git has them. */
export async function draftPaths(db: D1Database, project: BookProject, viewer: Viewer): Promise<string[]> {
  requireCan(project, "read");
  const rows = await drizzle(db)
    .select({ path: drafts.itemId })
    .from(drafts)
    .where(and(eq(drafts.projectId, project.id), eq(drafts.personId, viewer.id)))
    .all();
  return rows.map((r) => r.path).filter(isBookPath);
}

/**
 * An AI draft of a book file, saved beside the person's own and never committed (design: AI never
 * rewrites Dustin's prose unasked). The same table as posts' AI drafts, keyed by the file's path.
 */
export async function saveBookAiDraft(db: D1Database, project: BookProject, session: AiSession, path: string, input: { source: string; note?: string }) {
  if (session.viewer.isReviewer) throw new AiRefusal("A reviewer flags; it does not write text. Use add_book_finding.");
  requireCan(project, "edit");
  if (!isBookPath(path)) throw new Response("Not found", { status: 404 });
  if (!input.source.trim()) throw new Response("The draft is empty.", { status: 400 });
  const base = await indexedFile(db, project, path);
  const [row] = await drizzle(db)
    .insert(aiDrafts)
    .values({
      projectId: project.id,
      itemId: path,
      personId: session.viewer.id,
      client: session.client,
      source: input.source.replace(/\r\n/g, "\n"),
      baseVersion: base?.sha ?? null,
      note: (input.note ?? "").trim().slice(0, 500),
    })
    .returning({ id: aiDrafts.id });
  return { id: row!.id, baseVersion: base?.sha ?? null };
}
