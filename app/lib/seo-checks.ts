// The search and sharing checks on a post's text, and the link card it will make: the title a search
// result shows, the description under it, images in the body with no alt text, and a post with no card
// image. They flag; the writer decides. The one exception is alt text: an image without it blocks a
// publish (Dustin approved, 2026-10-31), so writeToSite refuses one and the editor's gate shows why.
// Pure, so the editor runs them as Dustin types and the MCP tools run the same code on a draft.
//
// The limits are Prelum's (@drdustinedwards/site-helpers/head), the numbers the sites' own head tags and
// site audit use, so a draft is held to what the published page is measured against. Prelum sets no
// floor for a description; DESCRIPTION_MIN is Carrel's.
//
// Each site names these fields differently, so SOCIAL_FIELDS holds one entry per site, as FIGURE_SITES in
// site-markdown.ts does: shared by the server and the browser. A site on site-api v0.17.0 lists the shared
// search fields it renders (capabilities.searchFields), and a listed one comes before the site's own key.
//
// Two faults in those fields block a publish, like alt text in the body (searchFieldRefusal): a share
// image with no alt text, and a canonical address that is not a full https one. Both are broken output,
// not judgment; a title or description too wide for a result only warns.

import {
  SERP_DESCRIPTION,
  SERP_TITLE,
  serpWidth,
  truncateForSerp,
} from "@drdustinedwards/site-helpers/head";
import { readKey, splitSource } from "@drdustinedwards/site-helpers/frontmatter";
import { imagesWithoutAlt, isAbsoluteHttps } from "@drdustinedwards/site-helpers/source";

export { imagesWithoutAlt };
import {
  missingAltFields,
  searchFieldsOf,
  type PostField,
  type SearchField,
} from "@dustinedwards/site-api/frontmatter";

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
  germomics: {
    title: ["seoTitle", "title"],
    description: ["seoDescription", "excerpt"],
    image: "coverImage",
  },
  // foxhound app/lib/carrel/source.ts: no image field.
  foxhound: { title: ["title"], description: ["excerpt"], image: null },
  // foxing apps/web/app/lib/carrel/journal-source.ts.
  foxing: { title: ["title"], description: ["excerpt"], image: "cover_image_url" },
};

const DEFAULT_FIELDS: SocialFields = {
  title: ["title"],
  description: ["description", "excerpt"],
  image: null,
};

type SeoFinding = {
  check: "title" | "description" | "image-alt" | "card-image" | "noindex" | SearchFault["field"];
  message: string;
  /** The words concerned, when there are any to quote. */
  excerpt: string | null;
  /** The source line, for an image in the body. */
  line: number | null;
};

