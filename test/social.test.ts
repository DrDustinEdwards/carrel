// The social queue (design decision 5) against fake Bluesky, X and routine endpoints. Planted: a reply
// attempt refused; a post failing the lint held; the template used only after the routine fails; the
// health email when a template post goes out. Nothing here reaches a real platform.

import { beforeEach, describe, expect, it } from "vitest";

import { writeToSite } from "~/lib/content.server";
import { runHealth } from "~/lib/health.server";
import { requireSiteProject } from "~/lib/projects.server";
import { lintPost } from "~/lib/social/lint";
import { assertOriginalPost, clearBlueskySessions, oauthSignature, percentEncode, SocialRefused } from "~/lib/social/platforms.server";
import {
  BATCH_DELAY_MS,
  createAccount,
  decidePost,
  draftSocialPost,
  processSocial,
  recordPublication,
  ROUTINE_WAIT_MS,
  setSwitches,
  socialOverview,
} from "~/lib/social/queue.server";

import { addPerson, addProject, resetDb, testEnv } from "./env";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const ROUTINE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_01TEST/fire";

type Sent = { url: string; body: Record<string, unknown>; auth: string | null };

/** Bluesky, X and the routine trigger, answering as the real ones do. */
function fakeWorld(routineStatus: number | (() => number) = 200) {
  const sent: Sent[] = [];
  const fires: { text: string; headers: Record<string, string> }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (request.url === ROUTINE_URL) {
      fires.push({ text: String(body.text ?? ""), headers: Object.fromEntries(request.headers) });
      const status = typeof routineStatus === "function" ? routineStatus() : routineStatus;
      if (status !== 200) return Response.json({ type: "error", error: { type: status === 429 ? "rate_limit_error" : "authentication_error", message: "no" } }, { status });
      return Response.json({ type: "routine_fire", claude_code_session_id: "session_01", claude_code_session_url: "https://claude.ai/code/session_01" });
    }
    sent.push({ url: request.url, body, auth: request.headers.get("Authorization") });
    if (request.url.endsWith("createSession")) return Response.json({ accessJwt: "jwt", did: "did:plc:test" });
    if (request.url.endsWith("createRecord")) return Response.json({ uri: `at://did:plc:test/app.bsky.feed.post/${sent.length}` });
    if (request.url === "https://api.x.com/2/tweets") return Response.json({ data: { id: `x${sent.length}`, text: body.text } });
    throw new Error(`the tests reach only the fakes, not ${request.url}`);
  }) as typeof globalThis.fetch;
  return { fetch, sent, fires };
}

