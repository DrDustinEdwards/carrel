// Legal pages: shared sections written into each site's page, the fields they take, the date stamped
// on an Owner publish of a changed text, and the page the site's data license names that Carrel never
// takes down or moves. The write tests run Carrel's real code against site-api's reference site.

import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { writeToSite } from "~/lib/content.server";
import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { readFields, splitSource } from "~/lib/frontmatter";
import { expandShared, legalTypeOf, prepareLegalWrite, sectionsUsed, type SharedSection } from "~/lib/legal";
import { deleteSection, listSections, saveSection } from "~/lib/legal.server";
import { requireSiteProject } from "~/lib/projects.server";
import { siteEntry } from "~/lib/sites.server";
import { action as legalAction, loader as legalLoader } from "~/routes/legal";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const SLUG = "de-info";

const SECTIONS: SharedSection[] = [
  { key: "hosting", title: "Hosting", body: "{{site_name}} runs on Cloudflare. Questions go to {{contact}}." },
  { key: "analytics", title: "Analytics", body: "Cloudflare Web Analytics counts visits without tracking cookies." },
];

const FRONT = ["---", "path: /privacy", 'title: "Privacy"', "legal_type: privacy", 'site_name: "dustinedwards.info"', 'contact: "hello@example.test"', "---", ""].join("\n");

describe("expandShared", () => {
  it("writes each section between its markers with the page's fields filled in", () => {
    const out = expandShared("Intro.\n\n<!-- shared:hosting -->\n", SECTIONS, { site_name: "dustinedwards.info", contact: "hello@example.test" });
    expect(out.text).toBe(
      "Intro.\n\n<!-- shared:hosting -->\ndustinedwards.info runs on Cloudflare. Questions go to hello@example.test.\n<!-- /shared:hosting -->\n",
    );
    expect(out.unknownSections).toEqual([]);
    expect(out.missingFields).toEqual([]);
  });

  it("gives the same text when run again, so a page is expanded on every write", () => {
    const values = { site_name: "A", contact: "b@example.test" };
    const once = expandShared("<!-- shared:hosting -->\n\n<!-- shared:analytics -->\n", SECTIONS, values).text;
    expect(expandShared(once, SECTIONS, values).text).toBe(once);
    expect(sectionsUsed(once)).toEqual(["hosting", "analytics"]);
  });

  it("replaces text a person typed inside the markers, since the section is the source", () => {
    const out = expandShared("<!-- shared:analytics -->\nold wording\n<!-- /shared:analytics -->", SECTIONS, {});
    expect(out.text).not.toContain("old wording");
  });

  it("names an unknown section and a missing field, and leaves both as written", () => {
    const out = expandShared("<!-- shared:nope -->\n<!-- shared:hosting -->", SECTIONS, { site_name: "A" });
    expect(out.unknownSections).toEqual(["nope"]);
    expect(out.missingFields).toEqual(["contact"]);
    expect(out.text).toContain("<!-- shared:nope -->");
    expect(out.text).toContain("{{contact}}");
  });
});

describe("prepareLegalWrite", () => {
  const base = { sections: SECTIONS, today: "2026-10-06" };

  it("stamps last_updated when the Owner publishes a changed text", () => {
    const result = prepareLegalWrite({ ...base, source: `${FRONT}New.\n`, stored: `${FRONT}Old.\n`, storedPublic: true, public: true });
    expect(result.ok && readFields(splitSource(result.source).front).last_updated).toBe("2026-10-06");
  });

  it("leaves the date alone when only a field changed", () => {
    const stored = `${FRONT}Same.\n`;
    const result = prepareLegalWrite({ ...base, source: stored.replace("hello@example.test", "other@example.test"), stored, storedPublic: true, public: true });
    expect(result.ok && readFields(splitSource(result.source).front).last_updated).toBe("");
  });

  it("stamps a draft that goes public even if its text was already saved", () => {
    const stored = `${FRONT}Saved earlier.\n`;
    const result = prepareLegalWrite({ ...base, source: stored, stored, storedPublic: false, public: true });
    expect(result.ok && readFields(splitSource(result.source).front).last_updated).toBe("2026-10-06");
  });

  it("does not stamp a draft save, and keeps a missing field's token so no work is lost", () => {
    const source = FRONT.replace('contact: "hello@example.test"\n', "") + "<!-- shared:hosting -->\n";
    const result = prepareLegalWrite({ ...base, source, stored: null, storedPublic: false, public: false });
    expect(result.ok && result.source).toContain("{{contact}}");
    expect(result.ok && readFields(splitSource(result.source).front).last_updated).toBe("");
  });

  it("refuses to go public with a field missing or a section unknown, and says which", () => {
    const missing = prepareLegalWrite({ ...base, source: FRONT.replace('contact: "hello@example.test"\n', "") + "<!-- shared:hosting -->\n", stored: null, storedPublic: false, public: true });
    expect(!missing.ok && missing.message).toContain("contact");
    const unknown = prepareLegalWrite({ ...base, source: `${FRONT}<!-- shared:nope -->\n`, stored: null, storedPublic: false, public: true });
    expect(!unknown.ok && unknown.message).toContain('"nope"');
  });

  it("recognises a legal page by its legal_type", () => {
    expect(legalTypeOf(FRONT)).toBe("privacy");
    expect(legalTypeOf("---\ntitle: x\n---\n")).toBeNull();
    expect(legalTypeOf("no frontmatter")).toBeNull();
  });
});

