// Drive, two ways (design section 5, "Manuscripts" and "Google Docs"):
//
// - The manuscripts index, through the service account: the shared folder's files and their
//   metadata (name, type, dates, owners and last editor), refreshed so files added later appear.
//   Manuscript text never enters Carrel; search asks Drive's own full-text search each time.
// - Send to Docs and Import, through Dustin's drive.file grant: a post's body goes out as a new Doc,
//   and comes back as a new draft, never over one.

import { and, asc, desc, eq, notInArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { manuscripts, sentDocs } from "~/db/schema";
import { autosave, readDoc, readDraft } from "~/lib/content.server";
import type { Viewer } from "~/lib/people.server";
import type { SiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";

import { userAccessToken } from "./oauth.server";
import { GoogleNotConnected, saClient } from "./service-account.server";

type Fetch = typeof fetch;

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,mimeType,webViewLink,createdTime,modifiedTime,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress)";
/** How many folders one refresh walks; a manuscripts folder is far smaller. */
const MAX_FOLDERS = 200;

/** The folder Dustin shares with the service account. A var, read loosely like CARREL_ORIGIN. */
export function manuscriptsFolder(env: Env): string | null {
  const id = (env as { GOOGLE_MANUSCRIPTS_FOLDER_ID?: string }).GOOGLE_MANUSCRIPTS_FOLDER_ID?.trim();
  return id && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

/** Manuscripts are Dustin's alone (design section 3, "Roles"). */
function requireOwner(viewer: Viewer) {
  if (!viewer.isOwner) throw new Response("Not found", { status: 404 });
}

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  createdTime?: string;
  modifiedTime?: string;
  owners?: { displayName?: string; emailAddress?: string }[];
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
};

/** Drive's query language quotes with single quotes and escapes with a backslash. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

async function listAll(sa: ReturnType<typeof saClient>, q: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await sa.request("GET", `${DRIVE}?${params}`);
    if (!res.ok) throw new Error(`Drive did not list the folder (${res.status}).`);
    const body = (await res.json()) as { files: DriveFile[]; nextPageToken?: string };
    out.push(...body.files);
    pageToken = body.nextPageToken;
  } while (pageToken);
  return out;
}

function peopleOf(f: DriveFile): string[] {
  const names = [...(f.owners ?? []), ...(f.lastModifyingUser ? [f.lastModifyingUser] : [])].map((p) => p.displayName || p.emailAddress || "").filter(Boolean);
  return [...new Set(names)];
}

export type ManuscriptRefresh = { files: number; removed: number; folders: number; more: boolean };

/** Walks the shared folder and its subfolders, upserts every file, and drops what Drive no longer has. */
export async function refreshManuscripts(env: Env, fetcher?: Fetch, now = new Date()): Promise<ManuscriptRefresh> {
  const root = manuscriptsFolder(env);
  if (!root) throw new GoogleNotConnected("GOOGLE_MANUSCRIPTS_FOLDER_ID is not set to the shared folder's id.");
  const sa = saClient(env, fetcher);
  const at = now.toISOString();
  const queue: { id: string; path: string }[] = [{ id: root, path: "" }];
  const files: (DriveFile & { folder: string })[] = [];
  let folders = 0;
  while (queue.length > 0 && folders < MAX_FOLDERS) {
    const folder = queue.shift()!;
    folders++;
    for (const f of await listAll(sa, `${quote(folder.id)} in parents and trashed = false`)) {
      if (f.mimeType === FOLDER) queue.push({ id: f.id, path: folder.path ? `${folder.path}/${f.name}` : f.name });
      else files.push({ ...f, folder: folder.path });
    }
  }
  const d = drizzle(env.DB);
  for (const f of files) {
    const values = {
      name: f.name,
      mimeType: f.mimeType,
      webViewLink: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
      folder: f.folder,
      people: JSON.stringify(peopleOf(f)),
      createdTime: f.createdTime ?? null,
      modifiedTime: f.modifiedTime ?? null,
      syncedAt: at,
    };
    await d.insert(manuscripts).values({ fileId: f.id, ...values }).onConflictDoUpdate({ target: manuscripts.fileId, set: values });
  }
  // Only a complete walk may drop rows; a walk cut short would make unwalked files look deleted.
  let removed = 0;
  if (queue.length === 0) {
    const seen = files.map((f) => f.id);
    const gone = await d
      .delete(manuscripts)
      .where(seen.length ? notInArray(manuscripts.fileId, seen) : undefined)
      .returning({ id: manuscripts.fileId });
    removed = gone.length;
  }
  return { files: files.length, removed, folders, more: queue.length > 0 };
}

export type Manuscript = { fileId: string; name: string; mimeType: string; webViewLink: string; folder: string; people: string[]; modifiedTime: string | null };

export async function listManuscripts(db: D1Database, viewer: Viewer): Promise<Manuscript[]> {
  requireOwner(viewer);
  const rows = await drizzle(db).select().from(manuscripts).orderBy(desc(manuscripts.modifiedTime), asc(manuscripts.name)).all();
  return rows.map((r) => ({ fileId: r.fileId, name: r.name, mimeType: r.mimeType, webViewLink: r.webViewLink, folder: r.folder, people: JSON.parse(r.people) as string[], modifiedTime: r.modifiedTime }));
}

/**
 * Full-text search through Drive, limited to the files in the index (the shared folder): the words
 * are matched by Google against the documents where they live, and only which files matched comes
 * back to Carrel.
 */
export async function searchManuscripts(env: Env, viewer: Viewer, words: string, fetcher?: Fetch): Promise<Manuscript[]> {
  requireOwner(viewer);
  const q = words.trim().slice(0, 200);
  if (!q) return listManuscripts(env.DB, viewer);
  const sa = saClient(env, fetcher);
  const hits = new Set((await listAll(sa, `fullText contains ${quote(q)} and trashed = false and mimeType != ${quote(FOLDER)}`)).map((h) => h.id));
  // Anything else the service account can see is not a manuscript; only indexed files count.
  return (await listManuscripts(env.DB, viewer)).filter((m) => hits.has(m.fileId));
}

// ---------- Send to Docs and Import, over drive.file

function splitFrontmatter(source: string): { frontmatter: string; body: string } {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(source.replace(/\r\n/g, "\n"));
  return m ? { frontmatter: m[0].endsWith("\n") ? m[0] : `${m[0]}\n`, body: source.replace(/\r\n/g, "\n").slice(m[0].length) } : { frontmatter: "", body: source };
}

/** Sending outside Carrel is the Owner's (design section 3, "Roles": send externally). */
function requireSend(project: SiteProject) {
  if (!can(project.role, "send_external")) throw new Response("Forbidden", { status: 403 });
}

/**
 * Copies a post into a new Google Doc in Dustin's Drive: his working draft if he has one, else the
 * site's text. Only the body goes; the frontmatter stays in Carrel for Import to put back.
 */
export async function sendToDocs(env: Env, project: SiteProject, viewer: Viewer, itemId: string, fetcher: Fetch = fetch) {
  requireSend(project);
  const draft = await readDraft(env.DB, project, viewer, itemId);
  const doc = draft ? null : await readDoc(env, project, itemId, fetcher);
  const source = draft?.source ?? doc?.source;
  if (source === undefined) return { ok: false as const, message: "There is nothing to send yet." };
  const { frontmatter, body } = splitFrontmatter(source);
  const title = /^title:\s*"?(.*?)"?\s*$/m.exec(frontmatter)?.[1] || doc?.title || itemId;

  const token = await userAccessToken(env, viewer.id, fetcher);
  const boundary = `carrel-${crypto.randomUUID()}`;
  const multipart = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ name: `${title} (from Carrel)`, mimeType: "application/vnd.google-apps.document" }),
    `--${boundary}`,
    "Content-Type: text/markdown; charset=UTF-8",
    "",
    body,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const res = await fetcher(`${UPLOAD}?uploadType=multipart&fields=id,webViewLink`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  if (!res.ok) return { ok: false as const, message: `Google Docs did not accept the post (${res.status}).` };
  const created = (await res.json()) as { id: string; webViewLink?: string };
  const url = created.webViewLink ?? `https://docs.google.com/document/d/${created.id}/edit`;
  await drizzle(env.DB).insert(sentDocs).values({ projectId: project.id, itemId, personId: viewer.id, docId: created.id, docUrl: url, frontmatter });
  return { ok: true as const, docId: created.id, url };
}

