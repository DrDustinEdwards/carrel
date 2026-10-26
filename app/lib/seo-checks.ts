// The search and sharing checks on a post's text, and the link card it will make: the title a search
// result shows, the description under it, images in the body with no alt text, and a post with no card
// image. They flag; the writer decides, and nothing here holds a save or a publish. Pure, so the editor
// runs them as Dustin types and the MCP tools run the same code on a draft.
//
// The limits are Prelum's (@drdustinedwards/site-helpers/head), the numbers the sites' own head tags and
// site audit use, so a draft is held to what the published page is measured against. Prelum sets no
// floor for a description; DESCRIPTION_MIN is Carrel's.
//
// Each site names these fields differently, so SOCIAL_FIELDS holds one entry per site, as FIGURES in
// site-markdown.ts does: shared by the server and the browser.

import { SERP_DESCRIPTION_LIMIT, SERP_TITLE_LIMIT, truncateForSerp } from "@drdustinedwards/site-helpers/head";
import { readKey, splitSource } from "@dustinedwards/site-api/frontmatter";

import { legalTypeOf } from "~/lib/legal";

/** Under this many characters a description says too little for a result to show it; a search engine writes its own. */
const DESCRIPTION_MIN = 50;

type SocialFields = {
  /** The keys the search title is read from, the first with a value winning. */
  title: readonly string[];
  /** What the site adds to the title in a search result, in its own words. */
  titleSuffix?: string;
  /** The keys of the title on a link card; the search title's keys when absent. */
  cardTitle?: readonly string[];
  description: readonly string[];
  cardDescription?: readonly string[];
  /** The card image's key (`cover.src` is `src` under `cover:`); null for a site with no per-post image. */
  image: string | null;
};

const SOCIAL_FIELDS: Record<string, SocialFields> = {
  // dustinedwards-info app/lib/seo.ts postSocial: the page title is "<title> | Dustin Edwards", the card
  // takes og_title and og_description over them, and the image is the cover, else the site mark.
  dustinedwards: {
    title: ["title"],
    titleSuffix: " | Dustin Edwards",
    cardTitle: ["og_title", "title"],
    description: ["description"],
    cardDescription: ["og_description", "description"],
    image: "cover.src",
  },
  // germomics app/lib/carrel/source.ts: seoTitle and seoDescription over title and excerpt.
  germomics: { title: ["seoTitle", "title"], description: ["seoDescription", "excerpt"], image: "coverImage" },
  // foxhound app/lib/carrel/source.ts: no image field.
  foxhound: { title: ["title"], description: ["excerpt"], image: null },
  // foxing apps/web/app/lib/carrel/journal-source.ts.
  foxing: { title: ["title"], description: ["excerpt"], image: "cover_image_url" },
};

const DEFAULT_FIELDS: SocialFields = { title: ["title"], description: ["description", "excerpt"], image: null };

export type SeoFinding = {
  check: "title" | "description" | "image-alt" | "card-image";
  message: string;
  /** The words concerned, when there are any to quote. */
  excerpt: string | null;
  /** The source line, for an image in the body. */
  line: number | null;
};

/** What a shared link and a search result will show, as far as the post's own text decides it. */
export type SocialPreview = {
  /** The search result's title and description, cut where a result clips them. */
  search: { title: string; description: string };
  card: { title: string; description: string; image: string | null };
  /** The site's host name, for a preview with no address yet. */
  host: string | null;
  /** The address the site publishes the post at; null until it has one. */
  url: string | null;
};

export type SeoCheck = { findings: SeoFinding[]; preview: SocialPreview };

/** A JSON-source site writes `null` for an empty field. */
function value(front: string | null, key: string): string {
  const [parent, child] = key.split(".");
  let raw: string;
  if (child) {
    // A nested key: `child:` indented under `parent:`, as dustinedwards.info writes its cover.
    const block = new RegExp(`^${parent}:[ \\t]*\\r?\\n((?:[ \\t]+.*(?:\\r?\\n|$))*)`, "m").exec(front ?? "");
    const line = block?.[1]!.split(/\r?\n/).find((l) => new RegExp(`^\\s+${child}:`).test(l));
    raw = line ? readKey(line.trim(), child) : "";
  } else {
    raw = readKey(front, key);
  }
  const v = raw.trim();
  return v === "null" || v === "~" ? "" : v;
}

function first(front: string | null, keys: readonly string[]): string {
  for (const key of keys) {
    const v = value(front, key);
    if (v) return v;
  }
  return "";
}

const plural = (n: number) => `${n} character${n === 1 ? "" : "s"}`;

