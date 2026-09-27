// Google through the service account and Dustin's drive.file grant (design decision 6), against the
// fake Google in test/google.ts. Planted: a missing, broken, revoked or old key fails closed with a
// clear health message; a Drive write through the service account is refused in code, unsent.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { decryptToken, finishAuth, oauthConnection, startAuth } from "~/lib/google/oauth.server";
import { importFromDocs, listManuscripts, refreshManuscripts, searchManuscripts, sendToDocs } from "~/lib/google/drive.server";
import { pageStats, refreshSearchConsole } from "~/lib/google/search-console.server";
import { assertReadOnly, clearSaTokenCache, GoogleNotConnected, SA_SCOPES, saClient, ServiceAccountRefused } from "~/lib/google/service-account.server";
import { autosave, readDraft } from "~/lib/content.server";
import { runHealth } from "~/lib/health.server";
import { requireSiteProject } from "~/lib/projects.server";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { CLIENT_EMAIL, CODE, fakeGoogle, KEY_ID, REFRESH, serviceAccountKey } from "./google";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const FOLDER = "folderRoot1";
const TOKEN_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const SLUG = "de-info";

let key: Awaited<ReturnType<typeof serviceAccountKey>>;
beforeAll(async () => {
  key = await serviceAccountKey();
});

let google: ReturnType<typeof fakeGoogle>;
let site: ReturnType<typeof fakeSite>;
let env: Env;

function googleEnv(overrides: Record<string, string | undefined> = {}): Env {
  return {
    ...connectedEnv(),
    GOOGLE_SA_KEY: key.json,
    GOOGLE_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    GOOGLE_TOKEN_KEY: TOKEN_KEY,
    GOOGLE_MANUSCRIPTS_FOLDER_ID: FOLDER,
    ...overrides,
  } as Env;
}

/** Google or the site, by origin, as the Worker's one fetch would reach either. */
function both(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    return url.startsWith("https://site.test") ? site.fetch(input, init) : google.fetch(input, init);
  }) as typeof fetch;
}

