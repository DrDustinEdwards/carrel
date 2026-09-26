// Planted problems for the health check: one email per change of state, never one per run, and an
// alert that fails to send is retried rather than lost.

import { beforeEach, describe, expect, it } from "vitest";

import { runHealth } from "~/lib/health.server";
import { addPerson, resetDb, testEnv } from "./env";

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