let projectId: number;
let env: Env;
const NOW = new Date("2026-09-27T15:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

function mailbox() {
  const sent: { subject: string; text: string }[] = [];
  return { sent, EMAIL: { send: async (m: { subject: string; text: string }) => (sent.push(m), { messageId: "m" }) } as unknown as SendEmail };
}

async function owner() {
  return viewerFor("owner@test.invalid");
}

async function account(key: string, opts: { platform?: "bluesky" | "x"; kind?: "brand" | "personal"; mode?: "auto" | "approval"; budget?: number } = {}) {
  const o = await owner();
  const created = await createAccount(testEnv.DB, o, { key, name: key, platform: opts.platform ?? "bluesky", kind: opts.kind ?? "brand", handle: `${key}.bsky.social`, projectId });
  if (!created.ok) throw new Error(created.error);
  const row = await testEnv.DB.prepare("SELECT id FROM social_accounts WHERE key = ?").bind(key).first<{ id: number }>();
  await setSwitches(testEnv.DB, o, row!.id, { enabled: true, mode: opts.mode ?? "auto", monthlyBudgetMills: opts.budget ?? 0 });
  return row!.id;
}

async function posts() {
  return (await socialOverview(testEnv.DB, await owner())).posts.map((p) => ({ ...p.post, accountKey: p.accountKey }));
}

const PIECE = { id: "post-one", title: "Stromatolites of the Paluxy", url: "https://site.test/blog/post-one", summary: "What the river keeps." };

beforeEach(async () => {
  clearBlueskySessions();
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  projectId = await addProject("germomics", "dustinedwards");
  env = {
    ...connectedEnv(),
    SOCIAL_ROUTINE_URL: ROUTINE_URL,
    SOCIAL_ROUTINE_TOKEN: "sk-ant-oat01-test",
    SOCIAL_GERMOMICS_BLUESKY_BLUESKY_APP_PASSWORD: "app-pass",
    SOCIAL_FOXING_BLUESKY_BLUESKY_APP_PASSWORD: "app-pass-2",
    SOCIAL_DUSTIN_X_X_API_KEY: "k",
    SOCIAL_DUSTIN_X_X_API_SECRET: "s",
    SOCIAL_DUSTIN_X_X_ACCESS_TOKEN: "t",
    SOCIAL_DUSTIN_X_X_ACCESS_SECRET: "ts",
  } as Env;
});

describe("PLANT: a reply attempt is refused, before anything is sent", () => {
  it("refuses a Bluesky record with a reply, a follow, a like, and any other endpoint", () => {
    const bsky = "https://bsky.social/xrpc/com.atproto.repo.createRecord";
    const reply = { uri: "at://x", cid: "y" };
    expect(() => assertOriginalPost("POST", bsky, { repo: "d", collection: "app.bsky.feed.post", record: { $type: "app.bsky.feed.post", text: "hi", reply: { root: reply, parent: reply } } })).toThrow(SocialRefused);
    expect(() => assertOriginalPost("POST", bsky, { repo: "d", collection: "app.bsky.graph.follow", record: { $type: "app.bsky.graph.follow" } })).toThrow(SocialRefused);
    expect(() => assertOriginalPost("POST", bsky, { repo: "d", collection: "app.bsky.feed.like", record: { $type: "app.bsky.feed.like" } })).toThrow(SocialRefused);
    expect(() => assertOriginalPost("POST", "https://api.bsky.chat/xrpc/chat.bsky.convo.sendMessage", {})).toThrow(SocialRefused);
    expect(() => assertOriginalPost("GET", "https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=x", undefined)).toThrow(SocialRefused);
  });

  it("refuses an X post that replies or quotes, and any other X endpoint", () => {
    expect(() => assertOriginalPost("POST", "https://api.x.com/2/tweets", { text: "hi", reply: { in_reply_to_tweet_id: "1" } })).toThrow(SocialRefused);
    expect(() => assertOriginalPost("POST", "https://api.x.com/2/tweets", { text: "hi", quote_tweet_id: "1" })).toThrow(SocialRefused);
    expect(() => assertOriginalPost("POST", "https://api.x.com/2/dm_conversations/with/1/messages", { text: "hi" })).toThrow(SocialRefused);
  });

  it("lets an original post through", () => {
    expect(() => assertOriginalPost("POST", "https://api.x.com/2/tweets", { text: "hi" })).not.toThrow();
    expect(() => assertOriginalPost("POST", "https://bsky.social/xrpc/com.atproto.repo.createRecord", { repo: "d", collection: "app.bsky.feed.post", record: { $type: "app.bsky.feed.post", text: "hi" } })).not.toThrow();
  });
});

describe("X signing", () => {
  it("matches the OAuth 1.0a signature in X's own documentation", async () => {
    // developer.x.com, "Creating a signature": the published example and its expected result.
    const params = {
      include_entities: "true",
      oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
      oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: "1318622958",
      oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      oauth_version: "1.0",
      status: "Hello Ladies + Gentlemen, a signed OAuth request!",
    };
    expect(await oauthSignature("POST", "https://api.twitter.com/1.1/statuses/update.json", params, "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE")).toBe(
      "hCtSmYh+iHYCEqBWrE7C7hYmtUk=",
    );
    expect(percentEncode("Ladies + Gentlemen!*'()")).toBe("Ladies%20%2B%20Gentlemen%21%2A%27%28%29");
  });
});

describe("the primary path: a draft stored ahead", () => {
  it("sends the pre-drafted post when the piece goes live, with no routine and no AI", async () => {
    await account("germomics-bluesky");
    const world = fakeWorld();
    expect(await draftSocialPost(testEnv.DB, { accountKey: "germomics-bluesky", projectId, itemId: "post-one", text: `New episode: Stromatolites. ${PIECE.url}`, createdBy: "Claude 1.0" })).toMatchObject({ ok: true });

    // Before it goes live, nothing moves.
    expect((await processSocial(env, { fetcher: world.fetch, now: NOW })).sent).toBe(0);
    await recordPublication(testEnv.DB, projectId, PIECE, NOW);
    const tick = await processSocial(env, { fetcher: world.fetch, now: NOW });
    expect(tick).toMatchObject({ linted: 1, sent: 1, routineFired: 0, templated: 0 });
    expect(world.fires).toEqual([]);
    const record = world.sent.find((s) => s.url.endsWith("createRecord"))!;
    expect(record.body).toMatchObject({ collection: "app.bsky.feed.post", record: { text: `New episode: Stromatolites. ${PIECE.url}` } });
    expect((record.body.record as { facets: unknown[] }).facets).toHaveLength(1);
    expect((await posts())[0]).toMatchObject({ status: "sent", source: "predrafted", createdBy: "Claude 1.0" });
  });

  it("PLANT: a post failing the lint is held, and goes only once edited and approved", async () => {
    const id = await account("germomics-bluesky");
    const world = fakeWorld();
    await draftSocialPost(testEnv.DB, { accountKey: "germomics-bluesky", projectId, itemId: "post-one", text: "Let's delve into the tapestry of the Paluxy.", createdBy: "Claude" });
    await recordPublication(testEnv.DB, projectId, PIECE, NOW);
    await processSocial(env, { fetcher: world.fetch, now: NOW });
    const [held] = await posts();
    expect(held).toMatchObject({ status: "held" });
    expect(JSON.parse(held!.lint)).toEqual(['"delve" is on the AI-habits list.', '"tapestry" is on the AI-habits list.']);
    expect(world.sent).toEqual([]);

    const o = await owner();
    expect(await decidePost(testEnv.DB, o, held!.id, { action: "approve" })).toMatchObject({ ok: false });
    await setSwitches(testEnv.DB, o, id, { mode: "approval" });
    expect(await decidePost(testEnv.DB, o, held!.id, { action: "edit", text: `A new episode on the Paluxy's stromatolites. ${PIECE.url}` })).toMatchObject({ ok: true, findings: [] });
    expect(await decidePost(testEnv.DB, o, held!.id, { action: "approve" })).toEqual({ ok: true });
    expect((await processSocial(env, { fetcher: world.fetch, now: NOW })).sent).toBe(1);
  });
});

describe("the routine, and the template only after it fails", () => {
  async function published() {
    await account("germomics-bluesky");
    await recordPublication(testEnv.DB, projectId, PIECE, NOW);
  }

  it("batches waiting items across accounts into one routine run, after the batch delay", async () => {
    await account("germomics-bluesky");
    await account("foxing-bluesky");
    await recordPublication(testEnv.DB, projectId, PIECE, NOW);
    const world = fakeWorld();
    expect((await processSocial(env, { fetcher: world.fetch, now: NOW })).routineFired).toBe(0); // Still gathering.
    const tick = await processSocial(env, { fetcher: world.fetch, now: later(BATCH_DELAY_MS) });
    expect(tick).toMatchObject({ routineFired: 1, templated: 0 });
    expect(world.fires).toHaveLength(1);
    expect(world.fires[0]!.headers).toMatchObject({ authorization: "Bearer sk-ant-oat01-test", "anthropic-version": "2023-06-01" });
    expect(world.fires[0]!.text).toContain("germomics-bluesky");
    expect(world.fires[0]!.text).toContain("foxing-bluesky");
    expect(world.fires[0]!.text).toContain("Dustin's summary: What the river keeps.");
    expect(world.fires[0]!.text).toContain("do not reply to anyone");
  });

  it("uses the routine's draft when it arrives in time, and no template", async () => {
    await published();
    const world = fakeWorld();
    await processSocial(env, { fetcher: world.fetch, now: later(BATCH_DELAY_MS) });
    await draftSocialPost(testEnv.DB, { accountKey: "germomics-bluesky", projectId, itemId: "post-one", text: `Stromatolites, and what the river keeps. ${PIECE.url}`, createdBy: "routine" });
    const tick = await processSocial(env, { fetcher: world.fetch, now: later(BATCH_DELAY_MS + 60_000) });
    expect(tick).toMatchObject({ sent: 1, templated: 0 });
    expect((await posts()).map((p) => [p.source, p.status])).toEqual([["routine", "sent"]]);
  });

  it("PLANT: no template while the routine still has time, and the template once it has had its time", async () => {
    await published();
    const world = fakeWorld();
    await processSocial(env, { fetcher: world.fetch, now: later(BATCH_DELAY_MS) });
    expect((await processSocial(env, { fetcher: world.fetch, now: later(BATCH_DELAY_MS + ROUTINE_WAIT_MS - 60_000) })).templated).toBe(0);
    expect(await posts()).toEqual([]);
    const tick = await processSocial(env, { fetcher: world.fetch, now: later(BATCH_DELAY_MS + ROUTINE_WAIT_MS + 60_000) });
    expect(tick).toMatchObject({ templated: 1, sent: 1 });
    expect((await posts())[0]).toMatchObject({ source: "template", status: "sent", text: `New: ${PIECE.title}. ${PIECE.summary} ${PIECE.url}` });
  });

  it("PLANT: a routine that refuses the run means the template at once", async () => {
    await published();
    const world = fakeWorld(401);
    const tick = await processSocial(env, { fetcher: world.fetch, now: later(BATCH_DELAY_MS) });
    expect(tick.templated).toBe(1);
    expect(tick.errors.join()).toContain("the routine refused the run (401 authentication_error: no)");
  });

  it("PLANT: the hourly limit is not a failure: the item waits, and the next tick tries again", async () => {
    await published();
    let status = 429;
    const world = fakeWorld(() => status);
    expect(await processSocial(env, { fetcher: world.fetch, now: later(BATCH_DELAY_MS) })).toMatchObject({ templated: 0, routineFired: 0 });
    status = 200;
    expect(await processSocial(env, { fetcher: world.fetch, now: later(BATCH_DELAY_MS + 15 * 60_000) })).toMatchObject({ routineFired: 1, templated: 0 });
    expect(world.fires).toHaveLength(2);
  });

  it("PLANT: with the routine's daily cap reached, the template", async () => {
    for (const hour of [1, 2, 3]) {
      await testEnv.DB.prepare("INSERT INTO social_routine_runs (kind, requested_at, events, status) VALUES ('batch', ?, '[]', 'fired')")
        .bind(`2026-09-27T0${hour}:00:00.000Z`)
        .run();
    }
    await published();
    const world = fakeWorld();
    const tick = await processSocial(env, { fetcher: world.fetch, now: later(BATCH_DELAY_MS) });
    expect(tick.templated).toBe(1);
    expect(world.fires).toEqual([]);
  });

  it("PLANT: with no routine set up, the template", async () => {
    await published();
    const e = { ...env, SOCIAL_ROUTINE_URL: undefined } as Env;
    expect((await processSocial(e, { fetcher: fakeWorld().fetch, now: later(BATCH_DELAY_MS) })).templated).toBe(1);
  });
});

describe("PLANT: the health email when a template post goes out", () => {
  it("emails once when it goes out, stays failing until Dustin marks it seen, then recovers", async () => {
    await account("germomics-bluesky");
    await recordPublication(testEnv.DB, projectId, PIECE, NOW);
    const e = { ...env, SOCIAL_ROUTINE_URL: undefined } as Env;
    await processSocial(e, { fetcher: fakeWorld().fetch, now: later(BATCH_DELAY_MS) });

    const box = mailbox();
    const certs = async () => Response.json({ keys: [{ kid: "k" }] });
    await runHealth({ ...testEnv, EMAIL: box.EMAIL }, certs);
    await runHealth({ ...testEnv, EMAIL: box.EMAIL }, certs);
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]!.text).toContain(`FAIL social-templates: 1 template post went out because the routine did not draft it: germomics-bluesky: "New: ${PIECE.title}.`);

    const [template] = await posts();
    await decidePost(testEnv.DB, await owner(), template!.id, { action: "acknowledge" });
    await runHealth({ ...testEnv, EMAIL: box.EMAIL }, certs);
    expect(box.sent.map((m) => m.subject)).toEqual(["Carrel: 1 check failing", "Carrel: all checks pass"]);
  });
});