let projectId: number;
let ownerId: number;

beforeEach(async () => {
  await resetDb();
  ownerId = await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  projectId = await addProject(SLUG, "dustinedwards");
  await share(projectId, editor, "editor");
  for (const s of SECTIONS) {
    await testEnv.DB.prepare("INSERT INTO legal_sections (key, title, body, updated_by) VALUES (?, ?, ?, ?)").bind(s.key, s.title, s.body, ownerId).run();
  }
});

async function as(email: string) {
  const viewer = await viewerFor(email);
  return { viewer, project: await requireSiteProject(testEnv.DB, viewer, SLUG, "read") };
}

async function seed(site: ReturnType<typeof fakeSite>, id: string, source: string) {
  const { viewer, project } = await as("owner@test.invalid");
  const saved = await writeToSite(connectedEnv(), project, viewer, id, { action: "save", source, expectedVersion: null }, site.fetch);
  if (!saved.ok) throw new Error(saved.message);
  return saved.version;
}

const writes = (site: ReturnType<typeof fakeSite>) => site.requests.filter((r) => !r.startsWith("GET"));

describe("a legal page written to the site", () => {
  it("is published with its shared sections filled in and its date stamped, through the real write path", async () => {
    const site = fakeSite();
    const { viewer, project } = await as("owner@test.invalid");
    const version = await seed(site, "page.privacy", `${FRONT}Intro.\n\n<!-- shared:hosting -->\n`);
    const published = await writeToSite(connectedEnv(), project, viewer, "page.privacy", { action: "publish", expectedVersion: version }, site.fetch);
    expect(published.ok).toBe(true);
    // A publish with no text sends the stored text, so the stored text is what the draft save wrote.
    const doc = await site.adapter.content.get("page.privacy");
    expect(doc?.source).toContain("dustinedwards.info runs on Cloudflare. Questions go to hello@example.test.");
    expect(doc?.status).toBe("published");
  });

  it("stamps last_updated when the text sent with a publish changed", async () => {
    const site = fakeSite();
    const { viewer, project } = await as("owner@test.invalid");
    const version = await seed(site, "page.privacy", `${FRONT}Intro.\n`);
    const published = await writeToSite(connectedEnv(), project, viewer, "page.privacy", { action: "publish", expectedVersion: version, source: `${FRONT}Changed.\n` }, site.fetch);
    expect(published.ok).toBe(true);
    expect(readFields(splitSource((await site.adapter.content.get("page.privacy"))!.source).front).last_updated).toBe(new Date().toISOString().slice(0, 10));
  });

  it("is refused at publish with a field missing, and the site hears no write after the seed", async () => {
    const site = fakeSite();
    const { viewer, project } = await as("owner@test.invalid");
    const source = FRONT.replace('contact: "hello@example.test"\n', "") + "<!-- shared:hosting -->\n";
    const version = await seed(site, "page.privacy", source);
    const before = writes(site).length;
    const published = await writeToSite(connectedEnv(), project, viewer, "page.privacy", { action: "publish", expectedVersion: version, source }, site.fetch);
    expect(published).toMatchObject({ ok: false, reason: "refused" });
    expect(writes(site).length).toBe(before);
  });

  it("is an ordinary item for an AI session: no special refusal, the same role rules", async () => {
    const site = fakeSite();
    const { viewer, project } = await as("editor@test.invalid");
    const saved = await writeToSite(connectedEnv(), project, viewer, "page.privacy", { action: "save", source: `${FRONT}Draft text.\n`, expectedVersion: null }, site.fetch, { client: "claude" });
    expect(saved.ok).toBe(true);
  });
});

