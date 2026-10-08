// The webmention queue (site-api v0.5.0 mentions group): the Owner's alone to read and to decide, each
// mention its own write with its own authorship row, one failing never stopping the rest, and every
// refusal (a role, a stale version, a missing mention, a site with no mentions) leaving the site and the
// record as they were. Planted refusals assert the site was never asked.

import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "@dustinedwards/site-api/testing";

import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { decideMentions, listMentions, MAX_MENTION_BATCH, mentionsOffered, parseTargets, sweepMentions } from "~/lib/mentions.server";
import { requireSiteProject } from "~/lib/projects.server";
import { action as mentionsApi } from "~/routes/mentions.api";
import { loader as mentionsLoader } from "~/routes/mentions";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const SLUG = "de-info";
type Site = ReturnType<typeof fakeSite<ReturnType<typeof memoryAdapter>>>;
let site: Site;
let env: Env;
let ids: { pending: string; second: string; approved: string; failed: string; unverified: string; oldFailed: string; oldRejected: string };

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const reader = await addPerson("reader@test.invalid");
  const projectId = await addProject(SLUG, "dustinedwards");
  await share(projectId, editor, "editor");
  await share(projectId, reader, "reader");
  start(fakeSite());
});

function start(next: Site) {
  site = next;
  vi.stubGlobal("fetch", site.fetch);
  env = connectedEnv();
  const ago = (days: number) => new Date(Date.now() - days * DAY);
  const send = (fields: Parameters<Site["adapter"]["receiveMention"]>[0]) => site.adapter.receiveMention(fields);
  ids = {
    pending: send({ sourceUrl: "https://a.example/one", targetId: "first-post", authorName: "Ada", excerpt: "One.", receivedAt: ago(1) }),
    second: send({ sourceUrl: "https://b.example/two", targetId: "first-post", authorName: "Bo", excerpt: "Two.", receivedAt: ago(2) }),
    approved: send({ sourceUrl: "https://c.example/three", targetId: "second-post", status: "approved", receivedAt: ago(3) }),
    failed: send({ sourceUrl: "https://d.example/four", targetId: "first-post", status: "failed", receivedAt: ago(4) }),
    unverified: send({ sourceUrl: "https://e.example/five", targetId: "first-post", status: "unverified", receivedAt: ago(0) }),
    oldFailed: send({ sourceUrl: "https://f.example/six", targetId: "first-post", status: "failed", receivedAt: ago(60) }),
    oldRejected: send({ sourceUrl: "https://g.example/seven", targetId: "second-post", status: "rejected", receivedAt: ago(200) }),
  };
}

async function as(email: string, action: "read_mentions" | "decide_mention" | "read" = "read_mentions") {
  const viewer = await viewerFor(email);
  return { viewer, project: await requireSiteProject(testEnv.DB, viewer, SLUG, action) };
}

/** The version the page would have shown for a mention. */
const versionOf = (id: string) => site.adapter.mentionStore.get(id)!.version;
const target = (id: string) => ({ id, version: versionOf(id), status: site.adapter.mentionStore.get(id)!.status });
const decisions = async () =>
  (
    await testEnv.DB.prepare(
      "SELECT mention_id AS mentionId, action, status_before AS before, status_after AS after, change_id AS changeId, person_id AS who, client FROM mention_decisions ORDER BY id",
    ).all<{ mentionId: string | null; action: string; before: string | null; after: string | null; changeId: string; who: number; client: string | null }>()
  ).results;
const writes = () => site.requests.filter((r) => !r.startsWith("GET"));

async function refusal(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
  return 200;
}

