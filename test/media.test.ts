// The media library (stage 3) over site-api v0.2.0's media group. The site is site-api's own handler
// over its reference adapter, whose reference check scans post sources for /media/<id> as
// dustinedwards.info's does. Planted: each role refusal, a delete of a file a post uses (refused with
// the post named), an upload the site would refuse (never sent), and bytes the site API refuses.

import { memoryAdapter } from "@dustinedwards/site-api/testing";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { runHealth } from "~/lib/health.server";
import { deleteMedia, listMedia, mediaDetail, mediaLimits, uploadMedia } from "~/lib/media.server";
import { requireSiteProject } from "~/lib/projects.server";
import { figureMarkup } from "~/lib/site-markdown";
import { loader as editorLoader } from "~/routes/editor";
import { action as mediaAction, loader as mediaLoader } from "~/routes/media";
import { action as apiAction, loader as apiLoader } from "~/routes/media.api";

import { appPolicy } from "../workers/csp";
import { addPerson, addProject, resetDb, share } from "./env";
import { connectedEnv, fakeSite, SITE_ORIGIN, viewerFor } from "./site";

const SLUG = "de-info";
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

let site: ReturnType<typeof fakeSite<ReturnType<typeof memoryAdapter>>>;
let env: Env;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const reader = await addPerson("reader@test.invalid");
  await addPerson("stranger@test.invalid");
  const id = await addProject(SLUG, "dustinedwards");
  await share(id, editor, "editor");
  await share(id, reader, "reader");
  site = fakeSite();
  env = connectedEnv();
  vi.stubGlobal("fetch", site.fetch);
});

async function project(email: string, action: Parameters<typeof requireSiteProject>[3] = "read") {
  return requireSiteProject(env.DB, await viewerFor(email), SLUG, action);
}

function file(bytes: Uint8Array, name = "river.png", type = "image/png") {
  return { name, type, size: bytes.byteLength, bytes: async () => bytes.slice().buffer };
}

async function status(run: () => Promise<unknown>): Promise<number> {
  try {
    await run();
    return 200;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

async function contextFor(email: string, e: Env = env) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env: e, ctx: {} as ExecutionContext });
  context.set(viewerContext, await viewerFor(email));
  context.set(nonceContext, "n");
  return context;
}

/** A file on the site, uploaded as the site would take it from anyone. */
async function seedFile(name = "river.png") {
  return site.adapter.media!.upload({ bytes: PNG, contentType: "image/png", filename: name, alt: "The river", changeId: "seed" });
}

