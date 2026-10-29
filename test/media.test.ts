// The media library, through the content kit and Capsomer's MediaLibrary. The site is site-api's own
// handler over its reference adapter, whose reference check scans post sources for /media/<id> as
// dustinedwards.info's does. The kit's own rules (limits, versions, Undo) are tested in site-api; these
// are Carrel's: its roles as the kit reads them, the authorship record, the endpoint the editor and the
// picker use, and what the page shows. Planted: each role refusal, and a delete that must be asked.

import { memoryAdapter } from "@dustinedwards/site-api/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runHealth } from "~/lib/health.server";
import { figureMarkup } from "~/lib/site-markdown";
import { loader as editorLoader } from "~/routes/editor";
import { action as mediaAction, loader as mediaLoader } from "~/routes/media";
import { action as apiAction, loader as apiLoader } from "~/routes/media.api";

import { appPolicy } from "../workers/security-headers";
import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, SITE_ORIGIN, routeContext, refusal, viewerFor } from "./site";

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
  const id = await addProject(SLUG, "dustinedwards");
  await share(id, editor, "editor");
  await share(id, reader, "reader");
  site = fakeSite();
  env = connectedEnv();
  vi.stubGlobal("fetch", site.fetch);
});

const contextFor = (email: string, e: Env = env) => routeContext(e, email);
const sent = (method: string) => site.requests.filter((r) => r.startsWith(method));
const rows = () => testEnv.DB.prepare("SELECT item_id, person_id, action FROM changes ORDER BY created_at").all().then((r) => r.results);

/** A file on the site, uploaded as the site would take it from anyone. */
async function seedFile(name = "river.png") {
  return site.adapter.media!.upload({ bytes: PNG, contentType: "image/png", filename: name, alt: "The river", changeId: "seed" });
}

/** Posts the library page's form with no script, as `email`. */
async function post(email: string, fields: Record<string, string | string[]>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) form.append(k, one);
  const request = new Request(`https://carrel.test/p/${SLUG}/media`, { method: "POST", body: form });
  return mediaAction({ request, params: { project: SLUG }, context: await contextFor(email) } as never);
}

type Page = Awaited<ReturnType<typeof mediaLoader>>;
const page = async (email: string, query = "") =>
  (await mediaLoader({ request: new Request(`https://carrel.test/p/${SLUG}/media${query}`), params: { project: SLUG }, context: await contextFor(email) } as never)) as Page;

describe("the library page", () => {
  it("shows the site's files at the site's own address, and a file's uses open in Carrel's editor", async () => {
    const item = await seedFile();
    await site.adapter.content.saveDraft("river-post", { source: `# The river\n\n![](${item.url})\n`, expectedVersion: null, changeId: "c1" });
    const { data } = await page("reader@test.invalid", `?inspect=${encodeURIComponent(item.id)}`);
    expect(data?.rows).toMatchObject([{ key: item.id, url: item.url, thumb: `${SITE_ORIGIN}${item.url}`, usedUnknown: true }]);
    expect(data?.inspected?.used).toEqual([{ title: "The river", href: `/p/${SLUG}/e/river-post`, how: expect.any(String) }]);
    // A Reader looks; nothing is offered to change.
    expect(data?.can).toMatchObject({ edit: false, deleteMedia: false });
  });

  it("says so when the site has no media library, and the editor then gets no image tools", async () => {
    site = fakeSite(memoryAdapter({ media: false }));
    vi.stubGlobal("fetch", site.fetch);
    expect((await page("owner@test.invalid")).unavailable).toBe("This site has no media library yet.");
    await site.adapter.content.saveDraft("post-one", { source: "# One\n", expectedVersion: null, changeId: "s" });
    const editor = (await editorLoader({ params: { project: SLUG, item: "post-one" }, context: await contextFor("owner@test.invalid") } as never)) as { media: unknown };
    expect(editor.media).toBeNull();
  });
});

describe("PLANT: roles, as the kit reads Carrel's", () => {
  it("lets an Editor tag and move a file to the trash, and records each under the Editor", async () => {
    const item = await seedFile();
    const editor = await viewerFor("editor@test.invalid");
    expect(await post("editor@test.invalid", { intent: "tag-add", ids: [item.id], versions: [item.version!], tags: "river" })).toMatchObject({ ok: true });
    const tagged = (await site.adapter.media!.get(item.id))!;
    expect(await post("editor@test.invalid", { intent: "trash", ids: [item.id], versions: [tagged.version!] })).toMatchObject({ ok: true, undo: { intent: "restore" } });
    expect(await rows()).toEqual([
      { item_id: item.id, person_id: editor.id, action: "media-tags" },
      { item_id: item.id, person_id: editor.id, action: "media-trash" },
    ]);
  });

  it("refuses an Editor's delete for good and replace, and a Reader's upload, before the site hears anything", async () => {
    const item = await seedFile();
    const before = site.requests.length;
    expect(await post("editor@test.invalid", { intent: "delete", ids: [item.id], confirm: "1" })).toMatchObject({ ok: false, message: expect.stringContaining("Owner") });
    expect(await post("editor@test.invalid", { intent: "replace", ids: [item.id], versions: [item.version!] })).toMatchObject({ ok: false, message: expect.stringContaining("Owner") });
    expect(site.requests.length).toBe(before);

    const form = new FormData();
    form.set("file", new File([PNG], "river.png", { type: "image/png" }));
    const upload = new Request(`https://carrel.test/p/${SLUG}/media/api`, { method: "POST", body: form });
    expect(await refusal(apiAction({ request: upload, params: { project: SLUG }, context: await contextFor("reader@test.invalid") } as never))).toBe(403);
    expect(sent("POST")).toEqual([]);
    expect(site.adapter.mediaStore.size).toBe(1);
    expect(await rows()).toEqual([]);
  });
});