/** Each image in a body with no alt text, or an empty one: Markdown, HTML and a `:::figure` directive. Code is skipped. */
function imagesWithoutAlt(source: string): { excerpt: string; line: number }[] {
  const text = source.replace(/\r\n/g, "\n");
  const { body } = splitSource(text);
  const startLine = text.slice(0, text.length - body.length).split("\n").length;
  const found: { excerpt: string; line: number }[] = [];
  let fence: string | null = null;
  body.split("\n").forEach((raw, i) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (marker && (fence === null || marker[0] === fence[0])) {
      fence = fence === null ? marker : null;
      return;
    }
    if (fence !== null) return;
    const line = raw.replace(/`[^`]*`/g, "");
    for (const m of line.matchAll(/!\[([^\]]*)\](\([^)]*\)|\[[^\]]*\])/g)) {
      if (!m[1]!.trim()) found.push({ excerpt: m[0], line: startLine + i });
    }
    for (const m of line.matchAll(/<img\b[^>]*>/gi)) {
      const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[0]);
      if (!alt || !(alt[1] ?? alt[2] ?? alt[3] ?? "").trim()) found.push({ excerpt: m[0], line: startLine + i });
    }
    for (const m of line.matchAll(/^\s*:{2,}figure\{([^}]*)\}/g)) {
      const alt = /\balt\s*=\s*"([^"]*)"/.exec(m[1]!);
      if (!alt || !alt[1]!.trim()) found.push({ excerpt: m[0].trim(), line: startLine + i });
    }
  });
  return found;
}

/**
 * The checks and the preview for a post's whole source on `site`, or null for anything that is not a post
 * (a legal page, another kind such as a phage, a source with no frontmatter). A null `kind` is a post.
 * `origin` makes a site path absolute; `path` is the post's public path, which the site gives once it is published.
 */
export function seoCheck(site: string, source: string, page: { kind: string | null; origin: string | null; path: string | null }): SeoCheck | null {
  const fields = SOCIAL_FIELDS[site] ?? DEFAULT_FIELDS;
  const { front } = splitSource(source.replace(/\r\n/g, "\n"));
  if (front === null || (page.kind ?? "post") !== "post" || legalTypeOf(source) !== null) return null;
  const findings: SeoFinding[] = [];

  const title = first(front, fields.title);
  const fullTitle = title ? `${title}${fields.titleSuffix ?? ""}` : "";
  if (!title) {
    findings.push({ check: "title", message: "No title: a search result has nothing to show for this post.", excerpt: null, line: null });
  } else if (fullTitle.length > SERP_TITLE_LIMIT) {
    const added = fields.titleSuffix ? ` with the site's "${fields.titleSuffix.trim()}"` : "";
    findings.push({
      check: "title",
      message: `The search title is ${plural(fullTitle.length)}${added}; results clip at about ${SERP_TITLE_LIMIT}.`,
      excerpt: fullTitle,
      line: null,
    });
  }

  const description = first(front, fields.description);
  if (!description) {
    findings.push({ check: "description", message: "No description: a search engine writes its own from the page, and a link card shows none.", excerpt: null, line: null });
  } else if (description.length > SERP_DESCRIPTION_LIMIT) {
    findings.push({ check: "description", message: `The description is ${plural(description.length)}; results clip at about ${SERP_DESCRIPTION_LIMIT}.`, excerpt: description, line: null });
  } else if (description.length < DESCRIPTION_MIN) {
    findings.push({ check: "description", message: `The description is ${plural(description.length)}, under ${DESCRIPTION_MIN}: too short to say what the post is.`, excerpt: description, line: null });
  }

  for (const image of imagesWithoutAlt(source)) {
    findings.push({ check: "image-alt", message: "An image with no alt text: a screen reader and a search engine get nothing from it.", excerpt: image.excerpt, line: image.line });
  }

  const image = fields.image ? value(front, fields.image) : "";
  if (fields.image && !image) {
    findings.push({ check: "card-image", message: "No card image: a shared link shows the site's default image, or none.", excerpt: null, line: null });
  }

  const absolute = (url: string) => (url.startsWith("/") && page.origin ? `${page.origin.replace(/\/+$/, "")}${url}` : url);
  return {
    findings,
    preview: {
      search: { title: truncateForSerp(fullTitle, SERP_TITLE_LIMIT), description: truncateForSerp(description, SERP_DESCRIPTION_LIMIT) },
      card: {
        title: first(front, fields.cardTitle ?? fields.title),
        description: first(front, fields.cardDescription ?? fields.description),
        image: image ? absolute(image) : null,
      },
      host: page.origin ? new URL(page.origin).host : null,
      url: page.path && page.origin ? absolute(page.path) : null,
    },
  };
}
