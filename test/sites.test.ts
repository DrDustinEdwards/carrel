// Each site in the registry: listed, created by its migration, not connected until its key is set,
// and connected through the same code paths as the first site once it is. germomics is the second.

import { beforeEach, describe, expect, it } from "vitest";

import { propertyFor } from "~/lib/google/search-console.server";
import { runChecks } from "~/lib/health.server";
import { figureMarkup } from "~/lib/site-markdown";
import { SITE_IDS, siteClient, siteConnection, siteEntry, siteOrigins } from "~/lib/sites.server";
import { addPerson, resetDb, testEnv } from "./env";
import { fakeSite, SITE_KEY, SITE_ORIGIN } from "./site";

const certsOk = async () => Response.json({ keys: [{ kid: "k" }] });

/** germomics connected at the fake site's origin, which is the only host the tests reach. */
const germomicsEnv = (overrides: Partial<Env> = {}): Env => ({
  ...testEnv,
  SITE_GERMOMICS_ORIGIN: SITE_ORIGIN,
  SITE_GERMOMICS_KEY: SITE_KEY,
  ...overrides,
});

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
});

describe("germomics", () => {
  it("is listed, with the origin var and key the deploy sets", () => {
    expect(SITE_IDS).toEqual(["dustinedwards", "germomics"]);
    expect(siteEntry("germomics")).toMatchObject({ name: "Germomics", keyName: "SITE_GERMOMICS_KEY", keepPublic: [] });
    expect(siteEntry("germomics").origin({ ...testEnv, SITE_GERMOMICS_ORIGIN: "https://germomics.com" })).toBe("https://germomics.com");
  });

  it("gets its project from migration 0014, held by the Owner alone", async () => {
    const migration = testEnv.TEST_D1_MIGRATIONS.find((m) => m.name.startsWith("0014_"));
    expect(migration?.name).toBe("0014_germomics.sql");
    for (const query of migration!.queries) await testEnv.DB.prepare(query).run();
    const rows = await testEnv.DB.prepare("SELECT slug, name, site FROM projects WHERE site = 'germomics'").all();
    expect(rows.results).toEqual([{ slug: "germomics", name: "Germomics", site: "germomics" }]);
    const members = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM project_members").first<{ n: number }>();
    expect(members?.n).toBe(0);
  });

  it("is not connected without a key, which the health check does not count as a failure", async () => {
    const env = { ...testEnv, SITE_GERMOMICS_ORIGIN: "https://germomics.com", SITE_GERMOMICS_KEY: undefined };
    expect(siteConnection(env, "germomics")).toEqual({ state: "not-connected", detail: "No SITE_GERMOMICS_KEY set." });
    const results = await runChecks(env, certsOk);
    expect(results.find((r) => r.name === "site-germomics")).toEqual({
      name: "site-germomics",
      ok: true,
      detail: "Not connected: No SITE_GERMOMICS_KEY set.",
    });
  });

  it("PLANT: flags a key without an https origin", async () => {
    const results = await runChecks(germomicsEnv({ SITE_GERMOMICS_ORIGIN: "http://germomics.com" }), certsOk);
    expect(results.find((r) => r.name === "site-germomics")).toMatchObject({ ok: false, detail: "The origin for Germomics is not https." });
  });

  it("connected, conforms in the health check, and its probe changes nothing on the site", async () => {
    const site = fakeSite();
    const fetcher = async (url: string, init?: RequestInit) => (url.startsWith(SITE_ORIGIN) ? site.fetch(url, init) : certsOk());
    const results = await runChecks(germomicsEnv(), fetcher);
    expect(results.find((r) => r.name === "site-germomics")).toMatchObject({ ok: true, detail: expect.stringMatching(/^Germomics conforms/) });
    expect(site.requests.some((r) => r.startsWith("GET /api/carrel/v1/meta"))).toBe(true);
    expect(site.adapter.store.size).toBe(0);
  });

  it("is reached through the site client and its images load from its origin", async () => {
    const site = fakeSite();
    const client = siteClient(germomicsEnv(), "germomics", site.fetch);
    expect((await client.list({})).items).toEqual([]);
    expect(siteOrigins(germomicsEnv())).toContain(SITE_ORIGIN);
  });

  it("starts a new article in the site's own source shape: JSON front matter, then an HTML body", () => {
    expect(siteEntry("germomics").newSource("a-slug", "2026-10-10")).toBe('---\ntitle: ""\nexcerpt: ""\ntags: []\n---\n');
  });

  it("places an image as HTML the site's sanitizer keeps, with the alt text escaped", () => {
    expect(figureMarkup("germomics", "https://images.germomics.com/carrel/a.png", ' A "quoted" <alt> & more ')).toBe(
      '<figure><img src="https://images.germomics.com/carrel/a.png" alt="A &quot;quoted&quot; &lt;alt&gt; &amp; more"></figure>',
    );
  });

  it("reads its own Search Console property", () => {
    expect(propertyFor(testEnv, "germomics")).toBe("sc-domain:germomics.com");
    expect(propertyFor({ ...testEnv, SEARCH_CONSOLE_PROPERTY_DUSTINEDWARDS: "" }, "dustinedwards")).toBe("sc-domain:dustinedwards.info");
  });
});
