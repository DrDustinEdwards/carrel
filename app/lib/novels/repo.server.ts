// The writing repository, reached through the GitHub App `carrel-writer` (design setup step 8),
// installed on that one repository with contents read and write and nothing else. Carrel reads the
// tree and files and commits one file at a time, each with the version it expects to replace. A move
// that renames several files is one commit made through Git's data API (commitMany), and a file's
// history is the commits that touched its path.

import { SignJWT } from "jose";

export const NOVELS_REPO = "DrDustinEdwards/writing";
export const NOVELS_BRANCH = "main";
const API = "https://api.github.com";

export type RepoFile = { source: string; sha: string };

/** One file renamed in a multi-file commit: its blob is kept, only its path changes. */
export type Rename = { from: string; to: string; sha: string };

/** A commit that touched a path, newest first, as GitHub lists it. */
export type PathCommit = { sha: string; message: string; author: string; email: string; at: string };

/** A write refused because the file is not at the version the writer expected. */
export class GitConflict extends Error {
  constructor(readonly currentSha: string | null) {
    super("version-conflict");
  }
}

export class NovelsNotConnected extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

export interface NovelsRepo {
  /** Every file under `prefix` (a folder, no trailing slash), with its blob sha. */
  tree(prefix: string): Promise<{ path: string; sha: string }[]>;
  read(path: string): Promise<RepoFile | null>;
  /**
   * Commits one file. `expectedSha` null means the file must not exist yet. Throws GitConflict when
   * the file is not at that version.
   */
  write(path: string, input: { source: string; expectedSha: string | null; message: string; author: { name: string; email: string } }): Promise<{ sha: string; commit: string }>;
  /**
   * Renames several files in ONE commit on the branch. Each file must be at `sha` in the branch head
   * and no file may already be at a `to` path that is not also moving away; otherwise GitConflict.
   * The branch moves only forward: a head that moved while the commit was built is a GitConflict too.
   */
  commitMany(input: { renames: Rename[]; message: string; author: { name: string; email: string } }): Promise<{ commit: string }>;
  /** The commits on the branch that touched `path`, newest first, at most `limit`. */
  history(path: string, limit?: number): Promise<PathCommit[]>;
  /** The file as it was at a commit, or null when it was not there. */
  readAt(path: string, commit: string): Promise<RepoFile | null>;
}

// ---------- the connection

export type NovelsConnection =
  | { state: "connected"; appId: string; privateKey: string }
  | { state: "not-connected" | "misconfigured"; detail: string };

export function novelsConnection(env: Env): NovelsConnection {
  const appId = env.NOVELS_APP_ID?.trim();
  const key = env.NOVELS_APP_PRIVATE_KEY?.trim();
  if (!appId && !key) {
    return { state: "not-connected", detail: "The GitHub App for the writing repository is not set up yet (NOVELS_APP_ID, NOVELS_APP_PRIVATE_KEY)." };
  }
  if (!appId || !/^\d+$/.test(appId)) return { state: "misconfigured", detail: "NOVELS_APP_ID is missing or is not the App's numeric id." };
  if (!key || !/-----BEGIN (RSA )?PRIVATE KEY-----/.test(key)) {
    return { state: "misconfigured", detail: "NOVELS_APP_PRIVATE_KEY is missing or is not a PEM private key." };
  }
  return { state: "connected", appId, privateKey: key };
}

// ---------- GitHub App authentication

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array | number[]): number[] {
  const body = Array.from(content);
  return [tag, ...derLength(body.length), ...body];
}

/**
 * GitHub hands out App keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto imports PKCS#8 only. The
 * PKCS#8 form is the PKCS#1 key wrapped with the rsaEncryption algorithm id, so Dustin can paste the
 * downloaded file as it is.
 */