describe("switches and caps", () => {
  it("an account that is off when a piece goes live posts nothing, then or later", async () => {
    const id = await account("germomics-bluesky");
    await setSwitches(testEnv.DB, await owner(), id, { enabled: false });
    await recordPublication(testEnv.DB, projectId, PIECE, NOW);
    await setSwitches(testEnv.DB, await owner(), id, { enabled: true });
    const world = fakeWorld();
    expect(await processSocial(env, { fetcher: world.fetch, now: later(BATCH_DELAY_MS) })).toMatchObject({ routineFired: 0, templated: 0, sent: 0 });
    expect(world.sent).toEqual([]);
  });

  it("PLANT: the personal account is never automatic", async () => {
    const o = await owner();
    await createAccount(testEnv.DB, o, { key: "dustin-x", name: "Dustin", platform: "x", kind: "personal", handle: "dustin", projectId });
    const row = await testEnv.DB.prepare("SELECT id FROM social_accounts WHERE key = 'dustin-x'").first<{ id: number }>();
    expect(await setSwitches(testEnv.DB, o, row!.id, { mode: "auto" })).toMatchObject({ ok: false });
    await expect(testEnv.DB.prepare("UPDATE social_accounts SET mode = 'auto' WHERE key = 'dustin-x'").run()).rejects.toThrow(/CHECK constraint/);
  });

  it("keeps to the daily cap and the gap between posts, and posts the rest later", async () => {
    await account("germomics-bluesky");
    const world = fakeWorld();
    for (const n of [1, 2, 3, 4]) {
      await draftSocialPost(testEnv.DB, { accountKey: "germomics-bluesky", projectId, itemId: `post-${n}`, text: `Piece ${n}.`, createdBy: "s" });
      await recordPublication(testEnv.DB, projectId, { ...PIECE, id: `post-${n}` }, NOW);
    }
    expect((await processSocial(env, { fetcher: world.fetch, now: NOW })).sent).toBe(1); // The gap.
    expect((await processSocial(env, { fetcher: world.fetch, now: later(61 * 60_000) })).sent).toBe(1);
    expect((await processSocial(env, { fetcher: world.fetch, now: later(122 * 60_000) })).sent).toBe(1);
    expect((await processSocial(env, { fetcher: world.fetch, now: later(183 * 60_000) })).sent).toBe(0); // The daily cap of 3.
    expect((await processSocial(env, { fetcher: world.fetch, now: new Date("2026-09-28T12:00:00Z") })).sent).toBe(1);
  });

  it("holds an X post that would pass the month's budget, and signs the ones within it", async () => {
    const o = await owner();
    await createAccount(testEnv.DB, o, { key: "dustin-x", name: "Dustin", platform: "x", kind: "personal", handle: "dustin", projectId });
    const row = await testEnv.DB.prepare("SELECT id FROM social_accounts WHERE key = 'dustin-x'").first<{ id: number }>();
    await setSwitches(testEnv.DB, o, row!.id, { enabled: true, monthlyBudgetMills: 250 });
    const world = fakeWorld();
    for (const n of [1, 2]) {
      await draftSocialPost(testEnv.DB, { accountKey: "dustin-x", projectId, itemId: `p${n}`, text: `Piece ${n}: https://site.test/p${n}`, createdBy: "s" });
      await recordPublication(testEnv.DB, projectId, { ...PIECE, id: `p${n}` }, NOW);
    }
    await processSocial(env, { fetcher: world.fetch, now: NOW });
    for (const p of await posts()) await decidePost(testEnv.DB, o, p.id, { action: "approve" });
    await processSocial(env, { fetcher: world.fetch, now: NOW });
    await processSocial(env, { fetcher: world.fetch, now: later(61 * 60_000) });
    const x = world.sent.filter((s) => s.url === "https://api.x.com/2/tweets");
    expect(x).toHaveLength(1); // 20 cents with a link, then a second would pass 25 cents.
    expect(x[0]!.auth).toMatch(/^OAuth oauth_consumer_key="k", oauth_nonce="[0-9a-f]{32}", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d+", oauth_token="t", oauth_version="1.0", oauth_signature="[^"]+"$/);
    expect((await posts()).map((p) => p.error).filter(Boolean)).toEqual(["Held: it would pass this month's X budget ($0.25)."]);
  });
});

describe("the lint", () => {
  it("flags length by each platform's count, a reply in disguise, and the construction", () => {
    expect(lintPost("x".repeat(281), "x")).toEqual(["281 characters, over X's 280."]);
    expect(lintPost(`${"x".repeat(250)} https://example.com/${"a".repeat(80)}`, "x")).toEqual([]); // A link counts as 23.
    expect(lintPost("@someone great point", "bluesky")).toEqual(["It opens with an @handle, which reads as a reply."]);
    expect(lintPost("It's not just a podcast, it's a movement.", "bluesky")).toEqual([`The "not X, it's Y" construction.`]);
    expect(lintPost("New episode on the river's stromatolites.", "bluesky")).toEqual([]);
  });
});

describe("a publish records the event", () => {
  it("records the piece's title, address and summary for its accounts when it goes live through Carrel", async () => {
    await account("germomics-bluesky");
    const site = fakeSite();
    const viewer = await owner();
    const project = await requireSiteProject(testEnv.DB, viewer, "germomics", "publish");
    const saved = await writeToSite(env, project, viewer, "post-one", { action: "save", source: "---\ntitle: Stromatolites\ndescription: What the river keeps.\n---\nBody.\n", expectedVersion: null }, site.fetch);
    if (!saved.ok) throw new Error(saved.message);
    await writeToSite(env, project, viewer, "post-one", { action: "publish", expectedVersion: saved.version }, site.fetch);
    const event = await testEnv.DB.prepare("SELECT title, url, summary, published_at FROM social_events").first<{ title: string; url: string; summary: string; published_at: string }>();
    expect(event).toMatchObject({ title: "Stromatolites", summary: "What the river keeps." });
    expect(event!.published_at).not.toBeNull();
  });
});
