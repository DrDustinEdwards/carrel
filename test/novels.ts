// A writing repository for the tests: files in memory with real Git blob shas, served by a fake of
// the three GitHub endpoints Carrel calls (tree, contents read, contents write) and the two App
// authentication endpoints. Carrel's GitHub client runs unchanged against it.

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

export type Commit = { path: string; message: string; author: { name: string; email: string }; sha: string };

export function fakeNovels(initial: Record<string, string> = {}) {
  const files = new Map<string, { source: string; sha: string }>();
  const commits: Commit[] = [];
  const requests: string[] = [];
  let n = 0;
  const ready = (async () => {
    for (const [path, source] of Object.entries(initial)) files.set(path, { source, sha: await gitBlobSha(source) });
  })();

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

    if (url.pathname === "/repos/DrDustinEdwards/writing/git/trees/main") {
      return json(200, { truncated: false, tree: [...files].map(([path, f]) => ({ path, type: "blob", sha: f.sha })) });
    }
    const contents = /^\/repos\/DrDustinEdwards\/writing\/contents\/(.+)$/.exec(url.pathname);
    if (contents) {
      const path = contents[1]!.split("/").map(decodeURIComponent).join("/");
      const file = files.get(path);
      if (request.method === "GET") {
        return file ? json(200, { type: "file", encoding: "base64", content: toBase64(file.source), sha: file.sha }) : json(404, { message: "Not Found" });
      }
      if (request.method === "PUT") {
        const body = (await request.json()) as { message: string; content: string; sha?: string; branch: string; author: Commit["author"] };
        if (file && !body.sha) return json(422, { message: "Invalid request.\n\n\"sha\" wasn't supplied." });
        if (!file && body.sha) return json(409, { message: "is at a different sha" });
        if (file && body.sha !== file.sha) return json(409, { message: `${path} does not match ${body.sha}` });
        const source = fromBase64(body.content.replace(/\s+/g, ""));
        const sha = await gitBlobSha(source);
        files.set(path, { source, sha });
        const commit = `c0ffee${String(++n).padStart(34, "0")}`;
        commits.push({ path, message: body.message, author: body.author, sha: commit });
        return json(files.size && file ? 200 : 201, { content: { sha, path }, commit: { sha: commit } });
      }
    }
    return json(404, { message: "Not Found" });
  }) as typeof globalThis.fetch;

  /** Changes a file as if someone committed from elsewhere, so a Carrel save made before it is stale. */
  async function commitElsewhere(path: string, source: string) {
    await ready;
    files.set(path, { source, sha: await gitBlobSha(source) });
  }

  const repo: NovelsRepo = githubRepo(async () => TOKEN, fetch);
  return { repo, fetch, files, commits, requests, ready, commitElsewhere };
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