export function pkcs8FromPem(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "");
  const bytes = base64ToBytes(body);
  if (!/BEGIN RSA PRIVATE KEY/.test(pem)) return bytes;
  const version = der(0x02, [0x00]);
  // SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }
  const algorithm = der(0x30, [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return new Uint8Array(der(0x30, [...version, ...algorithm, ...der(0x04, bytes)]));
}

export async function appJwt(appId: string, pem: string, now = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pkcs8FromPem(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const iat = Math.floor(now / 1000) - 60; // GitHub allows for clock drift this way.
  return new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(appId).setIssuedAt(iat).setExpirationTime(iat + 540).sign(key);
}

type Fetch = typeof fetch;

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "carrel",
  };
}

/** Installation tokens last an hour; one per isolate, renewed five minutes early. */
const tokenCache = new Map<string, { token: string; expires: number }>();

export async function installationToken(appId: string, pem: string, fetcher: Fetch = fetch, now = Date.now()): Promise<string> {
  const cached = tokenCache.get(appId);
  if (cached && cached.expires - 5 * 60_000 > now) return cached.token;
  const jwt = await appJwt(appId, pem, now);
  const inst = await fetcher(`${API}/repos/${NOVELS_REPO}/installation`, { headers: headers(jwt) });
  if (!inst.ok) throw new Error(`GitHub did not find the App's installation on ${NOVELS_REPO} (${inst.status}).`);
  const { id } = (await inst.json()) as { id: number };
  // Narrowed to the one repository and to contents, whatever the installation allows.
  const res = await fetcher(`${API}/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers: headers(jwt),
    body: JSON.stringify({ repositories: [NOVELS_REPO.split("/")[1]], permissions: { contents: "write" } }),
  });
  if (!res.ok) throw new Error(`GitHub refused an installation token (${res.status}).`);
  const body = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(appId, { token: body.token, expires: Date.parse(body.expires_at) });
  return body.token;
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

// ---------- the GitHub contents client

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

function base64ToUtf8(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}

export function githubRepo(token: () => Promise<string>, fetcher: Fetch = fetch): NovelsRepo {
  const repoUrl = `${API}/repos/${NOVELS_REPO}`;
  const call = async (url: string, init: RequestInit = {}) => fetcher(url, { ...init, headers: { ...headers(await token()), ...init.headers } });

  const repo: NovelsRepo = {
    async tree(prefix) {
      const res = await call(`${repoUrl}/git/trees/${NOVELS_BRANCH}?recursive=1`);
      if (!res.ok) throw new Error(`GitHub did not list the writing repository (${res.status}).`);
      const body = (await res.json()) as { truncated: boolean; tree: { path: string; type: string; sha: string }[] };
      // A truncated tree would make files look deleted; refuse it rather than index half a book.
      if (body.truncated) throw new Error("GitHub truncated the writing repository's tree; it is too large to list in one call.");
      const start = `${prefix}/`;
      return body.tree.filter((e) => e.type === "blob" && e.path.startsWith(start)).map((e) => ({ path: e.path.slice(start.length), sha: e.sha }));
    },

    read(path) {
      return repo.readAt(path, NOVELS_BRANCH);
    },

    async readAt(path, ref) {
      const res = await call(`${repoUrl}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub did not return ${path} (${res.status}).`);
      const body = (await res.json()) as { type: string; content?: string; encoding?: string; sha: string };
      if (body.type !== "file" || body.encoding !== "base64" || body.content === undefined) throw new Error(`${path} is not a file GitHub returns inline.`);
      return { source: base64ToUtf8(body.content), sha: body.sha };
    },

    async write(path, input) {
      const res = await call(`${repoUrl}/contents/${encodePath(path)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: input.message,
          content: utf8ToBase64(input.source),
          branch: NOVELS_BRANCH,
          author: input.author,
          ...(input.expectedSha ? { sha: input.expectedSha } : {}),
        }),
      });
      // 409: the sha is not the file's; 422: a create for a file that exists (no sha supplied).
      if (res.status === 409 || res.status === 422) {
        const current = await repo.read(path);
        // A 422 for a file that is where the writer expected is some other refusal, not a conflict.
        if ((current?.sha ?? null) === input.expectedSha) throw new Error(`GitHub refused the commit to ${path} (${res.status}).`);
        throw new GitConflict(current?.sha ?? null);
      }
      if (!res.ok) throw new Error(`GitHub did not accept the commit to ${path} (${res.status}).`);
      const body = (await res.json()) as { content: { sha: string }; commit: { sha: string } };
      return { sha: body.content.sha, commit: body.commit.sha };
    },

    async commitMany(input) {
      if (input.renames.length === 0) throw new Error("A multi-file commit needs at least one change.");
      const json = async <T>(res: Response, what: string): Promise<T> => {
        if (!res.ok) throw new Error(`GitHub did not ${what} (${res.status}).`);
        return (await res.json()) as T;
      };
      const ref = await json<{ object: { sha: string } }>(await call(`${repoUrl}/git/ref/heads/${NOVELS_BRANCH}`), "return the branch head");
      const head = ref.object.sha;
      const commit = await json<{ tree: { sha: string } }>(await call(`${repoUrl}/git/commits/${head}`), "return the head commit");
      const tree = await json<{ truncated: boolean; tree: { path: string; type: string; sha: string; mode: string }[] }>(
        await call(`${repoUrl}/git/trees/${commit.tree.sha}?recursive=1`),
        "list the head's tree",
      );
      if (tree.truncated) throw new Error("GitHub truncated the writing repository's tree; it is too large to move files in one commit.");
      const at = new Map(tree.tree.filter((e) => e.type === "blob").map((e) => [e.path, e]));
      // Every file must be where the mover saw it, and no move may land on a file that stays.
      const leaving = new Set(input.renames.map((r) => r.from));
      for (const r of input.renames) {
        const entry = at.get(r.from);
        if (!entry || entry.sha !== r.sha) throw new GitConflict(entry?.sha ?? null);
        if (at.has(r.to) && !leaving.has(r.to)) throw new GitConflict(at.get(r.to)!.sha);
      }
      const arriving = new Set(input.renames.map((r) => r.to));
      const entries = [
        ...input.renames.filter((r) => !arriving.has(r.from)).map((r) => ({ path: r.from, mode: at.get(r.from)!.mode, type: "blob", sha: null })),
        ...input.renames.map((r) => ({ path: r.to, mode: at.get(r.from)!.mode, type: "blob", sha: r.sha })),
      ];
      const post = (url: string, body: unknown) => call(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const made = await json<{ sha: string }>(await post(`${repoUrl}/git/trees`, { base_tree: commit.tree.sha, tree: entries }), "build the new tree");
      const next = await json<{ sha: string }>(
        await post(`${repoUrl}/git/commits`, { message: input.message, tree: made.sha, parents: [head], author: input.author }),
        "make the commit",
      );
      // Never forced: if anyone committed since the head was read, the branch refuses to move.
      const moved = await call(`${repoUrl}/git/refs/heads/${NOVELS_BRANCH}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha: next.sha, force: false }),
      });
      if (moved.status === 422 || moved.status === 409) throw new GitConflict(null);
      if (!moved.ok) throw new Error(`GitHub did not move the branch to the new commit (${moved.status}).`);
      return { commit: next.sha };
    },

    async history(path, limit = 30) {
      const res = await call(`${repoUrl}/commits?sha=${NOVELS_BRANCH}&path=${encodeURIComponent(path)}&per_page=${Math.min(100, Math.max(1, limit))}`);
      if (!res.ok) throw new Error(`GitHub did not list the history of ${path} (${res.status}).`);
      const body = (await res.json()) as { sha: string; commit: { message: string; author: { name: string; email: string; date: string } } }[];
      return body.map((c) => ({ sha: c.sha, message: c.commit.message, author: c.commit.author.name, email: c.commit.author.email, at: c.commit.author.date }));
    },
  };
  return repo;
}

/** The repository for this Worker's credentials; throws NovelsNotConnected until the App is set up. */
export function novelsRepo(env: Env, fetcher: Fetch = fetch): NovelsRepo {
  const connection = novelsConnection(env);
  if (connection.state !== "connected") throw new NovelsNotConnected(connection.detail);
  return githubRepo(() => installationToken(connection.appId, connection.privateKey, fetcher), fetcher);
}