describe("PLANT: the page the site's data license names", () => {
  const TERMS = ["---", "path: /terms", 'title: "Terms"', "legal_type: terms", "---", "The terms.", ""].join("\n");

  it("cannot be unpublished through Carrel, and the site hears nothing", async () => {
    expect(siteEntry("dustinedwards").keepPublic).toContain("page.terms");
    const site = fakeSite();
    const { viewer, project } = await as("owner@test.invalid");
    const version = await seed(site, "page.terms", TERMS);
    const published = await writeToSite(connectedEnv(), project, viewer, "page.terms", { action: "publish", expectedVersion: version }, site.fetch);
    if (!published.ok) throw new Error(published.message);
    const before = writes(site).length;
    const result = await writeToSite(connectedEnv(), project, viewer, "page.terms", { action: "unpublish", expectedVersion: published.version }, site.fetch);
    expect(result).toMatchObject({ ok: false, reason: "refused" });
    expect(writes(site).length).toBe(before);
    expect((await site.adapter.content.get("page.terms"))?.status).toBe("published");
  });

  it("can have its wording changed, but not its path", async () => {
    const site = fakeSite();
    const { viewer, project } = await as("owner@test.invalid");
    const version = await seed(site, "page.terms", TERMS);
    const moved = await writeToSite(connectedEnv(), project, viewer, "page.terms", { action: "save", source: TERMS.replace("path: /terms", "path: /legal"), expectedVersion: version }, site.fetch);
    expect(moved).toMatchObject({ ok: false, reason: "refused" });
    expect((moved as { message: string }).message).toContain("/terms");
    const reworded = await writeToSite(connectedEnv(), project, viewer, "page.terms", { action: "save", source: TERMS.replace("The terms.", "Better terms."), expectedVersion: version }, site.fetch);
    expect(reworded.ok).toBe(true);
  });

  it("is guarded by id even when its legal_type is removed", async () => {
    const site = fakeSite();
    const { viewer, project } = await as("owner@test.invalid");
    const version = await seed(site, "page.terms", TERMS);
    const moved = await writeToSite(connectedEnv(), project, viewer, "page.terms", { action: "save", source: TERMS.replace("legal_type: terms\n", "").replace("path: /terms", "path: /legal"), expectedVersion: version }, site.fetch);
    expect(moved).toMatchObject({ ok: false, reason: "refused" });
  });
});

describe("the shared sections", () => {
  it("are changed only by the Owner", async () => {
    const editor = await as("editor@test.invalid");
    await expect(saveSection(testEnv.DB, editor.project, editor.viewer, { key: "x", title: "X", body: "Text." })).rejects.toMatchObject({ status: 403 });
    await expect(deleteSection(testEnv.DB, editor.project, "hosting")).rejects.toMatchObject({ status: 403 });
    const owner = await as("owner@test.invalid");
    expect(await saveSection(testEnv.DB, owner.project, owner.viewer, { key: "x", title: "X", body: "Text." })).toEqual({ ok: true });
    expect((await listSections(testEnv.DB)).map((s) => s.key)).toEqual(["analytics", "hosting", "x"]);
  });

  it("refuse a bad name, an empty text and a wide dash", async () => {
    const owner = await as("owner@test.invalid");
    for (const input of [
      { key: "Bad Name", title: "T", body: "B" },
      { key: "ok", title: "", body: "B" },
      { key: "ok", title: "T", body: "One — two." },
    ]) {
      expect((await saveSection(testEnv.DB, owner.project, owner.viewer, input)).ok).toBe(false);
    }
  });
});

describe("the Legal tab", () => {
  async function contextFor(email: string) {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env: connectedEnv(), ctx: {} as ExecutionContext });
    context.set(viewerContext, await viewerFor(email));
    context.set(nonceContext, "test-nonce");
    return context;
  }

  it("lists each legal page, says which are not set up, and flags a page behind the shared text", async () => {
    const site = fakeSite();
    const realFetch = globalThis.fetch;
    globalThis.fetch = site.fetch;
    try {
      await seed(site, "page.privacy", `${FRONT}<!-- shared:analytics -->\n`);
      // The shared text changes after the page was written to the site.
      await testEnv.DB.prepare("UPDATE legal_sections SET body = ? WHERE key = ?").bind("Newer wording.", "analytics").run();
      const data = (await legalLoader({ params: { project: SLUG }, context: await contextFor("owner@test.invalid"), request: new Request("https://carrel.test/p/de-info/legal") } as never)) as {
        pages: { type: string; setUp: boolean; behind?: boolean; shared?: string[] }[];
        canManage: boolean;
        sections: unknown[];
      };
      expect(data.pages.map((p) => [p.type, p.setUp])).toEqual([["privacy", true], ["terms", false]]);
      expect(data.pages[0]).toMatchObject({ behind: true, shared: ["analytics"] });
      expect(data.canManage).toBe(true);
      expect(data.sections).toHaveLength(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("changes a section only for the Owner, through the action", async () => {
    const body = new FormData();
    body.set("intent", "save-section");
    body.set("key", "hosting");
    body.set("title", "Hosting");
    body.set("body", "New text.");
    const request = () => new Request("https://carrel.test/p/de-info/legal", { method: "POST", body });
    const ok = await legalAction({ params: { project: SLUG }, context: await contextFor("owner@test.invalid"), request: request() } as never);
    expect(ok).toMatchObject({ saved: "hosting" });
    await expect(legalAction({ params: { project: SLUG }, context: await contextFor("editor@test.invalid"), request: request() } as never)).rejects.toMatchObject({ status: 403 });
  });
});