describe("roles: the queue is the Owner's alone (carrel/design.md: the inbox belongs to Dustin alone)", () => {
  it("PLANT: refuses an Editor and a Reader who open the queue, and the site is never asked", async () => {
    for (const email of ["editor@test.invalid", "reader@test.invalid"]) {
      expect(await refusal(as(email))).toBe(403);
    }
    expect(site.requests).toEqual([]);
  });

  it("PLANT: refuses an Editor and a Reader who decide, delete or sweep, and nothing on the site or in the record moves", async () => {
    const before = structuredClone([...site.adapter.mentionStore.values()]);
    for (const email of ["editor@test.invalid", "reader@test.invalid"]) {
      const viewer = await viewerFor(email);
      const project = await requireSiteProject(testEnv.DB, viewer, SLUG, "read");
      for (const op of ["approve", "reject", "delete"] as const) {
        expect(await refusal(decideMentions(env, project, { viewer }, op, [target(ids.pending)], site.fetch)), `${email} ${op}`).toBe(403);
      }
      expect(await refusal(sweepMentions(env, project, { viewer }, site.fetch)), `${email} sweep`).toBe(403);
      expect(await refusal(listMentions(env, project, {}, site.fetch)), `${email} list`).toBe(403);
      expect(await refusal(mentionsOffered(env, project, site.fetch)), `${email} offered`).toBe(403);
    }
    expect(site.requests).toEqual([]);
    expect([...site.adapter.mentionStore.values()]).toEqual(before);
    expect(await decisions()).toEqual([]);
  });

  it("PLANT: the screen's loader and the write endpoint refuse an Editor before the site is asked", async () => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
    context.set(viewerContext, await viewerFor("editor@test.invalid"));
    context.set(nonceContext, "n");
    expect(await refusal(Promise.resolve(mentionsLoader({ request: new Request(`https://carrel.test/p/${SLUG}/mentions`), params: { project: SLUG }, context } as never)))).toBe(403);
    const body = new FormData();
    body.set("op", "delete");
    body.set("items", JSON.stringify([target(ids.pending)]));
    const response = (await mentionsApi({ request: new Request(`https://carrel.test/p/${SLUG}/mentions/api`, { method: "POST", body }), params: { project: SLUG }, context } as never)) as Response;
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Deciding mentions is the Owner's step." });
    expect(site.requests).toEqual([]);
    expect(site.adapter.mentionStore.has(ids.pending)).toBe(true);
  });

  it("answers 404, not 403, for a person with no role on the project", async () => {
    await addPerson("outsider@test.invalid");
    expect(await refusal(as("outsider@test.invalid"))).toBe(404);
  });
});

describe("reading the queue", () => {
  it("opens on Pending, with the counts of the whole queue and what a sweep would remove", async () => {
    const { project } = await as("owner@test.invalid");
    const { filter, list } = await listMentions(env, project, {}, site.fetch);
    expect(filter).toBe("pending");
    expect(list.items.map((m) => m.id).sort()).toEqual([ids.pending, ids.second].sort());
    expect(list.counts).toEqual({ unverified: 1, pending: 2, approved: 1, rejected: 1, failed: 2 });
    expect(list.expiring).toEqual({ failed: 1, rejected: 1 });
  });

  it("opens on All when nothing is pending, and filters when asked", async () => {
    const { project } = await as("owner@test.invalid");
    await decideMentions(env, project, { viewer: (await as("owner@test.invalid")).viewer }, "reject", [target(ids.pending), target(ids.second)], site.fetch);
    const opened = await listMentions(env, project, {}, site.fetch);
    expect(opened.filter).toBe("all");
    expect(opened.list.items).toHaveLength(7);
    const failed = await listMentions(env, project, { filter: "failed" }, site.fetch);
    expect(failed.list.items.map((m) => m.status)).toEqual(["failed", "failed"]);
  });

  it("says why when the site does not receive mentions through Carrel", async () => {
    start(fakeSite(memoryAdapter({ mentions: false })));
    const { project } = await as("owner@test.invalid");
    expect(await mentionsOffered(env, project, site.fetch)).toEqual({ offered: false, reason: "This site does not receive webmentions through Carrel yet." });
  });

  it("says why when the site has no key", async () => {
    const { project } = await as("owner@test.invalid");
    const answer = await mentionsOffered({ ...testEnv }, project, site.fetch);
    expect(answer).toMatchObject({ offered: false });
  });
});

