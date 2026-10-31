// The webmention queue, through the content kit and Capsomer's MentionsList. The kit's own rules
// (intents, versions, Undo) are tested in site-api; these are Carrel's: the queue is the Owner's alone
// (Dustin's ruling, 2026-09-26), every decision the site carried out is a row in mention_decisions,
// and the sweep asks first. Planted: an Editor who opens or decides, refused before the site is asked.

import { memoryAdapter } from "@dustinedwards/site-api/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { action as mentionsApi } from "~/routes/mentions.api";
import { loader as mentionsLoader } from "~/routes/mentions";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, refusal, routeContext } from "./site";

const SLUG = "de-info";
let site: ReturnType<typeof fakeSite<ReturnType<typeof memoryAdapter>>>;
let env: Env;
let pending: string;
let old: string;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const id = await addProject(SLUG, "dustinedwards");
  await share(id, editor, "editor");
  site = fakeSite();
  env = connectedEnv();
  vi.stubGlobal("fetch", site.fetch);
  pending = site.adapter.receiveMention({ sourceUrl: "https://a.example/one", targetId: "first-post", authorName: "Ada", authorUrl: null, excerpt: "One.", receivedAt: new Date() });
  old = site.adapter.receiveMention({ sourceUrl: "https://b.example/two", targetId: "first-post", authorName: null, authorUrl: null, excerpt: null, status: "failed", receivedAt: new Date(Date.now() - 200 * 86_400_000) });
});

async function post(email: string, fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const request = new Request(`https://carrel.test/p/${SLUG}/mentions/api`, { method: "POST", body: form });
  return (await mentionsApi({ request, params: { project: SLUG }, context: await routeContext(env, email) } as never)) as Response;
}

const decisions = () => testEnv.DB.prepare("SELECT mention_id AS id, action, status_after AS after FROM mention_decisions ORDER BY rowid").all().then((r) => r.results);
const writes = () => site.requests.filter((r) => !r.startsWith("GET"));

describe("the mentions list", () => {
  it("shows the queue as the list draws it, records a decision with the status it left, and asks before a sweep", async () => {
    const page = await mentionsLoader({ request: new Request(`https://carrel.test/p/${SLUG}/mentions`), params: { project: SLUG }, context: await routeContext(env, "owner@test.invalid") } as never);
    expect(page.data).toMatchObject({ query: { view: "pending" }, rows: [{ id: pending, author: "Ada", host: "a.example", state: "pending" }] });

    const version = site.adapter.mentionStore.get(pending)!.version;
    expect(await (await post("owner@test.invalid", { intent: "approve", ids: pending, version })).json()).toMatchObject({ ok: true });
    expect(await decisions()).toEqual([{ id: pending, action: "approve", after: "approved" }]);

    const asked = (await (await post("owner@test.invalid", { intent: "sweep" })).json()) as { confirm?: { fields: Record<string, string> } };
    expect(asked.confirm).toBeDefined();
    expect(site.adapter.mentionStore.has(old)).toBe(true);
    expect(await (await post("owner@test.invalid", { intent: "sweep", ...asked.confirm!.fields })).json()).toMatchObject({ ok: true });
    expect(site.adapter.mentionStore.has(old)).toBe(false);
    expect((await decisions()).at(-1)).toMatchObject({ id: null, action: "sweep" });
  });

  it("PLANT: refuses an Editor who opens or decides, and the site is never asked", async () => {
    const opened = mentionsLoader({ request: new Request(`https://carrel.test/p/${SLUG}/mentions`), params: { project: SLUG }, context: await routeContext(env, "editor@test.invalid") } as never);
    expect(await refusal(opened)).toBe(403);
    expect((await post("editor@test.invalid", { intent: "approve", ids: pending, version: "m1" })).status).toBe(403);
    expect(writes()).toEqual([]);
    expect(await decisions()).toEqual([]);
  });
});