describe("the library through the site API", () => {
  it("lists, searches and reads a file with its uses, and shows it at the site's own address", async () => {
    const item = await seedFile();
    const reader = await project("reader@test.invalid");
    const list = await listMedia(env, reader, {});
    expect(list.items).toMatchObject([{ id: item.id, url: `/media/${item.id}`, src: `${SITE_ORIGIN}/media/${item.id}`, alt: "The river" }]);
    expect((await listMedia(env, reader, { q: "nothing-like-it" })).items).toEqual([]);
    expect(await mediaDetail(env, reader, item.id)).toMatchObject({ id: item.id, usedBy: [] });
    expect(await mediaDetail(env, reader, "uploads/no-such.png")).toBeNull();
    expect(await mediaLimits(env, reader)).toMatchObject({ types: expect.arrayContaining(["image/png"]) });
  });

  it("uploads as an Editor into the site's own storage", async () => {
    const outcome = await uploadMedia(env, await project("editor@test.invalid"), file(PNG), "The river at dusk");
    expect(outcome).toMatchObject({ ok: true, item: { filename: "river.png", alt: "The river at dusk", src: expect.stringMatching(/^https:\/\/site\.test\/media\//) } });
    expect(site.adapter.mediaStore.size).toBe(1);
  });

  it("deletes as the Owner", async () => {
    const item = await seedFile();
    expect(await deleteMedia(env, await project("owner@test.invalid"), item.id)).toEqual({ ok: true });
    expect(site.adapter.deleted).toEqual([item.id]);
  });
});

describe("PLANT: roles", () => {
  it("refuses a Reader's upload, and the site hears nothing", async () => {
    const reader = await project("reader@test.invalid");
    expect(await status(() => uploadMedia(env, reader, file(PNG), ""))).toBe(403);
    expect(site.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
  });

  it("refuses an Editor's delete, and the file stays", async () => {
    const item = await seedFile();
    const editor = await project("editor@test.invalid");
    expect(await status(() => deleteMedia(env, editor, item.id))).toBe(403);
    expect(site.adapter.mediaStore.has(item.id)).toBe(true);
    expect(site.requests.filter((r) => r.startsWith("DELETE"))).toEqual([]);
  });

  it("answers 404 to someone the project is not shared with", async () => {
    expect(await status(() => project("stranger@test.invalid"))).toBe(404);
  });

  it("refuses at the routes too: a Reader's upload and an Editor's delete", async () => {
    await seedFile();
    const form = new FormData();
    form.set("file", new File([PNG], "river.png", { type: "image/png" }));
    const upload = new Request(`https://carrel.test/p/${SLUG}/media/api`, { method: "POST", body: form });
    const readerContext = await contextFor("reader@test.invalid");
    expect(await status(() => apiAction({ request: upload, params: { project: SLUG }, context: readerContext } as never))).toBe(403);
    expect(site.requests.filter((r) => r.startsWith("POST"))).toEqual([]);

    const del = new FormData();
    del.set("intent", "delete");
    del.set("id", "uploads/1-river.png");
    del.set("confirm", "delete");
    const request = new Request(`https://carrel.test/p/${SLUG}/media`, { method: "POST", body: del });
    const context = await contextFor("editor@test.invalid");
    expect(await status(() => mediaAction({ request, params: { project: SLUG }, context } as never))).toBe(403);
    expect(site.adapter.mediaStore.size).toBe(1);
  });
});

describe("PLANT: deleting a file a post uses", () => {
  it("is refused by the site's reference check, with the post named, and the file stays", async () => {
    const item = await seedFile();
    await site.adapter.content.saveDraft("river-post", {
      source: `---\ntitle: The river\n---\nIntro.\n\n:::figure{src="${item.url}" alt="The river"}\n:::\n`,
      expectedVersion: null,
      changeId: "c1",
    });
    const owner = await project("owner@test.invalid");
    expect(await mediaDetail(env, owner, item.id)).toMatchObject({ usedBy: [{ id: "river-post", title: "The river", detail: "line 6" }] });

    const outcome = await deleteMedia(env, owner, item.id);
    expect(outcome).toMatchObject({ ok: false, usedBy: [{ type: "post", id: "river-post", title: "The river", detail: "line 6" }] });
    expect(!outcome.ok && outcome.message).toContain("The river (line 6)");
    expect(site.adapter.mediaStore.has(item.id)).toBe(true);
    expect(site.adapter.deleted).toEqual([]);
  });

  it("asks before it deletes, then shows the refusal on the page", async () => {
    const item = await seedFile();
    await site.adapter.content.saveDraft("river-post", { source: `# The river\n\n![](${item.url})\n`, expectedVersion: null, changeId: "c1" });
    const post = async (fields: Record<string, string>) => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      const request = new Request(`https://carrel.test/p/${SLUG}/media`, { method: "POST", body: form });
      return mediaAction({ request, params: { project: SLUG }, context: await contextFor("owner@test.invalid") } as never);
    };
    expect(await post({ intent: "delete", id: item.id })).toEqual({ intent: "delete", needsConfirm: true, id: item.id });
    expect(site.requests.filter((r) => r.startsWith("DELETE"))).toEqual([]);
    expect(await post({ intent: "delete", id: item.id, confirm: "delete" })).toMatchObject({
      intent: "delete",
      ok: false,
      usedBy: [{ id: "river-post", title: "The river" }],
    });
    expect(site.adapter.mediaStore.has(item.id)).toBe(true);
  });
});

describe("PLANT: an upload the site does not accept", () => {
  it("refuses a type the site did not declare before sending anything", async () => {
    const outcome = await uploadMedia(env, await project("editor@test.invalid"), file(new TextEncoder().encode("<script>x</script>"), "page.html", "text/html"), "");
    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining("this site accepts") });
    expect(site.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
  });

  it("refuses a file over the site's limit before sending anything", async () => {
    site = fakeSite(memoryAdapter({ media: { maxBytes: 64, types: ["image/png"] } }));
    vi.stubGlobal("fetch", site.fetch);
    const big = new Uint8Array(65);
    big.set(PNG.subarray(0, 8));
    const outcome = await uploadMedia(env, await project("editor@test.invalid"), file(big), "");
    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining("accepts files up to") });
    expect(site.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
    expect(site.adapter.mediaStore.size).toBe(0);
  });

  it("shows the site API's refusal of bytes that are not their type, and stores nothing", async () => {
    const outcome = await uploadMedia(env, await project("editor@test.invalid"), file(new TextEncoder().encode("not a png at all"), "fake.png"), "");
    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining("The site refused fake.png") });
    expect(site.adapter.mediaStore.size).toBe(0);
  });
});