beforeEach(async () => {
  clearSaTokenCache();
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const id = await addProject(SLUG, "dustinedwards");
  await share(id, editor, "editor");
  google = fakeGoogle({
    publicJwk: key.publicJwk,
    files: [
      { id: "m1", name: "Grant proposal", mimeType: "application/vnd.google-apps.document", parent: FOLDER, content: "Aims: stromatolites of the Paluxy." },
      { id: "sub1", name: "Papers", mimeType: "application/vnd.google-apps.folder", parent: FOLDER },
      { id: "m2", name: "Trackways paper", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", parent: "sub1", content: "Theropod trackways in the riverbed." },
      { id: "elsewhere", name: "Not a manuscript", mimeType: "application/vnd.google-apps.document", parent: "someOtherFolder", content: "trackways too" },
    ],
    scRows: [{ keys: ["https://site.test/blog/post-one"], clicks: 12, impressions: 340, ctr: 0.035, position: 8.44 }],
  });
  site = fakeSite();
  env = googleEnv();
});

describe("the service account", () => {
  it("asks for an access token with a JWT signed by its key, for read-only scopes, once an hour", async () => {
    const sa = saClient(env, google.fetch);
    await sa.request("GET", `https://www.googleapis.com/drive/v3/files?q=x`);
    await sa.request("GET", `https://www.googleapis.com/drive/v3/files?q=y`);
    expect(google.assertions).toHaveLength(1);
    expect(google.assertions[0]).toMatchObject({ iss: CLIENT_EMAIL, scope: SA_SCOPES.join(" ") });
  });

  it("never asks for drive.readonly, or any scope that writes", () => {
    expect(SA_SCOPES).toEqual(["https://www.googleapis.com/auth/drive.metadata.readonly", "https://www.googleapis.com/auth/webmasters.readonly"]);
  });

  it("PLANT: a Drive write through the service account is refused in code, before anything is sent", async () => {
    const sa = saClient(env, google.fetch);
    const attempts: [string, string][] = [
      ["POST", "https://www.googleapis.com/drive/v3/files"],
      ["POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart"],
      ["PATCH", "https://www.googleapis.com/drive/v3/files/m1?fields=id"],
      ["DELETE", "https://www.googleapis.com/drive/v3/files/m1?supportsAllDrives=true"],
      ["POST", "https://www.googleapis.com/drive/v3/files/m1/copy"],
      ["POST", "https://www.googleapis.com/drive/v3/files/m1/permissions"],
      // Reading a file's text is not the service account's either.
      ["GET", "https://www.googleapis.com/drive/v3/files/m1/export?mimeType=text/plain"],
      ["GET", "https://www.googleapis.com/drive/v3/files/m1?alt=media"],
      ["PUT", "https://searchconsole.googleapis.com/webmasters/v3/sites/x/sitemaps/y"],
    ];
    for (const [method, url] of attempts) {
      await expect(sa.request(method, url), `${method} ${url}`).rejects.toBeInstanceOf(ServiceAccountRefused);
    }
    expect(google.requests).toEqual([]);
    // And the reads it does make pass.
    expect(() => assertReadOnly("GET", "https://www.googleapis.com/drive/v3/files?q=x")).not.toThrow();
  });

  it("PLANT: a missing key fails closed: no request, and a clear reason", () => {
    expect(() => saClient(googleEnv({ GOOGLE_SA_KEY: undefined }), google.fetch)).toThrow(GoogleNotConnected);
    expect(() => saClient(googleEnv({ GOOGLE_SA_KEY: "{not json" }), google.fetch)).toThrow("GOOGLE_SA_KEY is not JSON");
    const elsewhere = JSON.stringify({ ...JSON.parse(key.json), token_uri: "https://evil.example/token" });
    expect(() => saClient(googleEnv({ GOOGLE_SA_KEY: elsewhere }), google.fetch)).toThrow("not Google's");
    expect(google.requests).toEqual([]);
  });
});

describe("health for Google", () => {
  const certs = async (url: string, init?: RequestInit) =>
    url.includes("cloudflareaccess.com") ? Response.json({ keys: [{ kid: "k" }] }) : google.fetch(url, init);
  const mailbox = () => ({ send: async () => ({ messageId: "m" }) }) as unknown as SendEmail;

  async function check(e: Env, name: string, now = new Date("2026-09-27T00:00:00Z")) {
    const { results } = await runHealth({ ...e, EMAIL: mailbox() }, certs, () => now);
    return results.find((r) => r.name === name)!;
  }

  it("reports a key that works and its age from the first time it was seen", async () => {
    expect(await check(env, "google-service-account")).toEqual({ name: "google-service-account", ok: true, detail: `Key ${KEY_ID.slice(0, 8)} (${CLIENT_EMAIL}) works; 0 days old.` });
    clearSaTokenCache();
    expect((await check(env, "google-service-account", new Date("2026-10-27T00:00:00Z"))).detail).toContain("works; 30 days old.");
  });

  it("PLANT: a missing key says so plainly, as not connected yet", async () => {
    expect(await check(googleEnv({ GOOGLE_SA_KEY: undefined }), "google-service-account")).toEqual({
      name: "google-service-account",
      ok: true,
      detail: "Not connected: GOOGLE_SA_KEY is not set, so the manuscripts index and Search Console are off.",
    });
  });

  it("PLANT: a key Google refuses (deleted, disabled, expired) fails with what to do", async () => {
    google.state.saRevoked = true;
    const result = await check(env, "google-service-account");
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/^Key 01234567 \(carrel-reader@.+\) no longer works: Google refused the service account key \(400 invalid_grant: Invalid JWT Signature\.\)\. Create a new key and set GOOGLE_SA_KEY\.$/);
  });

  it("PLANT: a key past 90 days fails, asking for rotation", async () => {
    await check(env, "google-service-account", new Date("2026-06-01T00:00:00Z"));
    clearSaTokenCache();
    const result = await check(env, "google-service-account", new Date("2026-09-27T00:00:00Z"));
    expect(result).toMatchObject({ ok: false, detail: "Key 01234567 is 118 days old, past 90. Create a new key, set GOOGLE_SA_KEY, then delete the old one in Google Cloud." });
  });

  it("PLANT: a revoked drive.file grant fails; none connected is not a failure", async () => {
    expect(await check(env, "google-drive-file")).toMatchObject({ ok: true, detail: expect.stringMatching(/^Not connected: no one has connected/) });
    await connectGoogle();
    expect(await check(env, "google-drive-file")).toMatchObject({ ok: true });
    google.state.userRevoked = true;
    expect(await check(env, "google-drive-file")).toMatchObject({ ok: false, detail: expect.stringContaining("Google refused the drive.file grant (400 invalid_grant)") });
  });
});

