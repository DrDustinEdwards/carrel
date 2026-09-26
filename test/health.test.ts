// Planted problems for the health check: one email per change of state, never one per run, and an
// alert that fails to send is retried rather than lost.

import { beforeEach, describe, expect, it } from "vitest";

import { runHealth } from "~/lib/health.server";
import { addPerson, resetDb, testEnv } from "./env";
import { connectedEnv, fakeSite, SITE_ORIGIN } from "./site";

type Sent = { subject: string; text: string; to: string };

function mailbox(fail = false) {
  const sent: Sent[] = [];
  const EMAIL = {
    async send(message: Sent) {
      if (fail) throw new Error("send failed");
      sent.push(message);
      return { messageId: `m${sent.length}` };
    },
  } as unknown as SendEmail;
  return { sent, EMAIL };
}

const certsOk = async () => Response.json({ keys: [{ kid: "k" }] });
const certsDown = async () => new Response("down", { status: 503 });

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
});

describe("health", () => {
  it("sends nothing on a first run where every check passes", async () => {
    const box = mailbox();
    const { results, emailed } = await runHealth({ ...testEnv, EMAIL: box.EMAIL }, certsOk);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(emailed).toBe(false);
    expect(box.sent).toHaveLength(0);
  });

  it("sends one email when a check starts failing, and none while it stays failing", async () => {
    const box = mailbox();
    const env = { ...testEnv, EMAIL: box.EMAIL };
    await runHealth(env, certsOk);
    await runHealth(env, certsDown);
    await runHealth(env, certsDown);
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]!.subject).toBe("Carrel: 1 check failing");
    expect(box.sent[0]!.text).toContain("FAIL access-keys");
    expect(box.sent[0]!.to).toBe("owner@test.invalid");
  });

  it("sends one email on recovery", async () => {
    const box = mailbox();
    const env = { ...testEnv, EMAIL: box.EMAIL };
    await runHealth(env, certsDown);
    await runHealth(env, certsOk);
    expect(box.sent.map((m) => m.subject)).toEqual(["Carrel: 1 check failing", "Carrel: all checks pass"]);
  });

  it("flags a database with no Owner", async () => {
    await resetDb();
    const box = mailbox();
    await runHealth({ ...testEnv, EMAIL: box.EMAIL }, certsOk);
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]!.text).toContain("FAIL owner");
  });

  it("flags a missing ACCESS_AUD and a placeholder alert address", async () => {
    const box = mailbox();
    await runHealth({ ...testEnv, ACCESS_AUD: "", ALERT_EMAIL: "alerts@example.com", EMAIL: box.EMAIL }, certsOk);
    expect(box.sent[0]!.text).toMatch(/FAIL config: Missing or placeholder: ACCESS_AUD, ALERT_EMAIL/);
  });

  it("keeps the alert pending when the email fails, and sends it on the next run", async () => {
    const failing = mailbox(true);
    const first = await runHealth({ ...testEnv, EMAIL: failing.EMAIL }, certsDown);
    expect(first.emailed).toBe(false);

    const working = mailbox();
    const second = await runHealth({ ...testEnv, EMAIL: working.EMAIL }, certsDown);
    expect(second.emailed).toBe(true);
    expect(working.sent).toHaveLength(1);
  });
});

// Stage 2: each site's key and its conformance to the site-api contract (design section 7, "Health":
// a changed schema hash sends one email).
describe("site health", () => {
  function through(site: ReturnType<typeof fakeSite>, drift = false) {
    return async (url: string, init?: RequestInit) => {
      if (!url.startsWith(SITE_ORIGIN)) return certsOk();
      const response = await site.fetch(url, init);
      if (!drift || !url.endsWith("/meta") || !response.ok) return response;
      const meta = (await response.json()) as Record<string, unknown>;
      return Response.json({ ...meta, schemaHash: "f".repeat(64), packageVersion: "0.2.0" });
    };
  }

  it("counts a site with no key as not connected, which is not a failure", async () => {
    const { results } = await runHealth({ ...testEnv, EMAIL: mailbox().EMAIL }, certsOk);
    expect(results.find((r) => r.name === "site-dustinedwards")).toEqual({
      name: "site-dustinedwards",
      ok: true,
      detail: "Not connected: No SITE_DUSTINEDWARDS_KEY set.",
    });
  });

  it("PLANT: flags a key too short to be the site's", async () => {
    const box = mailbox();
    await runHealth({ ...connectedEnv({ SITE_DUSTINEDWARDS_KEY: "short" }), EMAIL: box.EMAIL }, certsOk);
    expect(box.sent[0]!.text).toMatch(/FAIL site-dustinedwards: SITE_DUSTINEDWARDS_KEY is shorter than 32/);
  });

  it("passes a conforming site, and its write probe changes nothing there", async () => {
    const site = fakeSite();
    const box = mailbox();
    const { results } = await runHealth({ ...connectedEnv(), EMAIL: box.EMAIL }, through(site));
    expect(results.find((r) => r.name === "site-dustinedwards")?.ok).toBe(true);
    expect(box.sent).toHaveLength(0);
    expect(site.adapter.store.size).toBe(0);
  });

  it("PLANT: a changed schema hash sends one email, and none while it stays changed", async () => {
    const site = fakeSite();
    const box = mailbox();
    const env = { ...connectedEnv(), EMAIL: box.EMAIL };
    await runHealth(env, through(site));
    await runHealth(env, through(site, true));
    await runHealth(env, through(site, true));
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]!.text).toMatch(/FAIL site-dustinedwards: dustinedwards\.info does not conform\. meta: answers with this contract's schema hash: schema hash ffffffffffff/);
  });

  it("PLANT: flags a site that holds a different key", async () => {
    const site = fakeSite();
    const box = mailbox();
    await runHealth({ ...connectedEnv({ SITE_DUSTINEDWARDS_KEY: "another-key-of-the-right-length-0123456789" }), EMAIL: box.EMAIL }, through(site));
    expect(box.sent[0]!.text).toContain("FAIL site-dustinedwards");
  });
});