describe("a site with no media library", () => {
  beforeEach(() => {
    site = fakeSite(memoryAdapter({ media: false }));
    vi.stubGlobal("fetch", site.fetch);
  });

  it("says so on the page, and the editor gets no image tools", async () => {
    const data = (await mediaLoader({ request: new Request(`https://carrel.test/p/${SLUG}/media`), params: { project: SLUG }, context: await contextFor("owner@test.invalid") } as never)) as { unavailable: string | null };
    expect(data.unavailable).toBe("This site has no media library yet.");
    await site.adapter.content.saveDraft("post-one", { source: "# One\n", expectedVersion: null, changeId: "s" });
    const editor = (await editorLoader({ params: { project: SLUG, item: "post-one" }, context: await contextFor("owner@test.invalid") } as never)) as { media: unknown };
    expect(editor.media).toBeNull();
  });
});

describe("the editor's image tools", () => {
  it("are given to an Editor with the site's accepted types, and never to a Reader", async () => {
    await site.adapter.content.saveDraft("post-one", { source: "# One\n", expectedVersion: null, changeId: "s" });
    const load = async (email: string) =>
      (await editorLoader({ params: { project: SLUG, item: "post-one" }, context: await contextFor(email) } as never)) as { media: { endpoint: string; accept: string } | null };
    expect((await load("editor@test.invalid")).media).toEqual({ endpoint: `/p/${SLUG}/media/api`, accept: expect.stringContaining("image/png") });
    expect((await load("reader@test.invalid")).media).toBeNull();
  });

  it("uploads through the endpoint and answers the site's address and where to show it", async () => {
    const form = new FormData();
    form.set("file", new File([PNG], "river.png", { type: "image/png" }));
    const request = new Request(`https://carrel.test/p/${SLUG}/media/api`, { method: "POST", body: form });
    const response = (await apiAction({ request, params: { project: SLUG }, context: await contextFor("editor@test.invalid") } as never)) as Response;
    expect(response.status).toBe(201);
    const body = (await response.json()) as { url: string; src: string };
    expect(body.url).toMatch(/^\/media\/uploads\//);
    expect(body.src).toBe(`${SITE_ORIGIN}${body.url}`);
  });

  it("lists for the picker, and says why when the site cannot be reached", async () => {
    await seedFile();
    const list = (await apiLoader({ request: new Request(`https://carrel.test/p/${SLUG}/media/api?q=river`), params: { project: SLUG }, context: await contextFor("reader@test.invalid") } as never)) as Response;
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
    const offline = { ...env, SITE_DUSTINEDWARDS_KEY: "" };
    const answer = (await apiLoader({ request: new Request(`https://carrel.test/p/${SLUG}/media/api`), params: { project: SLUG }, context: await contextFor("reader@test.invalid", offline) } as never)) as Response;
    expect(await answer.json()).toMatchObject({ items: [], error: expect.stringContaining("not connected") });
  });

  it("inserts the site's own figure, with the alt text escaped", () => {
    expect(figureMarkup("dustinedwards", "/media/a.png", ' The "river" ')).toBe(':::figure{src="/media/a.png" alt="The &quot;river&quot;"}\n:::');
    expect(figureMarkup("some-other-site", "/media/a.png", "A [river]")).toBe("![A river](/media/a.png)");
  });
});

describe("the image policy", () => {
  it("loads images from the configured sites, and drops anything that is not a plain https origin", () => {
    const policy = appPolicy("n", ["https://site.test", "https://evil.test; script-src *", "http://plain.test"]);
    expect(policy).toContain("img-src 'self' data: https://site.test;");
    expect(policy).not.toContain("evil.test");
    expect(policy).not.toContain("plain.test");
  });
});

describe("health", () => {
  it("runs the media conformance against a site with media, and never stores or deletes a file", async () => {
    const existing = await seedFile();
    const box = { sent: [] as unknown[] };
    const EMAIL = { send: async (m: unknown) => (box.sent.push(m), { messageId: "m" }) } as unknown as SendEmail;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("cloudflareaccess") ? Response.json({ keys: [{ kid: "k" }] }) : site.fetch(url, init);
    }) as unknown as Parameters<typeof runHealth>[1];
    const { results } = await runHealth({ ...env, EMAIL }, fetcher);
    expect(results.find((r) => r.name === "site-dustinedwards")).toMatchObject({ ok: true });
    expect(site.requests).toEqual(expect.arrayContaining(["GET /api/carrel/v1/media", "DELETE /api/carrel/v1/media/carrel-conformance-probe%2Fno-such-file.png", "POST /api/carrel/v1/media"]));
    expect([...site.adapter.mediaStore.keys()]).toEqual([existing.id]);
    expect(site.adapter.deleted).toEqual([]);
  });
});
