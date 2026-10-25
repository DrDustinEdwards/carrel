// The voice pack, as a session meets it: a brief built from the published posts, and the scan an AI
// draft comes back with. The scan itself is site-runtime ./prose's, tested there; these hold Carrel's part.

import { beforeEach, describe, expect, it } from "vitest";

import { writeToSite } from "~/lib/content.server";
import { requireSiteProject } from "~/lib/projects.server";
import { sentenceSpread } from "@dustinedwards/site-runtime/prose";
import { type DraftCheck, type VoiceBrief } from "~/lib/voice.server";

import { BASELINE, PLANT, TWIN } from "./fixtures/voice";
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

describe("the brief and the scan", () => {
  it("builds the brief from the published posts, and a saved draft comes back with the scan", async () => {
    for (const [i, body] of BASELINE.entries()) await publish(`post-${i}`, body);
    const ai = await connectAs("owner@test.invalid", "Claude", { env, deps: { fetcher: site.fetch } });

    const brief = (await ai.call("carrel_voice_brief", { project: SLUG })).structuredContent as VoiceBrief & { notice: string };
    expect(brief.posts).toBe(BASELINE.length);
    expect(BASELINE.some((b) => b.includes(brief.excerpts[0]!.slice(0, 80)))).toBe(true);
    expect(brief.notice).toMatch(/data to read/);
    expect(brief.rules).toMatch(/Never copy their facts/);

    // The excerpts hold one of the author's long sentences and one of their short ones; the brief holds
    // no word list and no measured average, which a model would copy as a length to write every time.
    const spread = sentenceSpread(BASELINE)!;
    const lengths = brief.excerpts.flatMap((e) => e.split(/(?<=[.!?]["”]?)\s+/).map((t) => t.split(/\s+/).filter(Boolean).length));
    expect(lengths.some((n) => n >= spread.long)).toBe(true);
    expect(lengths.some((n) => n >= 2 && n <= spread.short)).toBe(true);
    expect(Object.keys(brief).sort()).toEqual(["builtAt", "excerpts", "guide", "notice", "posts", "rules"]);
    expect(brief.rules).not.toMatch(/average/i);

    // A filler phrase, another author's long sentences, and a sentence lifted from an excerpt are each named.
    const lifted = brief.excerpts[0]!.split(/(?<=\.)\s+/).find((s) => s.split(" ").length >= 10)!;
    const saved = (await ai.call("carrel_save_draft", { project: SLUG, item: "post-new", source: `---\ntitle: New\n---\nGreat question, so we walked.\n\n${PLANT}\n\n${lifted}\n` }))
      .structuredContent as { checks: DraftCheck };
    expect(saved.checks.findings).toContainEqual(expect.objectContaining({ kind: "filler", excerpt: "Great question", line: 4 }));
    expect(saved.checks.findings.some((f) => f.kind === "length")).toBe(true);
    expect(saved.checks.findings.filter((f) => f.kind === "copied")).toHaveLength(1);
    expect(saved.checks.instruction).toMatch(/^Edit the draft in place\. Change only the spans listed\./);
    expect(saved.checks.instruction).toContain('- Line 4, "Great question": Answer the question. Cut the compliment.');

    // A plain page in the author's register comes back clean.
    const clean = (await ai.call("carrel_check_post_text", { project: SLUG, source: `---\ntitle: Twin\n---\n${TWIN}\n` })).structuredContent as DraftCheck;
    expect(clean).toEqual({ findings: [], instruction: null });
  });
});