describe("the manuscripts index", () => {
  it("walks the shared folder and its subfolders, keeping metadata and no text", async () => {
    const result = await refreshManuscripts(env, google.fetch);
    expect(result).toEqual({ files: 2, removed: 0, folders: 2, more: false });
    const owner = await viewerFor("owner@test.invalid");
    const list = await listManuscripts(testEnv.DB, owner);
    expect(list.map((m) => [m.name, m.folder, m.people])).toEqual(
      expect.arrayContaining([
        ["Grant proposal", "", ["Dustin Edwards", "A Coauthor"]],
        ["Trackways paper", "Papers", ["Dustin Edwards", "A Coauthor"]],
      ]),
    );
    // Not a word of either manuscript is in Carrel's database.
    const dump = JSON.stringify(await testEnv.DB.prepare("SELECT * FROM manuscripts").all());
    expect(dump).not.toContain("stromatolites");
    expect(dump).not.toContain("Theropod");
  });

  it("picks up files added later and drops files removed", async () => {
    await refreshManuscripts(env, google.fetch);
    google.files.push({ id: "m3", name: "New chapter", mimeType: "application/pdf", parent: "sub1" });
    google.files.splice(google.files.findIndex((f) => f.id === "m1"), 1);
    expect(await refreshManuscripts(env, google.fetch)).toMatchObject({ files: 2, removed: 1 });
    const names = (await listManuscripts(testEnv.DB, await viewerFor("owner@test.invalid"))).map((m) => m.name).sort();
    expect(names).toEqual(["New chapter", "Trackways paper"]);
  });

  it("searches the text through Drive, and returns only files in the folder", async () => {
    await refreshManuscripts(env, google.fetch);
    const owner = await viewerFor("owner@test.invalid");
    expect(await searchManuscripts(env, owner, "trackways", google.fetch)).toMatchObject({ searched: "text", files: [{ name: "Trackways paper" }] });
    expect((await searchManuscripts(env, owner, "no such words", google.fetch)).files).toEqual([]);
    // Quotes in the search are escaped for Drive's query language, not injected into it.
    expect((await searchManuscripts(env, owner, "x' or name contains 'a", google.fetch)).files).toEqual([]);
  });

  it("falls back to titles, and says so, if Drive will not run a full-text query for this access", async () => {
    await refreshManuscripts(env, google.fetch);
    google.state.refuseFullText = true;
    const owner = await viewerFor("owner@test.invalid");
    expect(await searchManuscripts(env, owner, "grant", google.fetch)).toMatchObject({ searched: "titles", files: [{ name: "Grant proposal" }] });
  });

  it("PLANT: manuscripts are the Owner's alone", async () => {
    const editor = await viewerFor("editor@test.invalid");
    await expect(listManuscripts(testEnv.DB, editor)).rejects.toMatchObject({ status: 404 });
    await expect(searchManuscripts(env, editor, "x", google.fetch)).rejects.toMatchObject({ status: 404 });
  });
});

async function connectGoogle() {
  const owner = await viewerFor("owner@test.invalid");
  const start = new URL(await startAuth(env, owner, "https://carrel.test"));
  return finishAuth(env, owner, new URLSearchParams({ state: start.searchParams.get("state")!, code: CODE }), "https://carrel.test", google.fetch);
}

describe("connecting drive.file", () => {
  it("asks Google for drive.file alone, offline, back to Carrel's own callback", async () => {
    const start = new URL(await startAuth(env, await viewerFor("owner@test.invalid"), "https://carrel.test"));
    expect(start.origin + start.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(start.searchParams)).toMatchObject({
      scope: "https://www.googleapis.com/auth/drive.file",
      access_type: "offline",
      redirect_uri: "https://carrel.test/auth/google/callback",
      response_type: "code",
    });
  });

  it("stores the refresh token encrypted, never as it came", async () => {
    expect(await connectGoogle()).toEqual({ ok: true });
    const row = await testEnv.DB.prepare("SELECT refresh_token, iv, scope FROM google_tokens").first<{ refresh_token: string; iv: string; scope: string }>();
    expect(row!.refresh_token).not.toContain(REFRESH);
    const c = await oauthConnection(env);
    if (c.state !== "configured" || !c.key) throw new Error("not configured");
    expect(await decryptToken(c.key, row!.refresh_token, row!.iv)).toBe(REFRESH);
  });

  it("PLANT: a callback Carrel did not start, or one used twice, is refused", async () => {
    const owner = await viewerFor("owner@test.invalid");
    expect(await finishAuth(env, owner, new URLSearchParams({ state: "forged", code: CODE }), "https://carrel.test", google.fetch)).toMatchObject({ ok: false });
    const start = new URL(await startAuth(env, owner, "https://carrel.test"));
    const params = new URLSearchParams({ state: start.searchParams.get("state")!, code: CODE });
    expect(await finishAuth(env, owner, params, "https://carrel.test", google.fetch)).toEqual({ ok: true });
    expect(await finishAuth(env, owner, params, "https://carrel.test", google.fetch)).toMatchObject({ ok: false });
  });

  it("PLANT: a grant wider than drive.file is refused and nothing is stored", async () => {
    google.state.grantedScope = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly";
    const result = await connectGoogle();
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("Carrel keeps only a drive.file grant") });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM google_tokens").first()).toEqual({ n: 0 });
  });

  it("PLANT: only the Owner connects Google", async () => {
    await expect(startAuth(env, await viewerFor("editor@test.invalid"), "https://carrel.test")).rejects.toMatchObject({ status: 403 });
  });
});

