// Each site in the registry: listed, created by its migration, not connected until its key is set,
// and connected through the same code paths as the first site once it is. germomics is the second.

import { beforeEach, describe, expect, it } from "vitest";

import { runChecks } from "~/lib/health.server";
import { figureMarkup } from "~/lib/site-markdown";
import { siteClient, siteEntry, siteOrigins } from "~/lib/sites.server";
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
  it("PLANT: flags a key without an https origin", async () => {
    const results = await runChecks(germomicsEnv({ SITE_GERMOMICS_ORIGIN: "http://germomics.com" }), certsOk);
    expect(results.find((r) => r.name === "site-germomics")).toMatchObject({ ok: false, detail: "The origin for Germomics is not https." });
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

  it("PLANT: a URL cannot end the figure's src attribute or the Markdown link", () => {
    const url = 'https://media.example.com/a b"(c)<d>.png';
    expect(figureMarkup("dustinedwards", url, "A figure")).toBe(
      ':::figure{src="https://media.example.com/a%20b%22%28c%29%3Cd%3E.png" alt="A figure"}\n:::',
    );
    expect(figureMarkup("unknown-site", url, "A figure")).toBe("![A figure](https://media.example.com/a%20b%22%28c%29%3Cd%3E.png)");
    expect(figureMarkup("dustinedwards", "https://media.example.com/plain.png", "x")).toContain('src="https://media.example.com/plain.png"');
  });

});
