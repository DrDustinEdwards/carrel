// Drive, two ways (design section 5, "Manuscripts" and "Google Docs"):
//
// - The manuscripts index, through the service account: the shared folder's files and their
//   metadata (name, type, dates, owners and last editor), refreshed so files added later appear.
//   Manuscript text never enters Carrel; search asks Drive's own full-text search each time.
// - Send to Docs and Import, through Dustin's drive.file grant: a post's body goes out as a new Doc,
//   and comes back as a new draft, never over one.

import { notInList } from "@dustinedwards/site-runtime/d1";
import { and, asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { googleTokens, manuscripts, sentDocs } from "~/db/schema";
import { AiRefusal } from "~/lib/ai.server";
import { autosave, readDoc, readDraft } from "~/lib/content.server";
import { hasRoom, replaceRoom } from "~/lib/rooms.server";
import type { Viewer } from "~/lib/people.server";
import type { SiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";

import { exportGoogleDoc, GOOGLE_DOC, waitingIn } from "./docs.server";
import { userAccessToken } from "./oauth.server";
import { GoogleNotConnected, saClient } from "./service-account.server";
import { timedFetch } from "@dustinedwards/site-runtime/http";
import { splitSource } from "@drdustinedwards/site-helpers/frontmatter";
import { normalizeNewlines, wordCount } from "@drdustinedwards/site-helpers/text";

type Fetch = typeof fetch;

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
const FILE_FIELDS =
  "id,name,mimeType,webViewLink,createdTime,modifiedTime,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress)";
/** How many folders one refresh walks; a manuscripts folder is far smaller. */
const MAX_FOLDERS = 200;
/** The Docs one walk reads to count their open AI suggestions (Docs API: 300 reads a minute per user). */
const MAX_RECOUNTS = 25;

/** The folder Dustin shares with the service account. A var, read loosely like CARREL_ORIGIN. */
export function manuscriptsFolder(env: Env): string | null {
  const id = (
    env as { GOOGLE_MANUSCRIPTS_FOLDER_ID?: string }
  ).GOOGLE_MANUSCRIPTS_FOLDER_ID?.trim();
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
    const params = new URLSearchParams({
      q,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
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
  const names = [...(f.owners ?? []), ...(f.lastModifyingUser ? [f.lastModifyingUser] : [])]
    .map((p) => p.displayName || p.emailAddress || "")
    .filter(Boolean);
  return [...new Set(names)];
}

export type ManuscriptRefresh = { files: number; removed: number; folders: number; more: boolean };

/** Walks the shared folder and its subfolders, upserts every file, and drops what Drive no longer has. */
export async function refreshManuscripts(
  env: Env,
  fetcher?: Fetch,
  now = new Date(),
): Promise<ManuscriptRefresh> {
  const queue = await indexRoots(env);
  const sa = saClient(env, fetcher);
  const at = now.toISOString();
  const files: (DriveFile & { folder: string })[] = [];
  let folders = 0;
  while (queue.length > 0 && folders < MAX_FOLDERS) {
    const folder = queue.shift()!;
    folders++;
    for (const f of await listAll(sa, `${quote(folder.id)} in parents and trashed = false`)) {
      if (f.mimeType === FOLDER)
        queue.push({ id: f.id, path: folder.path ? `${folder.path}/${f.name}` : f.name });
      else files.push({ ...f, folder: folder.path });
    }
  }
  const d = drizzle(env.DB);
  // The Docs that changed since the last walk have their open AI suggestions counted again (slice 7), a few a walk; one
  // not counted keeps the modified time it had, so the next walk counts it.
  const before = new Map(
    (
      await d
        .select({ id: manuscripts.fileId, at: manuscripts.modifiedTime })
        .from(manuscripts)
        .all()
    ).map((r) => [r.id, r.at]),
  );
  const recount = files.filter(
    (f) => f.mimeType === GOOGLE_DOC && before.get(f.id) !== (f.modifiedTime ?? null),
  );
  const waiting = new Map<string, number>();
  for (const f of recount.slice(0, MAX_RECOUNTS)) {
    const n = await waitingIn(env, f.id, fetcher);
    if (n !== null) waiting.set(f.id, n);
  }
  const later = new Set(recount.filter((f) => !waiting.has(f.id)).map((f) => f.id));
  for (const f of files) {
    const values = {
      name: f.name,
      mimeType: f.mimeType,
      webViewLink: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
      folder: f.folder,
      people: JSON.stringify(peopleOf(f)),
      createdTime: f.createdTime ?? null,
      modifiedTime: later.has(f.id) ? (before.get(f.id) ?? null) : (f.modifiedTime ?? null),
      syncedAt: at,
      ...(waiting.has(f.id) ? { waiting: waiting.get(f.id)! } : {}),
    };
    await d
      .insert(manuscripts)
      .values({ fileId: f.id, ...values })
      .onConflictDoUpdate({ target: manuscripts.fileId, set: values });
  }
  // Only a complete walk may drop rows; a walk cut short would make unwalked files look deleted.
  let removed = 0;
  if (queue.length === 0) {
    const seen = files.map((f) => f.id);
    const gone = await d
      .delete(manuscripts)
      .where(seen.length ? notInList(manuscripts.fileId, seen) : undefined)
      .returning({ id: manuscripts.fileId });
    removed = gone.length;
  }
  return { files: files.length, removed, folders, more: queue.length > 0 };
}

export type Manuscript = {
  fileId: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  folder: string;
  people: string[];
  modifiedTime: string | null;
};

export async function listManuscripts(db: D1Database, viewer: Viewer): Promise<Manuscript[]> {
  requireOwner(viewer);
  const rows = await drizzle(db)
    .select()
    .from(manuscripts)
    .orderBy(desc(manuscripts.modifiedTime), asc(manuscripts.name))
    .all();
  return rows.map((r) => ({
    fileId: r.fileId,
    name: r.name,
    mimeType: r.mimeType,
    webViewLink: r.webViewLink,
    folder: r.folder,
    people: JSON.parse(r.people) as string[],
    modifiedTime: r.modifiedTime,
  }));
}

export type ManuscriptSearch = { files: Manuscript[]; searched: "text" | "titles" };

/**
 * Full-text search through Drive, limited to the files in the index (the shared folder): the words
 * are matched by Google against the documents where they live, and only which files matched comes
 * back to Carrel. Google's docs do not say whether a metadata-only scope may run a full-text query;
 * if Drive refuses one, the search falls back to titles and says so.
 */
export async function searchManuscripts(
  env: Env,
  viewer: Viewer,
  words: string,
  fetcher?: Fetch,
): Promise<ManuscriptSearch> {
  requireOwner(viewer);
  const q = words.trim().slice(0, 200);
  const all = await listManuscripts(env.DB, viewer);
  if (!q) return { files: all, searched: "text" };
  const sa = saClient(env, fetcher);
  const notFolder = `trashed = false and mimeType != ${quote(FOLDER)}`;
  let searched: ManuscriptSearch["searched"] = "text";
  let hits: DriveFile[];
  try {
    hits = await listAll(sa, `fullText contains ${quote(q)} and ${notFolder}`);
  } catch {
    searched = "titles";
    hits = await listAll(sa, `name contains ${quote(q)} and ${notFolder}`);
  }
  const ids = new Set(hits.map((h) => h.id));
  // Anything else the service account can see is not a manuscript; only indexed files count.
  return { files: all.filter((m) => ids.has(m.fileId)), searched };
}

// ---------- Send to Docs and Import, over drive.file

function splitFrontmatter(source: string): { frontmatter: string; body: string } {
  const s = splitSource(normalizeNewlines(source));
  if (s.front === null) return { frontmatter: "", body: source };
  const fence = `${s.open}${s.front}${s.close}`;
  return { frontmatter: fence.endsWith("\n") ? fence : `${fence}\n`, body: s.body };
}

/**
 * A new Google Doc in Dustin's Drive from Markdown or a Word file, through his drive.file grant: Google converts the
 * content on upload (its own Markdown and Word import).
 */
async function uploadAsDoc(
  token: string,
  file: {
    name: string;
    type: string;
    body: string | ArrayBuffer;
    parents?: string[];
    description?: string;
  },
  fetcher: Fetch,
): Promise<Response> {
  const boundary = `carrel-${crypto.randomUUID()}`;
  const meta = {
    name: file.name,
    mimeType: GOOGLE_DOC,
    ...(file.parents ? { parents: file.parents } : {}),
    ...(file.description ? { description: file.description } : {}),
  };
  const head = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(meta),
    `--${boundary}`,
    `Content-Type: ${file.type}${typeof file.body === "string" ? "; charset=UTF-8" : ""}`,
    "",
    "",
  ].join("\r\n");
  return fetcher(
    `${UPLOAD}?uploadType=multipart&fields=id,name,webViewLink,createdTime,modifiedTime`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: new Blob([head, file.body, `\r\n--${boundary}--\r\n`]),
    },
  );
}

/** Where Carrel's new Docs go, and how the index names that folder. */
export const CARREL_FOLDER = "Made in Carrel";

/**
 * The folder for the Docs Carrel creates, made once in Dustin's Drive with his drive.file grant (which reaches only
 * what Carrel made) and shared with the service account as an editor, so the Docs tools reach every Doc in it.
 */
async function carrelFolder(env: Env, viewer: Viewer, token: string, fetcher: Fetch) {
  const d = drizzle(env.DB);
  const row = await d
    .select({ folderId: googleTokens.folderId })
    .from(googleTokens)
    .where(eq(googleTokens.personId, viewer.id))
    .get();
  if (row?.folderId) return row.folderId;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const made = await fetcher(`${DRIVE}?fields=id`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: CARREL_FOLDER, mimeType: FOLDER }),
  });
  if (!made.ok)
    throw new GoogleNotConnected(`Google did not make Carrel's folder (${made.status}).`);
  const { id } = (await made.json()) as { id: string };
  const shared = await fetcher(
    `${DRIVE}/${encodeURIComponent(id)}/permissions?sendNotificationEmail=false`,
    {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        role: "writer",
        type: "user",
        emailAddress: saClient(env).key.clientEmail,
      }),
    },
  );
  if (!shared.ok)
    throw new GoogleNotConnected(
      `Google made Carrel's folder but did not share it with the service account (${shared.status}).`,
    );
  await d.update(googleTokens).set({ folderId: id }).where(eq(googleTokens.personId, viewer.id));
  return id;
}

