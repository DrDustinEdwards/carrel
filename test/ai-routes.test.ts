// The browser's side of AI work: the unpublish page the email links to, the AI draft page, and
// flags in the editor. Driven through loaders and actions with a real request context.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { addFinding, saveAiDraft } from "~/lib/ai.server";
import { readDraft } from "~/lib/content.server";
import { requireSiteProject } from "~/lib/projects.server";
import { action as aiDraftAction, loader as aiDraftLoader } from "~/routes/ai-draft";
import { action as editorAction, loader as editorLoader } from "~/routes/editor";
import { action as unpublishAction, loader as unpublishLoader } from "~/routes/unpublish";
import { action as transcriptAction, loader as transcriptLoader } from "~/routes/transcript-draft";
import { saveTranscriptDraft } from "~/lib/transcripts.server";
import type { memoryAdapter } from "@dustinedwards/site-api/testing";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, publishPostOne, viewerFor, routeContext, settle } from "./site";

const SLUG = "de-info";
let site: ReturnType<typeof fakeSite>;
let env: Env;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const id = await addProject(SLUG, "dustinedwards");
  await share(id, editor, "editor");
  site = fakeSite();
  // The routes call the site through the global fetch, as the Worker does.
  vi.stubGlobal("fetch", site.fetch);
  env = connectedEnv();
});

const context = (email: string) => routeContext(env, email);

const published = () => publishPostOne(site);

async function as(email: string) {
  const viewer = await viewerFor(email);
  return { viewer, project: await requireSiteProject(testEnv.DB, viewer, SLUG, "read") };
}

describe("the unpublish page", () => {
  it("opens without changing anything, and one button returns the post to draft", async () => {
    await published();
    const params = { project: SLUG, item: "post-one" };
    const page = (await unpublishLoader({
      request: new Request("https://carrel.test/"),
      params,
      context: await context("owner@test.invalid"),
    } as never)) as Awaited<ReturnType<typeof unpublishLoader>>;
    expect(page.item).toMatchObject({ title: "Post one", status: "published" });
    expect((await site.adapter.content.get("post-one"))?.status).toBe("published");

    const done = await unpublishAction({
      request: new Request("https://carrel.test/", { method: "POST" }),
      params,
      context: await context("owner@test.invalid"),
    } as never);
    expect(done).toMatchObject({ ok: true, message: "Returned to draft. It is off the site." });
    expect((await site.adapter.content.get("post-one"))?.status).toBe("draft");
  });

  it("PLANT: an Editor cannot open it or use it", async () => {
    await published();
    const params = { project: SLUG, item: "post-one" };
    expect(
      (
        (await settle(
          unpublishLoader({
            request: new Request("https://carrel.test/"),
            params,
            context: await context("editor@test.invalid"),
          } as never),
        )) as Response
      ).status,
    ).toBe(403);
    expect(
      (
        (await settle(
          unpublishAction({
            request: new Request("https://carrel.test/", { method: "POST" }),
            params,
            context: await context("editor@test.invalid"),
          } as never),
        )) as Response
      ).status,
    ).toBe(403);
    expect((await site.adapter.content.get("post-one"))?.status).toBe("published");
  });
});

describe("AI drafts in the browser", () => {
  it("shows an AI draft to the person whose session saved it, and Use as my draft replaces only their working copy", async () => {
    await published();
    const { viewer, project } = await as("owner@test.invalid");
    const saved = await saveAiDraft(
      env,
      project,
      { viewer, client: "Claude 1.0" },
      "post-one",
      { source: "AI text.", note: "A note." },
      site.fetch,
    );
    const params = { project: SLUG, item: "post-one", id: String(saved.id) };
    const page = (await aiDraftLoader({
      request: new Request("https://carrel.test/"),
      params,
      context: await context("owner@test.invalid"),
    } as never)) as Awaited<ReturnType<typeof aiDraftLoader>>;
    expect(page.draft).toMatchObject({ client: "Claude 1.0", note: "A note.", source: "AI text." });

    const used = (await aiDraftAction({
      request: new Request("https://carrel.test/", { method: "POST" }),
      params,
      context: await context("owner@test.invalid"),
    } as never)) as Response;
    expect(used.headers.get("Location")).toBe(`/p/${SLUG}/e/post-one`);
    expect((await readDraft(testEnv.DB, project, viewer, "post-one"))?.source).toBe("AI text.");
    expect((await site.adapter.content.get("post-one"))?.source).toBe(
      "---\ntitle: Post one\n---\nWords.\n",
    );
  });

  it("PLANT: another person cannot see someone's AI draft", async () => {
    const { viewer, project } = await as("owner@test.invalid");
    const saved = await saveAiDraft(
      env,
      project,
      { viewer, client: "Claude" },
      "post-one",
      { source: "Private." },
      site.fetch,
    );
    const params = { project: SLUG, item: "post-one", id: String(saved.id) };
    expect(
      (
        (await settle(
          aiDraftLoader({
            request: new Request("https://carrel.test/"),
            params,
            context: await context("editor@test.invalid"),
          } as never),
        )) as Response
      ).status,
    ).toBe(404);
  });
});

