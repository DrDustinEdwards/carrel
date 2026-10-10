// A writing repository for the tests: files in memory with real Git blob shas and a line of commits,
// served by a fake of the GitHub endpoints Carrel calls (the tree, contents read at any commit and
// write, a path's commits, and the data API a multi-file commit uses: the ref, a commit, a tree, a
// new tree, a new commit, the ref moved forward) and the two App authentication endpoints. Carrel's
// GitHub client runs unchanged against it.

import { gitBlobSha } from "@dustinedwards/devkit/github";

import { githubRepo, type NovelsRepo } from "~/lib/novels/repo.server";

export const TOKEN = "ghs_test_installation_token";

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  // GitHub wraps its base64 at 60 characters; the client must cope.
  return btoa(binary).replace(/(.{60})/g, "$1\n");
}

function fromBase64(b64: string): string {
  const binary = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export type Commit = { path: string; message: string; author: { name: string; email: string }; sha: string; paths?: string[] };

type Snapshot = Map<string, { source: string; sha: string }>;
type GitCommit = { sha: string; parent: string | null; files: Snapshot; message: string; author: { name: string; email: string }; at: string };

export function fakeNovels(initial: Record<string, string> = {}) {
  const files = new Map<string, { source: string; sha: string }>();
  const commits: Commit[] = [];
  const requests: string[] = [];
  let n = 0;
  // The branch: every commit with the whole tree it holds. 
  const graph = new Map<string, GitCommit>();
  const trees = new Map<string, Snapshot>();
  let head = "";
  // A commit's time is now, and never earlier than the last one, so Git and D1 times sort together.
  let clock = 0;
  const record = (message: string, author: { name: string; email: string }, snapshot: Snapshot = new Map(files)) => {
    const sha = `c0ffee${String(++n).padStart(34, "0")}`;
    clock = Math.max(clock + 1, Date.now());
    graph.set(sha, { sha, parent: head || null, files: snapshot, message, author, at: new Date(clock).toISOString() });
    trees.set(`tree${sha}`, snapshot);
    head = sha;
    return sha;
  };
  const ready = (async () => {
    for (const [path, source] of Object.entries(initial)) files.set(path, { source, sha: await gitBlobSha(source) });
    record("Initial", { name: "Dustin Edwards", email: "dustin@elsewhere.invalid" });
  })();
  /** Lets a test move the branch between the moment Carrel reads the head and the moment it moves it. */
  let beforeRefMove: (() => Promise<void>) | null = null;

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    await ready;
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}`);
    if (url.origin !== "https://api.github.com") throw new Error(`the tests reach only the fake GitHub, not ${request.url}`);
    const auth = request.headers.get("Authorization") ?? "";

    if (url.pathname === "/repos/DrDustinEdwards/writing/installation") {
      return auth.startsWith("Bearer ey") ? json(200, { id: 4242 }) : json(401, { message: "Bad credentials" });
    }
    if (url.pathname === "/app/installations/4242/access_tokens" && request.method === "POST") {
      return json(201, { token: TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (auth !== `Bearer ${TOKEN}`) return json(401, { message: "Bad credentials" });

    const R = "/repos/DrDustinEdwards/writing";
    const listTree = (snapshot: Snapshot) => json(200, { truncated: false, tree: [...snapshot].map(([path, f]) => ({ path, type: "blob", mode: "100644", sha: f.sha })) });
    if (url.pathname === `${R}/git/trees/main`) return listTree(files);
    const treeAt = new RegExp(`^${R}/git/trees/(tree[0-9a-f]+)$`).exec(url.pathname);
    if (treeAt && request.method === "GET") return trees.has(treeAt[1]!) ? listTree(trees.get(treeAt[1]!)!) : json(404, { message: "Not Found" });
    if (url.pathname === `${R}/git/ref/heads/main` && request.method === "GET") return json(200, { object: { sha: head } });
    const commitAt = new RegExp(`^${R}/git/commits/([0-9a-f]+)$`).exec(url.pathname);
    if (commitAt && request.method === "GET") return graph.has(commitAt[1]!) ? json(200, { sha: commitAt[1], tree: { sha: `tree${commitAt[1]}` } }) : json(404, { message: "Not Found" });
    if (url.pathname === `${R}/git/trees` && request.method === "POST") {
      const body = (await request.json()) as { base_tree: string; tree: { path: string; sha: string | null }[] };
      const base = trees.get(body.base_tree);
      if (!base) return json(422, { message: "base_tree not found" });
      const next: Snapshot = new Map(base);
      const known = new Map([...graph.values()].flatMap((c) => [...c.files.values()]).map((f) => [f.sha, f]));
      for (const e of body.tree) {
        if (e.sha === null) next.delete(e.path);
        else if (known.has(e.sha)) next.set(e.path, known.get(e.sha)!);
        else return json(422, { message: `no blob ${e.sha}` });
      }
      const id = `tree${String(trees.size + 1).padStart(36, "f")}`;
      trees.set(id, next);
      return json(201, { sha: id });
    }
    if (url.pathname === `${R}/git/commits` && request.method === "POST") {
      const body = (await request.json()) as { message: string; tree: string; parents: string[]; author: Commit["author"] };
      const snapshot = trees.get(body.tree);
      if (!snapshot) return json(422, { message: "tree not found" });
      const sha = `beef${String(++n).padStart(36, "0")}`;
      clock = Math.max(clock + 1, Date.now());
      graph.set(sha, { sha, parent: body.parents[0] ?? null, files: snapshot, message: body.message, author: body.author, at: new Date(clock).toISOString() });
      trees.set(`tree${sha}`, snapshot);
      return json(201, { sha });
    }
    if (url.pathname === `${R}/git/refs/heads/main` && request.method === "PATCH") {
      const body = (await request.json()) as { sha: string; force: boolean };
      if (beforeRefMove) {
        const run = beforeRefMove;
        beforeRefMove = null;
        await run();
      }
      const next = graph.get(body.sha);
      if (!next) return json(422, { message: "Object does not exist" });
      if (next.parent !== head && !body.force) return json(422, { message: "Update is not a fast forward" });
      const before = graph.get(head)!.files;
      head = next.sha;
      files.clear();
      for (const [path, f] of next.files) files.set(path, f);
      const paths = [...new Set([...before.keys(), ...next.files.keys()])].filter((p) => before.get(p)?.sha !== next.files.get(p)?.sha).sort();
      commits.push({ path: paths[0] ?? "", paths, message: next.message, author: next.author, sha: next.sha });
      return json(200, { object: { sha: head } });
    }
    if (url.pathname === `${R}/commits` && request.method === "GET") {
      const path = url.searchParams.get("path") ?? "";
      const limit = Number(url.searchParams.get("per_page") ?? 30);
      const out = [];
      for (let c = graph.get(head); c && out.length < limit; c = c.parent ? graph.get(c.parent) : undefined) {
        const parent = c.parent ? graph.get(c.parent)!.files : new Map();
        if (c.files.get(path)?.sha !== parent.get(path)?.sha) out.push({ sha: c.sha, commit: { message: c.message, author: { ...c.author, date: c.at } } });
      }
      return json(200, out);
    }
    const contents = new RegExp(`^${R}/contents/(.+)$`).exec(url.pathname);
    if (contents) {
      const path = contents[1]!.split("/").map(decodeURIComponent).join("/");
      const file = files.get(path);
      if (request.method === "GET") {
        const ref = url.searchParams.get("ref") ?? "main";
        const at = ref === "main" ? file : graph.get(ref)?.files.get(path);
        if (ref !== "main" && !graph.has(ref)) return json(404, { message: "No commit found for the ref" });
        return at ? json(200, { type: "file", encoding: "base64", content: toBase64(at.source), sha: at.sha }) : json(404, { message: "Not Found" });
      }
      if (request.method === "PUT") {
        const body = (await request.json()) as { message: string; content: string; sha?: string; branch: string; author: Commit["author"] };
        if (file && !body.sha) return json(422, { message: "Invalid request.\n\n\"sha\" wasn't supplied." });
        if (!file && body.sha) return json(409, { message: "is at a different sha" });
        if (file && body.sha !== file.sha) return json(409, { message: `${path} does not match ${body.sha}` });
        const source = fromBase64(body.content.replace(/\s+/g, ""));
        const sha = await gitBlobSha(source);
        files.set(path, { source, sha });
        const commit = record(body.message, body.author);
        commits.push({ path, message: body.message, author: body.author, sha: commit });
        return json(files.size && file ? 200 : 201, { content: { sha, path }, commit: { sha: commit } });
      }
    }
    return json(404, { message: "Not Found" });
  }) as typeof globalThis.fetch;

  /** Changes a file as if someone committed from elsewhere, so a Carrel save made before it is stale. */
  async function commitElsewhere(path: string, source: string, message = `Edit ${path}`) {
    await ready;
    files.set(path, { source, sha: await gitBlobSha(source) });
    return record(message, { name: "Dustin Edwards", email: "dustin@elsewhere.invalid" });
  }

  /** Runs `change` just before the next ref move, as if someone pushed while Carrel built its commit. */
  function raceNextRefMove(change: () => Promise<void>) {
    beforeRefMove = change;
  }

  const repo: NovelsRepo = githubRepo(async () => TOKEN, fetch);
  return { repo, fetch, files, commits, requests, ready, commitElsewhere, raceNextRefMove, head: () => head };
}

function pem(label: string, bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const body = btoa(binary).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** Reads a DER length at `at`, returning [length, bytes used]. */
function derLen(bytes: Uint8Array, at: number): [number, number] {
  const first = bytes[at]!;
  if (first < 0x80) return [first, 1];
  const n = first & 0x7f;
  let len = 0;
  for (let i = 1; i <= n; i++) len = (len << 8) | bytes[at + i]!;
  return [len, n + 1];
}

/** An RSA key pair, with the private key in PKCS#1 form, the way GitHub hands out App keys. */
export async function githubStyleKey() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  // PKCS#8 is SEQUENCE { version, algorithm, OCTET STRING { PKCS#1 } }: take the octet string's content.
  let at = 1 + derLen(pkcs8, 1)[1];
  at += 3; // version: 02 01 00
  at += 1 + derLen(pkcs8, at + 1)[1] + derLen(pkcs8, at + 1)[0]; // the algorithm SEQUENCE
  const [len, used] = derLen(pkcs8, at + 1);
  const pkcs1 = pkcs8.slice(at + 1 + used, at + 1 + used + len);
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  return { pkcs1Pem: pem("RSA PRIVATE KEY", pkcs1), pkcs8Pem: pem("PRIVATE KEY", pkcs8), publicPem: pem("PUBLIC KEY", spki), pkcs8 };
}