describe("PLANT: deleting for good", () => {
  it("asks first, sends nothing until the count is typed, then shows the site's refusal of a file a post uses", async () => {
    const item = await seedFile();
    await site.adapter.content.saveDraft("river-post", { source: `# The river\n\n![](${item.url})\n`, expectedVersion: null, changeId: "c1" });
    const trashed = await site.adapter.media!.trash!(item.id, { expectedVersion: item.version!, changeId: "t" });
    expect(await post("owner@test.invalid", { intent: "delete", ids: [item.id] })).toMatchObject({ ok: false, confirm: { typeToConfirm: "1", items: [item.id] } });
    expect(sent("DELETE")).toEqual([]);
    const refused = await post("owner@test.invalid", { intent: "delete", ids: [item.id], versions: [trashed.version!], confirm: "1" });
    expect(refused.outcomes?.[0]).toMatchObject({ ok: false, usedBy: [{ id: "river-post", title: "The river" }] });
    expect(site.adapter.mediaStore.has(item.id)).toBe(true);
    expect(await rows()).toEqual([]);
  });
});

describe("the editor's image tools and the picker", () => {
  it("are given to an Editor with the site's accepted types, and never to a Reader", async () => {
    await site.adapter.content.saveDraft("post-one", { source: "# One\n", expectedVersion: null, changeId: "s" });
    const load = async (email: string) =>
      (await editorLoader({ params: { project: SLUG, item: "post-one" }, context: await contextFor(email) } as never)) as { media: { endpoint: string; accept: string } | null };
    expect((await load("editor@test.invalid")).media).toEqual({ endpoint: `/p/${SLUG}/media/api`, accept: expect.stringContaining("image/png") });
    expect((await load("reader@test.invalid")).media).toBeNull();
  });

  it("uploads through the endpoint, answers the site's address, and records the upload under the person", async () => {
    const form = new FormData();
    form.set("file", new File([PNG], "river.png", { type: "image/png" }));
    form.set("alt", "The river at dusk");
    const request = new Request(`https://carrel.test/p/${SLUG}/media/api`, { method: "POST", body: form });
    const response = (await apiAction({ request, params: { project: SLUG }, context: await contextFor("editor@test.invalid") } as never)) as Response;
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; url: string; src: string };
    expect(body.url).toMatch(/^\/media\/uploads\//);
    expect(body.src).toBe(`${SITE_ORIGIN}${body.url}`);
    expect(await rows()).toEqual([{ item_id: body.id, person_id: (await viewerFor("editor@test.invalid")).id, action: "media-upload" }]);
  });

  it("gives the picker the library's data, and says why when the site cannot be reached", async () => {
    await seedFile();
    const list = (await apiLoader({ request: new Request(`https://carrel.test/p/${SLUG}/media/api?q=river`), params: { project: SLUG }, context: await contextFor("reader@test.invalid") } as never)) as Response;
    expect(((await list.json()) as { rows: unknown[] }).rows).toHaveLength(1);
    const offline = { ...env, SITE_DUSTINEDWARDS_KEY: "" };
    const answer = (await apiLoader({ request: new Request(`https://carrel.test/p/${SLUG}/media/api`), params: { project: SLUG }, context: await contextFor("reader@test.invalid", offline) } as never)) as Response;
    expect(answer.status).toBe(502);
    expect(await answer.json()).toMatchObject({ error: expect.stringContaining("not connected") });
  });

  it("inserts the site's own figure, with the alt text escaped", () => {
    expect(figureMarkup("dustinedwards", "/media/a.png", ' The "river" ')).toBe(':::figure{src="/media/a.png" alt="The &quot;river&quot;"}\n:::');
    expect(figureMarkup("some-other-site", "/media/a.png", "A [river]")).toBe("![A river](/media/a.png)");
  });
});

describe("the image policy", () => {
  it("loads images from the configured sites, and drops anything that is not a plain https origin", () => {
    const policy = appPolicy("AAAAAAAAAAAAAAAAAAAAAA==", ["https://site.test", "https://evil.test; script-src *", "http://plain.test"]);
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