describe("flags in the editor", () => {
  it("lists flags, and only the Owner dismisses one", async () => {
    await published();
    const reviewer = await viewerFor("owner@test.invalid");
    const { project } = await as("owner@test.invalid");
    const flag = await addFinding(
      testEnv.DB,
      project,
      { viewer: { ...reviewer, isReviewer: true }, client: "Grok Build" },
      "post-one",
      { message: "Check this." },
    );
    const params = { project: SLUG, item: "post-one" };
    const data = (await editorLoader({
      request: new Request("https://carrel.test/"),
      params,
      context: await context("editor@test.invalid"),
    } as never)) as Awaited<ReturnType<typeof editorLoader>>;
    expect(data.flags).toMatchObject([
      { status: "open", message: "Check this. (from Grok Build)" },
    ]);

    const dismiss = (email: string) => {
      const body = new FormData();
      body.set("intent", "dismiss-flag");
      body.set("flag", String(flag.id));
      return context(email).then((c) =>
        settle(
          editorAction({
            request: new Request("https://carrel.test/", { method: "POST", body }),
            params,
            context: c,
          } as never),
        ),
      );
    };
    expect(((await dismiss("editor@test.invalid")) as Response).status).toBe(403);
    expect(await dismiss("owner@test.invalid")).toEqual({
      intent: "dismiss-flag",
      dismissed: flag.id,
    });
  });
});

describe("the transcript draft page", () => {
  const VTT = (words: string) => `WEBVTT\n\n00:01:05.000 --> 00:01:08.000\n${words}\n`;

  it("shows the changed cues, publishes for the Owner, and the kept draft puts the old transcript back", async () => {
    await published();
    const transcripts = (site.adapter as ReturnType<typeof memoryAdapter>).transcripts;
    transcripts.set("post-one", VTT("Leptospiroborge pedersenii"));
    const { viewer, project } = await as("owner@test.invalid");
    const draft = await saveTranscriptDraft(
      env,
      project,
      { viewer, client: "Claude" },
      "post-one",
      {
        edits: [{ find: "Leptospiroborge pedersenii", replace: "Leptospira interrogans" }],
      },
    );
    const params = { project: SLUG, item: "post-one", id: String(draft.id) };
    const url = `https://carrel.test/p/${SLUG}/e/post-one/transcript/${draft.id}`;
    const page = await transcriptLoader({
      request: new Request(url),
      params,
      context: await context("owner@test.invalid"),
    } as never);
    expect(page).toMatchObject({
      canPublish: true,
      compared: {
        current: true,
        changes: { changed: [{ at: 65, before: "Leptospiroborge pedersenii" }] },
      },
    });
    // An editor sees it but cannot publish a live transcript.
    const asEditor = await as("editor@test.invalid");
    const theirs = await saveTranscriptDraft(
      env,
      asEditor.project,
      { viewer: asEditor.viewer, client: "Claude" },
      "post-one",
      { transcript: VTT("Leptospira interrogans") },
    );
    await expect(
      transcriptAction({
        request: new Request(url, { method: "POST" }),
        params: { ...params, id: String(theirs.id) },
        context: await context("editor@test.invalid"),
      } as never),
    ).rejects.toMatchObject({ status: 403 });

    const done = (await transcriptAction({
      request: new Request(url, { method: "POST" }),
      params,
      context: await context("owner@test.invalid"),
    } as never)) as Response;
    expect(transcripts.get("post-one")).toBe(VTT("Leptospira interrogans"));
    const keptId = /transcript\/(\d+)\?published=/.exec(done.headers.get("Location") ?? "")![1]!;
    await transcriptAction({
      request: new Request(url, { method: "POST" }),
      params: { ...params, id: keptId },
      context: await context("owner@test.invalid"),
    } as never);
    expect(transcripts.get("post-one")).toBe(VTT("Leptospiroborge pedersenii"));
  });
});
