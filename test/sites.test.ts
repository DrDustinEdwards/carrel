// Each site in the registry: listed, created by its migration, not connected until its key is set,
// and connected through the same code paths as the first site once it is. germomics is the second.

import { beforeEach, describe, expect, it } from "vitest";

import { nextProbe, runChecks } from "~/lib/health.server";
import { siteFigureMarkup } from "~/lib/site-markdown";
import { siteClient, siteOrigins } from "~/lib/sites.server";
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
    const results = await runChecks(
      germomicsEnv({ SITE_GERMOMICS_ORIGIN: "http://germomics.com" }),
      certsOk,
    );
    expect(results.find((r) => r.name === "site-germomics")).toMatchObject({
      ok: false,
      detail: "The origin for Germomics is not https.",
    });
  });

  it("is reached through the site client and its images load from its origin", async () => {
    const site = fakeSite();
    const client = siteClient(germomicsEnv(), "germomics", site.fetch);
    expect((await client.list({})).items).toEqual([]);
    expect(siteOrigins(germomicsEnv())).toContain(SITE_ORIGIN);
  });

  it("PLANT: a URL cannot end the figure's src attribute or the Markdown link", () => {
    const url = 'https://media.example.com/a b"(c)<d>.png';
    expect(siteFigureMarkup("dustinedwards", url, "A figure")).toBe(
      ':::figure{src="https://media.example.com/a%20b%22%28c%29%3Cd%3E.png" alt="A figure"}\n:::',
    );
    expect(siteFigureMarkup("unknown-site", url, "A figure")).toBe(
      "![A figure](https://media.example.com/a%20b%22%28c%29%3Cd%3E.png)",
    );
    expect(siteFigureMarkup("dustinedwards", "https://media.example.com/plain.png", "x")).toContain(
      'src="https://media.example.com/plain.png"',
    );
  });
});

describe("the probe post", () => {
  const key = "k".repeat(32);
  const env = {
    ...testEnv,
    SITE_GERMOMICS_ORIGIN: "https://germomics.example.com",
    SITE_GERMOMICS_KEY: key,
    SITE_FOXING_ORIGIN: "https://foxing.example.com",
    SITE_FOXING_KEY: key,
  } as Env;
  const now = new Date("2026-11-22T09:00:00Z");
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

  it("probes one site per run: the never probed first, then the oldest due, a failing one after an hour", () => {
    expect(nextProbe(env, null, now)?.id).toBe("germomics");
    const record = (germomics: [number, boolean], foxing: [number, boolean]) => ({
      sites: {
        "https://germomics.example.com": {
          at: ago(germomics[0]),
          findings: germomics[1] ? [{} as never] : [],
        },
        "https://foxing.example.com": {
          at: ago(foxing[0]),
          findings: foxing[1] ? [{} as never] : [],
        },
      },
    });
    expect(nextProbe(env, record([2, false], [30, false]), now)?.id).toBe("foxing");
    expect(nextProbe(env, record([30, false], [26, false]), now)?.id).toBe("germomics");
    expect(nextProbe(env, record([2, false], [2, false]), now)).toBeUndefined();
    expect(nextProbe(env, record([2, true], [2, false]), now)?.id).toBe("germomics");
  });
});
