// The Cloudflare Access sync: the allow list Carrel posts to Capsid, a refusal recorded and shown on
// the People page, nothing sent while the key is not set, and sharing one project from its page.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { syncAccess } from "~/lib/access-sync.server";
import { setProjectRole, shareFromForm } from "~/lib/people-admin.server";
import { loader as peopleLoader } from "~/routes/people";

import { addBook, addPerson, addProject, resetDb, share, testEnv } from "./env";
import { routeContext, viewerFor } from "./site";

const env = { ...testEnv, CAPSID_AGENT_KEY: "key-1" } as Env;
let projectId: number;
let bookId: number;
let wifeId: number;

function capture(status = 200, body: unknown = { ok: true, added: [], dropped: [] }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetcher, sent: () => JSON.parse(calls.at(-1)!.init.body as string) };
}

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  wifeId = await addPerson("wife@test.invalid");
  const coauthor = await addPerson("Coauthor@Test.Invalid");
  const reviewer = await addPerson("reviewer@test.invalid", { reviewer: true });
  const agent = await addPerson("agent:grok");
  const gone = await addPerson("gone@test.invalid", { disabled: true });
  await addPerson("norole@test.invalid");
  projectId = await addProject("de-info", "dustinedwards");
  bookId = await addBook("novel");
  await share(projectId, wifeId, "editor");
  await share(bookId, coauthor, "reader");
  await share(projectId, reviewer, "reader");
  await share(projectId, agent, "editor");
  await share(projectId, gone, "reader");
});

describe("syncAccess", () => {
  it("posts only active people with a role, never the Owner, a reviewer or an agent, with the bearer key", async () => {
    const { calls, fetcher, sent } = capture();
    expect(await syncAccess(env, { removed: [] }, fetcher)).toMatchObject({ state: "in-step" });
    expect(calls[0]!.url).toBe("https://mcp.dustinedwards.info/ops/access-sync");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer key-1");
    expect(sent()).toEqual({ namespace: "carrel", members: ["coauthor@test.invalid", "wife@test.invalid"], removed: [] });
  });

  it("sends someone whose last role was removed as removed, and keeps anyone still on the list out of removed", async () => {
    const owner = await viewerFor("owner@test.invalid");
    const { fetcher, sent } = capture();
    await syncAccess(env, await setProjectRole(testEnv.DB, owner, wifeId, projectId, null), fetcher);
    expect(sent()).toEqual({ namespace: "carrel", members: ["coauthor@test.invalid"], removed: ["wife@test.invalid"] });
    await syncAccess(env, { removed: ["coauthor@test.invalid"] }, fetcher);
    expect(sent().removed).toEqual([]);
  });

  it("records Capsid's refusal, and the People page shows it until a sync succeeds", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = capture(502, { ok: false, refusal: "the group write was refused, so the group still holds its old list", added: [], dropped: [] });
    expect(await syncAccess(env, { removed: [] }, refused.fetcher)).toEqual({ state: "waiting", detail: "the group write was refused, so the group still holds its old list" });
    const page = async () => (await peopleLoader({ context: await routeContext(env, "owner@test.invalid"), params: {}, request: new Request("https://carrel.test/people") } as never)).access;
    expect(await page()).toMatchObject({ configured: true, last: { ok: false, refusal: "the group write was refused, so the group still holds its old list" } });

    // A refusal before Cloudflare is plain words, not a SyncResult.
    await syncAccess(env, { removed: [] }, capture(403, "unauthorized: agent:carrel is not scoped to the '/ops/access-sync' tool.").fetcher);
    expect(await page()).toMatchObject({ last: { ok: false, refusal: "Capsid answered 403: unauthorized: agent:carrel is not scoped to the '/ops/access-sync' tool." } });

    await syncAccess(env, { removed: [] }, capture(200, { ok: true, added: ["wife@test.invalid"], dropped: [] }).fetcher);
    expect(await page()).toMatchObject({ last: { ok: true, refusal: null, added: 1, dropped: 0 } });
    log.mockRestore();
  });

  it("sends nothing and records nothing while the key is not set", async () => {
    const { calls, fetcher } = capture();
    const unset = { ...env, CAPSID_AGENT_KEY: undefined } as Env;
    expect(await syncAccess(unset, { removed: [] }, fetcher)).toMatchObject({ state: "skipped" });
    expect(calls).toHaveLength(0);
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM access_sync").first()).toEqual({ n: 0 });
  });
});

describe("the Share panel", () => {
  const form = (fields: Record<string, string>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    return body;
  };
  const roles = (email: string) =>
    testEnv.DB.prepare("SELECT m.project_id, m.role FROM project_members m JOIN people p ON p.id = m.person_id WHERE p.email = ? ORDER BY m.project_id").bind(email).all();

  it("adds a new coauthor onto this project only, gives an existing person the role, and leaves no one behind on a refusal", async () => {
    const owner = await viewerFor("owner@test.invalid");
    expect(await shareFromForm(testEnv, owner, bookId, form({ email: " New@Test.Invalid ", name: "New", role: "reader" }))).toMatchObject({ ok: true, email: "new@test.invalid", added: true, access: { state: "skipped" } });
    expect((await roles("new@test.invalid")).results).toEqual([{ project_id: bookId, role: "reader" }]);

    expect(await shareFromForm(testEnv, owner, bookId, form({ email: "wife@test.invalid", name: "Ignored", role: "editor" }))).toMatchObject({ ok: true, added: false });
    expect((await roles("wife@test.invalid")).results).toEqual([{ project_id: projectId, role: "editor" }, { project_id: bookId, role: "editor" }]);

    expect(await shareFromForm(testEnv, owner, bookId, form({ email: "late@test.invalid", name: "", role: "author" }))).toMatchObject({ ok: false, message: expect.stringMatching(/book/) });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM people WHERE email = 'late@test.invalid'").first()).toEqual({ n: 0 });
  });
});