export async function lastSentDoc(db: D1Database, project: SiteProject, itemId: string) {
  return (
    (await drizzle(db)
      .select({ docId: sentDocs.docId, url: sentDocs.docUrl, frontmatter: sentDocs.frontmatter, createdAt: sentDocs.createdAt })
      .from(sentDocs)
      .where(and(eq(sentDocs.projectId, project.id), eq(sentDocs.itemId, itemId)))
      .orderBy(desc(sentDocs.createdAt), desc(sentDocs.id))
      .get()) ?? null
  );
}

/**
 * Brings the Doc's text back as a new draft, never over one: with a working draft open, it is
 * refused until that draft is saved or discarded. The frontmatter kept at Send goes back on top.
 */
export async function importFromDocs(env: Env, project: SiteProject, viewer: Viewer, itemId: string, fetcher: Fetch = fetch) {
  requireSend(project);
  const sent = await lastSentDoc(env.DB, project, itemId);
  if (!sent) return { ok: false as const, message: "This post has not been sent to Google Docs from Carrel, so there is no Doc to import." };
  if (await readDraft(env.DB, project, viewer, itemId)) {
    return { ok: false as const, message: "You have a working draft of this post. Save it to the site or discard it first; an import never replaces a draft." };
  }
  const token = await userAccessToken(env, viewer.id, fetcher);
  const res = await fetcher(`${DRIVE}/${encodeURIComponent(sent.docId)}/export?mimeType=text%2Fmarkdown`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { ok: false as const, message: `Google did not export the Doc (${res.status}). It may have been deleted or moved out of reach.` };
  const body = (await res.text()).replace(/\r\n/g, "\n");
  const current = await readDoc(env, project, itemId, fetcher);
  await autosave(env.DB, project, viewer, itemId, { source: `${sent.frontmatter}${body}`, baseVersion: current?.version ?? null });
  return { ok: true as const, words: body.split(/\s+/).filter(Boolean).length };
}