/** What a shared link and a search result will show, as far as the post's own text decides it. */
type SocialPreview = {
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
    const block = new RegExp(`^${parent}:[ \\t]*\\r?\\n((?:[ \\t]+.*(?:\\r?\\n|$))*)`, "m").exec(
      front ?? "",
    );
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

/** The site's keys with the listed shared search fields put first. */
function withSearchFields(fields: SocialFields, listed: readonly SearchField[]): SocialFields {
  const before = (key: SearchField, keys: readonly string[]) =>
    listed.includes(key) ? [key, ...keys.filter((k) => k !== key)] : keys;
  return {
    ...fields,
    title: before("searchTitle", fields.title),
    cardTitle: fields.cardTitle ?? fields.title,
    description: before("description", fields.description),
    cardDescription: before("description", fields.cardDescription ?? fields.description),
  };
}

/** What the site adds after the title in a search result, for a width measured as the result shows it. */
/** The keys a site keeps its search and card title and description under. */
export const socialFieldsOf = (site: string): SocialFields => SOCIAL_FIELDS[site] ?? DEFAULT_FIELDS;

export const titleSuffixOf = (site: string): string => SOCIAL_FIELDS[site]?.titleSuffix ?? "";

const plural = (n: number) => `${n} character${n === 1 ? "" : "s"}`;

type SearchFault = { field: "imageAlt" | "canonical"; message: string };

/** The search fields' faults that block a publish, for the fields the site lists. */
export function searchFieldFaults(
  front: string | null,
  listed: readonly SearchField[],
): SearchFault[] {
  const values = searchFieldsOf(front);
  const faults: SearchFault[] = [];
  if (listed.includes("image") && values.image && !values.imageAlt) {
    faults.push({ field: "imageAlt", message: "The share image has no alt text" });
  }
  if (listed.includes("canonical") && values.canonical && !isAbsoluteHttps(values.canonical)) {
    faults.push({
      field: "canonical",
      message: `The canonical address is not a full https:// address: ${values.canonical}`,
    });
  }
  return faults;
}

/** The feature image's fault that blocks a publish where the site lists it: no alt text, and not marked decorative. */
export function featureImageFault(
  front: string | null,
  listed: readonly PostField[],
): string | null {
  return missingAltFields(front, { postFields: listed }).includes("featureImageAlt")
    ? "The feature image has no alt text"
    : null;
}

/** Why a publish is refused for the post fields, or null when they are sound. */
export function postFieldRefusal(source: string, listed: readonly PostField[]): string | null {
  const fault = featureImageFault(splitSource(source.replace(/\r\n/g, "\n")).front, listed);
  return fault
    ? `${fault}. Describe it, mark it decorative, or remove it before the post goes out.`
    : null;
}

/** Why a publish is refused for the search fields, or null when they are sound. */
export function searchFieldRefusal(source: string, listed: readonly SearchField[]): string | null {
  const faults = searchFieldFaults(splitSource(source.replace(/\r\n/g, "\n")).front, listed);
  return faults.length
    ? `Fix the search and sharing fields before the post goes out. ${faults.map((f) => `${f.message}.`).join(" ")}`
    : null;
}

/** Why a publish is refused for alt text, naming each image by its address and line; null when every image has alt text. */
export function missingAltRefusal(source: string): string | null {
  const images = imagesWithoutAlt(source);
  if (images.length === 0) return null;
  const named = images
    .map((image) => `${image.src || image.excerpt} (line ${image.line})`)
    .join("; ");
  return `Every image needs alt text before the post goes out. Describe what each of these shows: ${named}.`;
}

/**
 * The checks and the preview for a post's whole source on `site`, or null for anything that is not a post
 * (a legal page, another kind such as a recipe, a source with no frontmatter). A null `kind` is a post.
 * `origin` makes a site path absolute; `path` is the post's public path, which the site gives once it is published.
 * `searchFields` is what the site's capabilities list.
 */
export function seoCheck(
  site: string,
  source: string,
  page: {
    kind: string | null;
    origin: string | null;
    path: string | null;
    searchFields?: readonly SearchField[];
  },
): SeoCheck | null {
  const listed = page.searchFields ?? [];
  const fields = withSearchFields(SOCIAL_FIELDS[site] ?? DEFAULT_FIELDS, listed);
  const { front } = splitSource(source.replace(/\r\n/g, "\n"));
  if (front === null || (page.kind ?? "post") !== "post" || legalTypeOf(source) !== null)
    return null;
  const findings: SeoFinding[] = [];

  const title = first(front, fields.title);
  const fullTitle = title ? `${title}${fields.titleSuffix ?? ""}` : "";
  if (!title) {
    findings.push({
      check: "title",
      message: "No title: a search result has nothing to show for this post.",
      excerpt: null,
      line: null,
    });
  } else if (serpWidth(fullTitle, SERP_TITLE.font) > SERP_TITLE.px) {
    const added = fields.titleSuffix ? ` with the site's "${fields.titleSuffix.trim()}"` : "";
    findings.push({
      check: "title",
      message: `The search title is ${Math.round(serpWidth(fullTitle, SERP_TITLE.font))} px wide${added}; results clip at about ${SERP_TITLE.px} px.`,
      excerpt: fullTitle,
      line: null,
    });
  }

  const description = first(front, fields.description);
  if (!description) {
    findings.push({
      check: "description",
      message:
        "No description: a search engine writes its own from the page, and a link card shows none.",
      excerpt: null,
      line: null,
    });
  } else if (serpWidth(description, SERP_DESCRIPTION.font) > SERP_DESCRIPTION.px) {
    findings.push({
      check: "description",
      message: `The description is ${Math.round(serpWidth(description, SERP_DESCRIPTION.font))} px wide; results clip at about ${SERP_DESCRIPTION.px} px.`,
      excerpt: description,
      line: null,
    });
  } else if (description.length < DESCRIPTION_MIN) {
    findings.push({
      check: "description",
      message: `The description is ${plural(description.length)}, under ${DESCRIPTION_MIN}: too short to say what the post is.`,
      excerpt: description,
      line: null,
    });
  }

  for (const image of imagesWithoutAlt(source)) {
    findings.push({
      check: "image-alt",
      message:
        "An image with no alt text: a screen reader and a search engine get nothing from it.",
      excerpt: image.excerpt,
      line: image.line,
    });
  }

  const image =
    (listed.includes("image") ? value(front, "image") : "") ||
    (fields.image ? value(front, fields.image) : "");
  if ((fields.image || listed.includes("image")) && !image) {
    findings.push({
      check: "card-image",
      message: "No card image: a shared link shows the site's default image, or none.",
      excerpt: null,
      line: null,
    });
  }

  for (const fault of searchFieldFaults(front, listed))
    findings.push({ check: fault.field, message: fault.message, excerpt: null, line: null });
  if (listed.includes("noindex") && searchFieldsOf(front).noindex) {
    findings.push({
      check: "noindex",
      message: "Hidden from search: the post asks search engines to leave it out of their results.",
      excerpt: null,
      line: null,
    });
  }
  const canonical = listed.includes("canonical") ? value(front, "canonical") : "";

  const absolute = (url: string) =>
    url.startsWith("/") && page.origin ? `${page.origin.replace(/\/+$/, "")}${url}` : url;
  return {
    findings,
    preview: {
      search: {
        title: truncateForSerp(fullTitle, SERP_TITLE),
        description: truncateForSerp(description, SERP_DESCRIPTION),
      },
      card: {
        title: first(front, fields.cardTitle ?? fields.title),
        description: first(front, fields.cardDescription ?? fields.description),
        image: image ? absolute(image) : null,
      },
      host: page.origin ? new URL(page.origin).host : null,
      // A canonical of the post's own is the address a search result shows.
      url: canonical || (page.path && page.origin ? absolute(page.path) : null),
    },
  };
}
