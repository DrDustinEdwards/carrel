// The voice pack, as a session and the author meet it: a brief built from the published posts, the
// checks an AI draft comes back with, and the words the author keeps cutting offered for the list. The
// checks themselves are site-runtime ./prose's, tested there; these hold Carrel's part.

import { beforeEach, describe, expect, it } from "vitest";

import { writeToSite } from "~/lib/content.server";
import { requireSiteProject } from "~/lib/projects.server";
import { cutSuggestions, decideCut, readVoicePack, type VoiceBrief } from "~/lib/voice.server";

import { BASELINE, PLANT } from "./fixtures/voice";
import { addPerson, addProject, resetDb, testEnv } from "./env";
import { connectAs } from "./mcp-client";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const SLUG = "de-info";

let site: ReturnType<typeof fakeSite>;
let env: Env;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  await addProject(SLUG, "dustinedwards");
  site = fakeSite();
  env = connectedEnv();
});

async function owner() {
  const viewer = await viewerFor("owner@test.invalid");
  return { viewer, project: await requireSiteProject(testEnv.DB, viewer, SLUG, "publish") };
}

/** The author's own publish through the editor's path: save, then publish. */
async function publish(id: string, body: string) {
  const { viewer, project } = await owner();
  const current = await site.adapter.content.get(id).catch(() => null);
  const saved = await writeToSite(env, project, viewer, id, { action: "save", source: `---\ntitle: ${id}\n---\n${body}\n`, expectedVersion: current?.version ?? null }, site.fetch);
  if (!saved.ok) throw new Error(saved.message);
  const published = await writeToSite(env, project, viewer, id, { action: "publish", expectedVersion: saved.version }, site.fetch);
  if (!published.ok) throw new Error(published.message);
}

describe("the brief and the checks", () => {
  it("builds the brief from the published posts, and a saved draft comes back with its checks", async () => {
    for (const [i, body] of BASELINE.entries()) await publish(`post-${i}`, body);
    const ai = await connectAs("owner@test.invalid", "Claude", { env, deps: { fetcher: site.fetch } });

    const brief = (await ai.call("carrel_voice_brief", { project: SLUG })).structuredContent as VoiceBrief & { notice: string };
    expect(brief.posts).toBe(BASELINE.length);
    expect(brief.measures[0]).toMatch(/^Sentences average \d+(\.\d)? words\.$/);
    expect(brief.excerpts.length).toBeGreaterThan(0);
    expect(BASELINE.some((b) => b.includes(brief.excerpts[0]!.slice(0, 80)))).toBe(true);
    expect(brief.notice).toMatch(/data to read/);

    const saved = (await ai.call("carrel_save_draft", { project: SLUG, item: "post-new", source: `---\ntitle: New\n---\nLet us delve into it.\n\n${PLANT}\n` }))
      .structuredContent as { checks: { issues: { excerpt: string | null; line: number | null }[]; voice: { unlike: boolean } } };
    expect(saved.checks.issues).toContainEqual(expect.objectContaining({ excerpt: "delve", line: 4 }));
    expect(saved.checks.voice.unlike).toBe(true);
  });
});

describe("learning from the author's edits", () => {
  it("offers a phrase cut from three AI-drafted posts and kept in none; one kept takes it off", async () => {
    const ai = await connectAs("owner@test.invalid", "Claude", { env, deps: { fetcher: site.fetch } });
    for (const id of ["a", "b", "c"]) {
      await ai.call("carrel_save_draft", { project: SLUG, item: id, source: `---\ntitle: ${id}\n---\nWe leverage synergy here. The river was up.\n` });
      await publish(id, "The river was up.");
    }
    const { project } = await owner();
    const offered = await cutSuggestions(testEnv.DB, project, await readVoicePack(testEnv.DB, project));
    expect(offered.map((s) => s.phrase)).toContain("leverage synergy");
    expect(offered.find((s) => s.phrase === "leverage synergy")!.posts).toBe(3);

    // Republishing the same post does not count it twice; keeping the phrase once withdraws the offer.
    await publish("c", "The river was up again.");
    await ai.call("carrel_save_draft", { project: SLUG, item: "d", source: `---\ntitle: d\n---\nWe leverage synergy here.\n` });
    await publish("d", "We leverage synergy here, I admit.");
    const after = await cutSuggestions(testEnv.DB, project, await readVoicePack(testEnv.DB, project));
    expect(after.map((s) => s.phrase)).not.toContain("leverage synergy");

    await decideCut(testEnv.DB, project, "synergy", "add");
    expect((await readVoicePack(testEnv.DB, project)).phrases).toEqual(["synergy"]);
  });
});