/** The folders the index walks: the shared Manuscripts folder, and the one Carrel made for new Docs, if any. */
async function indexRoots(env: Env): Promise<{ id: string; path: string }[]> {
  const root = manuscriptsFolder(env);
  if (!root)
    throw new GoogleNotConnected(
      "GOOGLE_MANUSCRIPTS_FOLDER_ID is not set to the shared folder's id.",
    );
  const made = await drizzle(env.DB)
    .select({ folderId: googleTokens.folderId })
    .from(googleTokens)
    .all();
  return [
    { id: root, path: "" },
    ...made.flatMap((r) => (r.folderId ? [{ id: r.folderId, path: CARREL_FOLDER }] : [])),
  ];
}

/**
 * A new Google Doc on Dustin's ask, from Markdown or as a copy of a Doc in the index (Google's Word export and
 * import, so formatting carries over; suggestions and comments do not). It goes in Carrel's folder, joins the index
 * at once so the Docs tools reach it, and says in its Drive description which AI made it and why.
 */
export async function createGoogleDoc(
  env: Env,
  viewer: Viewer,
  input: { title: string; text?: string; copyOf?: string; label: string },
  fetcher: Fetch = timedFetch,
) {
  requireOwner(viewer);
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new AiRefusal("title is the new Doc's name.");
  if (input.copyOf && input.text) throw new AiRefusal("Give text or copy_of, not both.");
  const token = await userAccessToken(env, viewer.id, fetcher);
  const content = input.copyOf
    ? await exportGoogleDoc(env, viewer, input.copyOf, "docx", fetcher)
    : { type: "text/markdown", body: input.text ?? "" };
  const folder = await carrelFolder(env, viewer, token, fetcher);
  const res = await uploadAsDoc(
    token,
    { name: title, ...content, parents: [folder], description: input.label },
    fetcher,
  );
  if (!res.ok) throw new AiRefusal(`Google did not create the Doc (${res.status}).`);
  const f = (await res.json()) as DriveFile;
  const url = f.webViewLink ?? `https://docs.google.com/document/d/${f.id}/edit`;
  const values = {
    name: f.name || title,
    mimeType: GOOGLE_DOC,
    webViewLink: url,
    folder: CARREL_FOLDER,
    people: "[]",
    createdTime: f.createdTime ?? null,
    modifiedTime: f.modifiedTime ?? null,
    syncedAt: new Date().toISOString(),
  };
  await drizzle(env.DB)
    .insert(manuscripts)
    .values({ fileId: f.id, ...values })
    .onConflictDoUpdate({ target: manuscripts.fileId, set: values });
  return { docId: f.id, title: values.name, url };
}

