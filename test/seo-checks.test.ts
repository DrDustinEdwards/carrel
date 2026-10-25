// The search and sharing checks: each has a planted problem that must be flagged and a clean twin that
// must not. The limits are Prelum's, tested there; these hold Carrel's reading of each site's fields and
// of the three ways a body places an image.

import { describe, expect, it } from "vitest";

import { seoCheck } from "~/lib/seo-checks";

const PAGE = { kind: "post", origin: "https://site.test", path: "/writing/pump" };
const DESCRIPTION = "How a map of one London street traced a cholera outbreak to a single water pump in 1854.";

describe("the search and sharing checks", () => {
  it("PLANT: flags a long search title, a short description, images with no alt and no card image", () => {
    const source = [
      "---",
      // 46 characters, past 60 with the site's " | Dustin Edwards".
      'title: "Giving an AI agent write access to a live site"',
      'description: "Too short."',
      "---",
      "![](/media/a.png)",
      '<img src="/media/b.png">',
      ':::figure{src="/media/c.png" alt=""}',
      ":::",
      "```md",
      "![](/media/in-code.png)",
      "```",
    ].join("\n");
    const check = seoCheck("dustinedwards", source, PAGE)!;
    expect(check.findings.map((f) => [f.check, f.line])).toEqual([
      ["title", null],
      ["description", null],
      ["image-alt", 5],
      ["image-alt", 6],
      ["image-alt", 7],
      ["card-image", null],
    ]);
    expect(check.findings[0]!.excerpt).toBe("Giving an AI agent write access to a live site | Dustin Edwards");
    expect(check.preview.card.image).toBeNull();
  });

  it("TWIN: passes a post that fits, and previews its card from the site's own fields", () => {
    const source = [
      "---",
      'title: "The Broad Street pump"',
      `description: ${JSON.stringify(DESCRIPTION)}`,
      'og_title: "One pump, one street, 1854"',
      "cover:",
      "  src: /media/pump.webp",
      '  alt: "The pump on Broad Street"',
      "---",
      "![The pump today](/media/today.webp)",
      ':::figure{src="/media/map.png" alt="Snow\'s map"}',
      ":::",
    ].join("\n");
    expect(seoCheck("dustinedwards", source, PAGE)).toEqual({
      findings: [],
      preview: {
        search: { title: "The Broad Street pump | Dustin Edwards", description: DESCRIPTION },
        card: { title: "One pump, one street, 1854", description: DESCRIPTION, image: "https://site.test/media/pump.webp" },
        host: "site.test",
        url: "https://site.test/writing/pump",
      },
    });
  });

  it("reads a JSON-source site's null as empty, and checks only a post", () => {
    const foxing = ["---", 'title: ""', "excerpt: null", "cover_image_url: null", "---", ""].join("\n");
    expect(seoCheck("foxing", foxing, PAGE)!.findings.map((f) => f.check)).toEqual(["title", "description", "card-image"]);
    // Foxhound has no per-post image, so there is nothing to flag for it.
    expect(seoCheck("foxhound", `---\ntitle: "A title"\nexcerpt: ${JSON.stringify(DESCRIPTION)}\n---\n`, PAGE)!.findings).toEqual([]);
    expect(seoCheck("dustinedwards", "---\ntitle: x\n---\n", { ...PAGE, kind: "phage" })).toBeNull();
    expect(seoCheck("dustinedwards", "---\nlegal_type: privacy\ntitle: x\n---\n", PAGE)).toBeNull();
  });
});
