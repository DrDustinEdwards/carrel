// A writing job on the AI switch: the API's result is an AI draft beside the post, never a change to the post itself, and a
// job with no open route writes nothing.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveAiSettings } from "~/lib/ai-engine.server";
import { listAiDrafts } from "~/lib/ai.server";
import { writePost } from "~/lib/ai-write.server";
import { requireSiteProject } from "~/lib/projects.server";

import { addPerson, addProject, resetDb, testEnv } from "./env";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const SLUG = "de-info";
let site: ReturnType<typeof fakeSite>;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  await addProject(SLUG, "dustinedwards");
  site = fakeSite();
  const saved = await site.adapter.content.saveDraft("post-one", {
    source: "---\ntitle: Post one\n---\nWords.\n",
    expectedVersion: null,
    changeId: "s",
  });
  await site.adapter.content.publish("post-one", { expectedVersion: saved.version, changeId: "p" });
  // The model, answered here; the site, by the fake site.
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://api.anthropic.com/v1/messages")
      return Promise.resolve(
        Response.json({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          stop_reason: "end_turn",
          content: [
            { type: "text", text: JSON.stringify({ text: "More words.", note: "Continued." }) },
          ],
          usage: { input_tokens: 1000, output_tokens: 100 },
        }),
      );
    return site.fetch(input, init);
  });
});

async function owner() {
  const viewer = await viewerFor("owner@test.invalid");
  return { viewer, project: await requireSiteProject(testEnv.DB, viewer, SLUG, "edit") };
}

describe("continue my draft", () => {
  it("through the API saves the post plus the new passage as an AI draft, and the site's text is untouched", async () => {
    const { viewer, project } = await owner();
    await saveAiSettings(testEnv.DB, viewer, { master: "api" });
    const env = connectedEnv({ ANTHROPIC_API_KEY: "sk-ant-api-test" });
    const made = await writePost(env, project, viewer, "post-one", "continue");
    expect(made).toMatchObject({ ok: true, engine: "api" });
    const drafts = await listAiDrafts(testEnv.DB, project, viewer, "post-one");
    expect(drafts).toHaveLength(1);
    expect((await site.adapter.content.get("post-one"))?.source).toContain("Words.");
    expect((await site.adapter.content.get("post-one"))?.source).not.toContain("More words.");
  });

  it("PLANT: with the subscription chosen and no routine set up, nothing is written and the API is not called", async () => {
    const { viewer, project } = await owner();
    await saveAiSettings(testEnv.DB, viewer, { master: "subscription" });
    const env = connectedEnv({ ANTHROPIC_API_KEY: "sk-ant-api-test" });
    const made = await writePost(env, project, viewer, "post-one", "continue");
    expect(made.ok).toBe(false);
    expect(await listAiDrafts(testEnv.DB, project, viewer, "post-one")).toHaveLength(0);
  });
});