/** Sending outside Carrel is the Owner's (design section 3, "Roles": send externally). */
function requireSend(project: SiteProject) {
  if (!can(project.role, "send_external")) throw new Response("Forbidden", { status: 403 });
}

/**
 * Copies a post into a new Google Doc in Dustin's Drive: his working draft if he has one, else the
 * site's text. Only the body goes; the frontmatter stays in Carrel for Import to put back.
 */
export async function sendToDocs(
  env: Env,
  project: SiteProject,
  viewer: Viewer,
  itemId: string,
  fetcher: Fetch = timedFetch,
) {
  requireSend(project);
  const draft = await readDraft(env.DB, project, viewer, itemId);
  const doc = draft ? null : await readDoc(env, project, itemId, fetcher);
  const source = draft?.source ?? doc?.source;
  if (source === undefined) return { ok: false as const, message: "There is nothing to send yet." };
  const { frontmatter, body } = splitFrontmatter(source);
  const title = /^title:\s*"?(.*?)"?\s*$/m.exec(frontmatter)?.[1] || doc?.title || itemId;

  const token = await userAccessToken(env, viewer.id, fetcher);
  const res = await uploadAsDoc(
    token,
    { name: `${title} (from Carrel)`, type: "text/markdown", body },
    fetcher,
  );
  if (!res.ok)
    return { ok: false as const, message: `Google Docs did not accept the post (${res.status}).` };
  const created = (await res.json()) as { id: string; webViewLink?: string };
  const url = created.webViewLink ?? `https://docs.google.com/document/d/${created.id}/edit`;
  await drizzle(env.DB).insert(sentDocs).values({
    projectId: project.id,
    itemId,
    personId: viewer.id,
    docId: created.id,
    docUrl: url,
    frontmatter,
  });
  return { ok: true as const, docId: created.id, url };
}

