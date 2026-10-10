// The report Carrel sends to Capsid's inbox: the body for no, one and many AI drafts, and the
// failure path, which is logged and never thrown.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { inboxReport, reportInbox } from "~/lib/inbox-report.server";
import { addPerson, addProject, resetDb, testEnv } from "./env";

const ORIGIN = "https://carrel.dustinedwards.info";
let projectId: number;
let personId: number;

async function addDraft(at: string) {
  await testEnv.DB.prepare(
    "INSERT INTO ai_drafts (project_id, item_id, person_id, client, source, created_at) VALUES (?, 'a', ?, 'claude', 'x', ?)",
  )
    .bind(projectId, personId, at)
    .run();
}

function capture(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const env = { ...testEnv, CAPSID_AGENT_KEY: "key-1", CARREL_ORIGIN: ORIGIN } as Env;

beforeEach(async () => {
  await resetDb();
  personId = await addPerson("owner@test.invalid", { owner: true });
  projectId = await addProject("de-info", "dustinedwards");
});

describe("inboxReport body", () => {
  it("sends no items for 0 drafts", () => {
    expect(inboxReport(0, null, ORIGIN)).toEqual({ namespace: "carrel", items: [] });
  });
  it("names one draft in the singular, with the oldest as since", () => {
    expect(inboxReport(1, "2026-10-01T00:00:00Z", ORIGIN)).toEqual({
      namespace: "carrel",
      items: [{ title: "1 AI draft waits for review", link: `${ORIGIN}/`, since: "2026-10-01T00:00:00Z" }],
    });
  });
  it("names many drafts in the plural", () => {
    expect(inboxReport(4, null, ORIGIN).items[0]!.title).toBe("4 AI drafts wait for review");
  });
});

describe("reportInbox", () => {
  it("posts the count and the oldest draft's time with the bearer key", async () => {
    await addDraft("2026-10-03T00:00:00Z");
    await addDraft("2026-10-01T00:00:00Z");
    const { calls, fetcher } = capture();
    expect(await reportInbox(env, fetcher)).toMatchObject({ state: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://mcp.dustinedwards.info/ops/inbox/report");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer key-1");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      namespace: "carrel",
      items: [{ title: "2 AI drafts wait for review", link: `${ORIGIN}/`, since: "2026-10-01T00:00:00Z" }],
    });
  });

  it("sends an empty list when nothing waits, to clear the badge", async () => {
    const { calls, fetcher } = capture();
    await reportInbox(env, fetcher);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ namespace: "carrel", items: [] });
  });

  it("sends nothing while the key is not set", async () => {
    const { calls, fetcher } = capture();
    expect(await reportInbox({ ...env, CAPSID_AGENT_KEY: undefined } as Env, fetcher)).toMatchObject({ state: "skipped" });
    expect(calls).toHaveLength(0);
  });

  it("logs and returns a refusal rather than swallowing or throwing it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetcher } = capture(429);
    expect(await reportInbox(env, fetcher)).toEqual({ state: "failed", detail: "Capsid answered 429" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("report-failed"));
    log.mockRestore();
  });

  it("logs and returns a network failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await reportInbox(env, down)).toEqual({ state: "failed", detail: "offline" });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
