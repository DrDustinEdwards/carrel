// The GitHub client for the writing repository, against the fake GitHub in test/novels.ts: the App's
// key as GitHub downloads it, the token exchange, text that survives the round trip, and a stale or
// blind write refused as a conflict rather than overwriting someone's commit.

import { importSPKI, jwtVerify } from "jose";
import { beforeEach, describe, expect, it } from "vitest";

import {
  appJwt,
  clearTokenCache,
  GitConflict,
  installationToken,
  novelsConnection,
  novelsRepo,
  NovelsNotConnected,
  pkcs8FromPem,
} from "~/lib/novels/repo.server";

import { testEnv } from "./env";
import { blobSha, fakeNovels, githubStyleKey, TOKEN } from "./novels";

beforeEach(() => clearTokenCache());

describe("the App's key and token", () => {
  it("accepts the PKCS#1 key GitHub downloads, byte for byte the PKCS#8 WebCrypto would export", async () => {
    const key = await githubStyleKey();
    expect(key.pkcs1Pem).toContain("BEGIN RSA PRIVATE KEY");
    expect([...pkcs8FromPem(key.pkcs1Pem)]).toEqual([...key.pkcs8]);
    expect([...pkcs8FromPem(key.pkcs8Pem)]).toEqual([...key.pkcs8]);
  });

  it("signs an RS256 JWT GitHub can verify: issuer the App id, back-dated a minute, under ten minutes", async () => {
    const key = await githubStyleKey();
    const now = Date.UTC(2026, 8, 27, 3, 0, 0);
    const jwt = await appJwt("123456", key.pkcs1Pem, now);
    const { payload, protectedHeader } = await jwtVerify(jwt, await importSPKI(key.publicPem, "RS256"), { currentDate: new Date(now) });
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.iss).toBe("123456");
    expect(payload.iat).toBe(now / 1000 - 60);
    expect(payload.exp! - payload.iat!).toBe(540);
  });

  it("exchanges the JWT for an installation token narrowed to the writing repository, and reuses it", async () => {
    const key = await githubStyleKey();
    const gh = fakeNovels();
    const bodies: string[] = [];
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) bodies.push(String(init.body));
      return gh.fetch(input, init);
    }) as typeof fetch;
    expect(await installationToken("123456", key.pkcs1Pem, spy)).toBe(TOKEN);
    expect(await installationToken("123456", key.pkcs1Pem, spy)).toBe(TOKEN);
    expect(gh.requests).toEqual(["GET /repos/DrDustinEdwards/writing/installation", "POST /app/installations/4242/access_tokens"]);
    expect(JSON.parse(bodies[0]!)).toEqual({ repositories: ["writing"], permissions: { contents: "write" } });
  });

  it("is not connected without secrets, and misconfigured with half of them or a bad key", () => {
    expect(novelsConnection(testEnv).state).toBe("not-connected");
    expect(novelsConnection({ ...testEnv, NOVELS_APP_ID: "123" }).state).toBe("misconfigured");
    expect(novelsConnection({ ...testEnv, NOVELS_APP_ID: "abc", NOVELS_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----x" }).state).toBe("misconfigured");
    expect(novelsConnection({ ...testEnv, NOVELS_APP_ID: "123", NOVELS_APP_PRIVATE_KEY: "not a key" }).state).toBe("misconfigured");
    expect(novelsConnection({ ...testEnv, NOVELS_APP_ID: "123", NOVELS_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----" }).state).toBe(
      "connected",
    );
    expect(() => novelsRepo(testEnv)).toThrow(NovelsNotConnected);
  });

  it("works end to end from the Worker's secrets", async () => {
    const key = await githubStyleKey();
    const gh = fakeNovels({ "book-a/book.md": "---\ntitle: A\n---\n" });
    const repo = novelsRepo({ ...testEnv, NOVELS_APP_ID: "77", NOVELS_APP_PRIVATE_KEY: key.pkcs1Pem }, gh.fetch);
    expect(await repo.tree("book-a")).toEqual([{ path: "book.md", sha: await blobSha("---\ntitle: A\n---\n") }]);
  });
});

describe("the contents client", () => {
  it("lists a book's files relative to its folder, and nothing outside it", async () => {
    const gh = fakeNovels({ "book-a/chapters/01-a/01-b.md": "x", "book-a/book.md": "y", "book-ab/book.md": "z", "shared/voice/one.md": "v" });
    const tree = await gh.repo.tree("book-a");
    expect(tree.map((f) => f.path).sort()).toEqual(["book.md", "chapters/01-a/01-b.md"]);
  });

  it("reads and writes text beyond ASCII unchanged, with the sha Git would give it", async () => {
    const gh = fakeNovels();
    const source = "---\npov: Zoë\n---\n“Río,” she said. Naïve café, … and a 🐎.\n".repeat(20);
    const written = await gh.repo.write("book-a/chapters/01-a/01-b.md", { source, expectedSha: null, message: "m", author: { name: "D", email: "d@test.invalid" } });
    expect(written.sha).toBe(await blobSha(source));
    expect(await gh.repo.read("book-a/chapters/01-a/01-b.md")).toEqual({ source, sha: written.sha });
    expect(await gh.repo.read("book-a/missing.md")).toBeNull();
  });

  it("PLANT: a save against a stale version is a conflict naming the current version, and Git is unchanged", async () => {
    const gh = fakeNovels({ "book-a/book.md": "one" });
    const stale = await blobSha("one");
    await gh.commitElsewhere("book-a/book.md", "two");
    const attempt = gh.repo.write("book-a/book.md", { source: "mine", expectedSha: stale, message: "m", author: { name: "D", email: "d@test.invalid" } });
    await expect(attempt).rejects.toBeInstanceOf(GitConflict);
    await expect(attempt).rejects.toMatchObject({ currentSha: await blobSha("two") });
    expect(gh.files.get("book-a/book.md")!.source).toBe("two");
    expect(gh.commits).toHaveLength(0);
  });

  it("PLANT: creating a file that already exists is a conflict, not an overwrite", async () => {
    const gh = fakeNovels({ "book-a/book.md": "theirs" });
    await expect(
      gh.repo.write("book-a/book.md", { source: "mine", expectedSha: null, message: "m", author: { name: "D", email: "d@test.invalid" } }),
    ).rejects.toBeInstanceOf(GitConflict);
    expect(gh.files.get("book-a/book.md")!.source).toBe("theirs");
  });
});