export async function lastSentDoc(db: D1Database, project: SiteProject, itemId: string) {
  return (
    (await drizzle(db)
      .select({
        docId: sentDocs.docId,
        url: sentDocs.docUrl,
        frontmatter: sentDocs.frontmatter,
        createdAt: sentDocs.createdAt,
      })
      .from(sentDocs)
      .where(and(eq(sentDocs.projectId, project.id), eq(sentDocs.itemId, itemId)))
      .orderBy(desc(sentDocs.createdAt), desc(sentDocs.id))
      .get()) ?? null
  );
}

/**
 * Brings the Doc's text back as the working copy, never over unsaved work: with changes nobody has
 * saved, it is refused until they are saved or discarded. The frontmatter kept at Send goes back on top.
 */
export async function importFromDocs(
  env: Env,
  project: SiteProject,
  viewer: Viewer,
  itemId: string,
  fetcher: Fetch = timedFetch,
) {
  requireSend(project);
  const sent = await lastSentDoc(env.DB, project, itemId);
  if (!sent)
    return {
      ok: false as const,
      message:
        "This post has not been sent to Google Docs from Carrel, so there is no Doc to import.",
    };
  if (await readDraft(env.DB, project, viewer, itemId)) {
    return {
      ok: false as const,
      message:
        "This post has changes nobody has saved. Save them to the site or discard them first; an import never replaces unsaved work.",
    };
  }
  const token = await userAccessToken(env, viewer.id, fetcher);
  const res = await fetcher(
    `${DRIVE}/${encodeURIComponent(sent.docId)}/export?mimeType=text%2Fmarkdown`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok)
    return {
      ok: false as const,
      message: `Google did not export the Doc (${res.status}). It may have been deleted or moved out of reach.`,
    };
  const body = normalizeNewlines(await res.text());
  const current = await readDoc(env, project, itemId, fetcher);
  const source = `${sent.frontmatter}${body}`;
  // A file open for live editing takes the import in its room, where everyone sees it.
  if (await hasRoom(env.DB, project.id, itemId))
    await replaceRoom(env, project, viewer, itemId, {
      markdown: source,
      version: current?.version ?? null,
      unsaved: true,
    });
  else
    await autosave(env.DB, project, viewer, itemId, {
      source,
      baseVersion: current?.version ?? null,
    });
  return { ok: true as const, words: wordCount(body) };
}