describe("deciding", () => {
  it("approves at the version the person saw, purges through the site, and writes one authorship row with the site's change id", async () => {
    const { viewer, project } = await as("owner@test.invalid", "decide_mention");
    const decide = vi.spyOn(site.adapter.mentions!, "decide");
    const results = await decideMentions(env, project, { viewer }, "approve", [target(ids.pending)], site.fetch);
    expect(results).toEqual([{ id: ids.pending, ok: true, message: "Approved." }]);
    expect(site.adapter.mentionStore.get(ids.pending)!.status).toBe("approved");
    expect(site.adapter.purged).toEqual(["first-post"]);
    const log = await decisions();
    expect(log).toEqual([{ mentionId: ids.pending, action: "approve", before: "pending", after: "approved", changeId: decide.mock.calls[0]![1].changeId, who: viewer.id, client: null }]);
  });

  it("credits the AI client in the record when one decides", async () => {
    const { viewer, project } = await as("owner@test.invalid", "decide_mention");
    await decideMentions(env, project, { viewer, client: "Claude" }, "reject", [target(ids.pending)], site.fetch);
    expect((await decisions())[0]).toMatchObject({ action: "reject", after: "rejected", client: "Claude" });
  });

  it("deletes, with no status after, and records it", async () => {
    const { viewer, project } = await as("owner@test.invalid", "decide_mention");
    const results = await decideMentions(env, project, { viewer }, "delete", [target(ids.failed)], site.fetch);
    expect(results).toEqual([{ id: ids.failed, ok: true, message: "Deleted." }]);
    expect(site.adapter.mentionStore.has(ids.failed)).toBe(false);
    expect(await decisions()).toMatchObject([{ mentionId: ids.failed, action: "delete", before: "failed", after: null }]);
  });

  it("PLANT: refuses a stale version for that mention alone, writes no row for it, and decides the rest", async () => {
    const { viewer, project } = await as("owner@test.invalid", "decide_mention");
    const seen = [target(ids.pending), target(ids.second)];
    // Another door decides the first one after the page loaded.
    await decideMentions(env, project, { viewer }, "reject", [target(ids.pending)], site.fetch);
    const results = await decideMentions(env, project, { viewer }, "approve", seen, site.fetch);
    expect(results[0]).toMatchObject({ id: ids.pending, ok: false });
    expect(results[0]!.message).toMatch(/changed on the site since the page loaded/);
    expect(results[1]).toMatchObject({ id: ids.second, ok: true });
    expect(site.adapter.mentionStore.get(ids.pending)!.status).toBe("rejected");
    expect(site.adapter.mentionStore.get(ids.second)!.status).toBe("approved");
    expect((await decisions()).map((r) => [r.mentionId, r.action])).toEqual([[ids.pending, "reject"], [ids.second, "approve"]]);
  });

  it("PLANT: one missing, one the site refuses and one fine: each has its own outcome and the fine one lands", async () => {
    const { viewer, project } = await as("owner@test.invalid", "decide_mention");
    const gone = target(ids.second);
    site.adapter.mentionStore.delete(ids.second);
    const results = await decideMentions(env, project, { viewer }, "approve", [gone, target(ids.unverified), target(ids.pending)], site.fetch);
    expect(results.map((r) => [r.id, r.ok])).toEqual([[ids.second, false], [ids.unverified, false], [ids.pending, true]]);
    expect(results[0]!.message).toMatch(/no longer has this mention/);
    expect(results[1]!.message).toMatch(/cannot be decided/);
    expect(site.adapter.mentionStore.get(ids.unverified)!.status).toBe("unverified");
    expect(await decisions()).toHaveLength(1);
  });

  it("reports a site error for one mention without stopping the next, and writes no row for it", async () => {
    const { viewer, project } = await as("owner@test.invalid", "decide_mention");
    const real = site.adapter.mentions!.decide;
    let calls = 0;
    site.adapter.mentions!.decide = async (id, input) => {
      if (++calls === 1) throw new Error("database is locked");
      return real(id, input);
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const results = await decideMentions(env, project, { viewer }, "approve", [target(ids.pending), target(ids.second)], site.fetch);
    quiet.mockRestore();
    expect(results[0]).toMatchObject({ ok: false, message: "The site did not accept this change. The mention was left as it was." });
    expect(results[1]).toMatchObject({ ok: true });
    expect(await decisions()).toHaveLength(1);
  });

  it("says when the site could not clear its cache, since the decision still stands", async () => {
    const { viewer, project } = await as("owner@test.invalid", "decide_mention");
    const real = site.adapter.mentions!.decide;
    site.adapter.mentions!.decide = async (id, input) => ({ ...(await real(id, input)), purged: false });
    const [result] = await decideMentions(env, project, { viewer }, "approve", [target(ids.pending)], site.fetch);
    expect(result).toMatchObject({ ok: true });
    expect(result!.message).toMatch(/could not clear its cache/);
    expect(await decisions()).toHaveLength(1);
  });

  it("PLANT: answers a site with no mentions in plain words, writes nothing and records nothing", async () => {
    start(fakeSite(memoryAdapter({ mentions: false })));
    const { viewer, project } = await as("owner@test.invalid", "decide_mention");
    const results = await decideMentions(env, project, { viewer }, "approve", [{ id: "1", version: "m1", status: "pending" }], site.fetch);
    expect(results).toEqual([{ id: "1", ok: false, message: "The site does not moderate mentions through Carrel yet." }]);
    expect(await decisions()).toEqual([]);
  });

  it("says the decision happened when only the record failed", async () => {
    const { viewer, project } = await as("owner@test.invalid", "decide_mention");
    // A person the database does not hold cannot be recorded (the person_id foreign key), after the site has written.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const [result] = await decideMentions(env, project, { viewer: { ...viewer, id: 99_999 } }, "reject", [target(ids.pending)], site.fetch);
    quiet.mockRestore();
    expect(result!.ok).toBe(true);
    expect(result!.message).toMatch(/could not save the record/);
    expect(site.adapter.mentionStore.get(ids.pending)!.status).toBe("rejected");
    expect(await decisions()).toEqual([]);
  });

  it("refuses an empty choice, and too many, before the site is asked", async () => {
    const { viewer, project } = await as("owner@test.invalid", "decide_mention");
    expect(await refusal(decideMentions(env, project, { viewer }, "approve", [], site.fetch))).toBe(400);
    const many = Array.from({ length: MAX_MENTION_BATCH + 1 }, (_, i) => ({ id: String(i + 1), version: "m1", status: "pending" }));
    expect(await refusal(decideMentions(env, project, { viewer }, "approve", many, site.fetch))).toBe(400);
    expect(site.requests).toEqual([]);
  });

  it("does not send an id or a version a site could not hold", () => {
    const parsed = parseTargets([
      { id: "12", version: "m1", status: "pending" },
      { id: "12", version: "m1", status: "pending" },
      { id: "../x", version: "m1", status: "pending" },
      { id: "13", version: "", status: "pending" },
      { id: "14", version: "m1", status: "bogus" },
      "nonsense",
    ]);
    expect(parsed.targets).toEqual([{ id: "12", version: "m1", status: "pending" }]);
    expect(parsed.invalid).toEqual(["../x", "13", "14", "(no id)"]);
  });
});

describe("sweeping", () => {
  it("removes what the site says is expired, keeps the rest, and records one row with no mention id", async () => {
    const { viewer, project } = await as("owner@test.invalid", "decide_mention");
    const result = await sweepMentions(env, project, { viewer }, site.fetch);
    expect(result).toMatchObject({ ok: true, removed: { failed: 1, rejected: 1 }, recorded: true });
    expect(site.adapter.mentionStore.has(ids.oldFailed)).toBe(false);
    expect(site.adapter.mentionStore.has(ids.oldRejected)).toBe(false);
    expect(site.adapter.mentionStore.has(ids.failed)).toBe(true);
    expect(site.adapter.mentionStore.has(ids.pending)).toBe(true);
    expect(await decisions()).toMatchObject([{ mentionId: null, action: "sweep", before: null, after: null, who: viewer.id }]);
  });

  it("PLANT: a site with no mentions answers in plain words, and nothing is recorded", async () => {
    start(fakeSite(memoryAdapter({ mentions: false })));
    const { viewer, project } = await as("owner@test.invalid", "decide_mention");
    expect(await sweepMentions(env, project, { viewer }, site.fetch)).toEqual({ ok: false, message: "The site does not moderate mentions through Carrel yet." });
    expect(await decisions()).toEqual([]);
  });

  it("goes through the endpoint for the Owner as JSON", async () => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
    context.set(viewerContext, await viewerFor("owner@test.invalid"));
    context.set(nonceContext, "n");
    const body = new FormData();
    body.set("op", "sweep");
    const response = (await mentionsApi({ request: new Request(`https://carrel.test/p/${SLUG}/mentions/api`, { method: "POST", body }), params: { project: SLUG }, context } as never)) as Response;
    expect(response.status).toBe(200);
    expect(((await response.json()) as { sweep: unknown }).sweep).toMatchObject({ ok: true, removed: { failed: 1, rejected: 1 } });
    expect(writes()).toEqual(["POST /api/carrel/v1/mentions/sweep"]);
  });
});

describe("the migration", () => {
  it("PLANT: refuses a record that names no mention for anything but a sweep, and a status after a delete", async () => {
    const { viewer, project } = await as("owner@test.invalid", "decide_mention");
    const insert = (mention: string | null, action: string, after: string | null) =>
      testEnv.DB.prepare("INSERT INTO mention_decisions (project_id, mention_id, person_id, action, status_after, change_id) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(project.id, mention, viewer.id, action, after, crypto.randomUUID())
        .run();
    await expect(insert(null, "approve", "approved")).rejects.toThrow();
    await expect(insert("1", "approve", null)).rejects.toThrow();
    await expect(insert("1", "approve", "spam")).rejects.toThrow();
    await expect(insert("1", "launch", "approved")).rejects.toThrow();
    await insert(null, "sweep", null);
    await insert("1", "delete", null);
    expect((await decisions()).map((r) => r.action)).toEqual(["sweep", "delete"]);
  });
});