describe("Send to Docs and Import", () => {
  async function seeded() {
    await site.adapter.content.saveDraft("post-one", { source: "---\ntitle: Post one\n---\nThe body, with *emphasis*.\n", expectedVersion: null, changeId: "s" });
    await connectGoogle();
    const owner = await viewerFor("owner@test.invalid");
    return { owner, project: await requireSiteProject(testEnv.DB, owner, SLUG, "read") };
  }

  it("sends the post's body as a new Doc and keeps its frontmatter in Carrel", async () => {
    const { owner, project } = await seeded();
    const sent = await sendToDocs(env, project, owner, "post-one", both());
    expect(sent).toMatchObject({ ok: true, url: "https://docs.google.com/document/d/doc1/edit" });
    expect(google.docs.get("doc1")).toEqual({ name: "Post one (from Carrel)", content: "The body, with *emphasis*.\n" });
  });

  it("imports the Doc's text as a new draft under the post's frontmatter, leaving the site alone", async () => {
    const { owner, project } = await seeded();
    await sendToDocs(env, project, owner, "post-one", both());
    google.state.docEdits.set("doc1", "The body, edited by a coauthor.\n");
    expect(await importFromDocs(env, project, owner, "post-one", both())).toEqual({ ok: true, words: 6 });
    expect((await readDraft(testEnv.DB, project, owner, "post-one"))?.source).toBe("---\ntitle: Post one\n---\nThe body, edited by a coauthor.\n");
    expect((await site.adapter.content.get("post-one"))?.source).toBe("---\ntitle: Post one\n---\nThe body, with *emphasis*.\n");
  });

  it("PLANT: an import never replaces a working draft", async () => {
    const { owner, project } = await seeded();
    await sendToDocs(env, project, owner, "post-one", both());
    await autosave(testEnv.DB, project, owner, "post-one", { source: "My unsaved words.", baseVersion: null });
    expect(await importFromDocs(env, project, owner, "post-one", both())).toMatchObject({ ok: false, message: expect.stringContaining("an import never replaces a draft") });
    expect((await readDraft(testEnv.DB, project, owner, "post-one"))?.source).toBe("My unsaved words.");
  });

  it("PLANT: an Editor cannot send outside Carrel", async () => {
    await seeded();
    const editor = await viewerFor("editor@test.invalid");
    const project = await requireSiteProject(testEnv.DB, editor, SLUG, "read");
    await expect(sendToDocs(env, project, editor, "post-one", both())).rejects.toMatchObject({ status: 403 });
    expect(google.docs.size).toBe(0);
  });

  it("PLANT: without a connected grant, Send fails closed and says how to connect", async () => {
    await site.adapter.content.saveDraft("post-one", { source: "x", expectedVersion: null, changeId: "s" });
    const owner = await viewerFor("owner@test.invalid");
    const project = await requireSiteProject(testEnv.DB, owner, SLUG, "read");
    await expect(sendToDocs(env, project, owner, "post-one", both())).rejects.toThrow("Google is not connected for Send to Docs yet.");
    expect(google.docs.size).toBe(0);
  });
});

describe("Search Console", () => {
  it("reads 28 days per page, settled data only, at most once a day, and finds a post's row by its URL", async () => {
    const owner = await viewerFor("owner@test.invalid");
    const project = await requireSiteProject(testEnv.DB, owner, SLUG, "read");
    const now = new Date("2026-09-27T12:00:00Z");
    expect(await refreshSearchConsole(env, project, google.fetch, now)).toEqual({ pages: 1, skipped: false, start: "2026-08-28", end: "2026-09-24" });
    expect(google.requests.filter((r) => r.includes("searchAnalytics"))).toEqual([
      "POST https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Adustinedwards.info/searchAnalytics/query",
    ]);
    expect((await refreshSearchConsole(env, project, google.fetch, new Date("2026-09-27T20:00:00Z"))).skipped).toBe(true);
    expect(await pageStats(env, project, "/blog/post-one")).toMatchObject({ clicks: 12, impressions: 340, position: 8.44 });
    expect(await pageStats(env, project, "/blog/other")).toBeNull();
  });

  it("says what to do when the service account is not on the property", async () => {
    google.state.scStatus = 403;
    const project = await requireSiteProject(testEnv.DB, await viewerFor("owner@test.invalid"), SLUG, "read");
    await expect(refreshSearchConsole(env, project, google.fetch)).rejects.toThrow("Add the service account as a user on the property in Search Console.");
  });
});
