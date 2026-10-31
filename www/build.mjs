// Builds Carrel's public site at https://carrel.dustinedwards.info into www/dist (or the directory named): one page
// saying what Carrel is, in the NASA manual theme the family's public sites share (Capsomer's manual.css) in Carrel's
// olive, and the family footer. Static files only; the one script is Capsomer's theme switch, served as files from this
// origin (/theme.js before first paint, /site.js for the letterhead's theme button). The writing app itself is Desk, at
// https://desk.dustinedwards.info, behind Cloudflare Access; nothing here reaches it.
//
//   node www/build.mjs [outDir]

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { defineHead, headHtml } from "@drdustinedwards/site-helpers/head";
import { iconLinks, webManifest } from "@drdustinedwards/site-helpers/icons";
import { llmsDocument } from "@drdustinedwards/site-helpers/llms";
import { aiTxt, robotsDocument } from "@drdustinedwards/site-helpers/robots";
import { graph, jsonLd, thing, website } from "@drdustinedwards/site-helpers/schema";
import { sitemapDocument } from "@drdustinedwards/site-helpers/sitemap";
import { integrityHash } from "@dustinedwards/site-runtime/csp";
import { escapeHtml as esc } from "@dustinedwards/site-runtime/html";
import { securityTxt } from "@dustinedwards/site-runtime/security-txt";
import { familyFooterHtml } from "capsomer/behavior/family-footer";
import { patchSvg } from "capsomer/behavior/manual";
import { letterheadHtml } from "capsomer/behavior/site-header";
import { build } from "vite";

import { PAGE_PRELOADS } from "./headers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const ORIGIN = "https://carrel.dustinedwards.info";
const DESK = "https://desk.dustinedwards.info";
const REPO = "https://github.com/DrDustinEdwards/carrel";
const FAMILY = "olive";

/** When security.txt lapses (RFC 9116 asks for under a year); renew it before then, with the AI door's (workers/app.ts). */
const SECURITY_TXT_EXPIRES = "2027-10-26T00:00:00Z";

const CONTACT = "security@dustinedwards.info";

/**
 * The IndexNow key, served as /<key>.txt; www.yml reads it from this line for prelum-indexnow after each deploy. A key
 * is public by design: it only proves the pinging site owns the origin.
 */
const INDEXNOW_KEY = "00d4cd444d72b3dbef372abe5f4cc447";
const TITLE = "Carrel: one desk for everything you write";
const DESCRIPTION =
  "Carrel is an open-source writing app on Cloudflare: publish posts to several websites from one place, keep books in Git, and work with AI that drafts beside you.";

/**
 * Capsomer's stylesheets import their parts; the site serves one file, so each import is read in place, wrapped in its
 * layer when it names one.
 *
 * @param {string} file
 * @returns {string}
 */
function inlineCss(file) {
  return readFileSync(file, "utf8").replace(/@import\s+"([^"]+)"(?:\s+layer\(([\w.-]+)\))?\s*;/g, (_, path, layer) => {
    const inner = inlineCss(join(dirname(file), path));
    return layer ? `@layer ${layer} {\n${inner}\n}` : inner;
  });
}

/** Source Serif 4, the one face Capsomer's fonts.css leaves to @fontsource (latin only: the site is in English). */
const SERIF = "@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2";

/** @param {string} outDir */
function writeStyles(outDir) {
  const capsomer = dirname(require.resolve("capsomer/package.json"));
  const base = join(capsomer, "css/base.css");
  // Capsomer's font files sit beside site.css, so its fonts.css loads them as fonts/.
  cpSync(join(capsomer, "fonts"), join(outDir, "fonts"), { recursive: true });
  const serif = SERIF.split("/").pop() ?? "";
  copyFileSync(require.resolve(SERIF), join(outDir, "fonts", serif));
  const css = [
    "/* Built by www/build.mjs: Capsomer's fonts, tokens, base, Carrel's family, the manual theme and the family footer, then www/site.css. */",
    inlineCss(join(capsomer, "css", "fonts.css")).replaceAll('url("../fonts/', 'url("fonts/'),
    `@font-face {\n  font-family: "Source Serif 4";\n  font-style: normal;\n  font-weight: 200 900;\n  font-display: swap;\n  src: url("fonts/${serif}") format("woff2");\n}`,
    inlineCss(join(capsomer, "css", "tokens.css")),
    inlineCss(base),
    `@layer cap.tokens {\n${inlineCss(join(capsomer, "tokens", `family-${FAMILY}.css`))}\n}`,
    inlineCss(join(capsomer, "components", "manual", "manual.css")),
    inlineCss(join(capsomer, "components", "family-footer", "family-footer.css")),
    // The theme button's tip (the popover's tooltip form) and the button itself, then the family letterhead at the top
    // of every page, pinned while it scrolls.
    inlineCss(join(capsomer, "components", "popover", "popover.css")),
    inlineCss(join(capsomer, "components", "theme-switch", "theme-switch.css")),
    inlineCss(join(capsomer, "components", "site-header", "site-header.css")),
    readFileSync(join(HERE, "site.css"), "utf8"),
  ].join("\n\n");
  writeFileSync(join(outDir, "site.css"), css);
}

/** The sites Carrel publishes to on Dustin's Desk (app/lib/sites.server.ts). */
const SITES = ["dustinedwards.info", "Germomics", "Foxhound", "Foxing", "Texas Branch ASM", "julieedwards.info"];
/** The tools Carrel's MCP server gives an AI client (app/lib/mcp/tools.ts). */
const TOOL_COUNT = 16;

/** A feature with no section of its own on the page has no href and shows its name unlinked. @param {{ name: string, href?: string, kind: string, note: string }} item */
const checklistItem = ({ name, href, kind, note }) =>
  `<li class="cap-checklist-item"><div class="cap-checklist-line">${href ? `<a href="${href}">${esc(name)}</a>` : `<strong>${esc(name)}</strong>`}<span class="cap-checklist-dots" aria-hidden="true"></span><span class="cap-checklist-kind">${esc(kind)}</span></div><p class="cap-checklist-note">${esc(note)}</p></li>`;

const FEATURES = [
  { name: "Every post on every site", href: "#path", kind: "Sites", note: "Each site's posts in one list, with search and filters. Write in a prose editor that saves as you type, and preview in the site's own design." },
  { name: "Books in Git", kind: "Books", note: "Chapters, scenes, outlines and the story bible in a private Git repository. Export to ePub and Word, or print to PDF." },
  { name: "Checks that flag", href: "#checks", kind: "Checks", note: "Search and sharing checks on every post; continuity, timeline and voice checks on every scene. They flag. You decide." },
  { name: "AI drafts beside yours", href: "#ai", kind: "AI", note: `${TOOL_COUNT} tools for Claude and other MCP clients: read, search, preview, draft and flag. An AI draft never replaces your text.` },
  { name: "Who wrote what", href: "#ai", kind: "Record", note: "Every change is recorded as yours or an AI's, and a book's record exports as a report." },
  { name: "Manuscripts in Google Drive", kind: "Drive", note: "An index and search of your manuscripts, read-only, with Send to Docs and Import." },
];

/** A post's way from draft to live, as the Apollo flight plan's time line. */
const PATH = [
  ["Draft", "You write in the editor. Every keystroke is saved to the database, and saving never publishes."],
  ["Check", "The search title, description, image alt text and share card are checked as you type."],
  ["Preview", "The site renders the post itself, in a sandbox, so you see what readers will see."],
  ["Publish", "The Owner publishes; an Author publishes the posts they wrote. Editors write and save; Readers read and comment."],
  ["Announce", "Once a post is live, a queued note can go out to your social accounts."],
];

const page = () => {
  const patch = patchSvg({ id: "carrel", name: "Carrel", foot: "Writing desk", count: SITES.length, unit: "sites" });
  const center = `<div class="cap-family-footer-center">
<div><p class="cap-family-footer-center-name">Carrel</p><p class="cap-family-footer-about">An open-source writing app for posts across several websites and for books. You run it on Cloudflare; this page is its public front.</p></div>
<div class="cap-family-footer-columns">
<ul class="cap-family-footer-links"><li><a href="#what">What it does</a></li><li><a href="#path">From draft to live</a></li><li><a href="#ai">AI that stays beside you</a></li><li><a href="#run">Run your own</a></li></ul>
<ul class="cap-family-footer-links"><li><a href="${REPO}">Source, MIT licensed</a></li><li><a href="${REPO}#develop">Install it</a></li></ul>
</div>
<p class="cap-family-footer-stamp"><span>Publishing to ${SITES.length} sites</span></p>
</div>`;
  return `<main id="main" tabindex="-1">
<header class="hero">
<div class="hero-text">
<h1>One desk for everything you write.</h1>
<p class="hero-lead">Carrel is an open-source writing app you run on Cloudflare. Write and publish posts for several websites from one place, keep your books in a Git repository, and work with AI that drafts beside you and never over you.</p>
<nav class="cap-signs" aria-label="Get started"><a class="cap-sign" data-variant="forward" href="${REPO}">Get the code</a><a class="cap-sign" href="${DESK}" rel="nofollow">Sign in to Desk</a></nav>
<p class="hero-note">Desk is the signed-in app, where you write. This instance is Dustin Edwards's; to use Carrel, run your own.</p>
</div>
<section class="cap-cue hero-card" aria-labelledby="cue-title">
<p class="cap-cue-strip"><span>Post · Checks</span><span>As you type</span></p>
<h2 class="cap-cue-title" id="cue-title">How AI changed peer review</h2>
<ul class="cap-cue-lines">
<li><span class="cap-cue-name">Search title</span><span class="cap-cue-value">64 of 60 characters</span></li>
<li><span class="cap-cue-name">Description</span><span class="cap-cue-value">142 of 155</span></li>
<li><span class="cap-cue-name">Image alt text</span><span class="cap-cue-value">1 image has none</span></li>
<li><span class="cap-cue-name">Share card</span><span class="cap-cue-value">Set</span></li>
</ul>
<p class="hero-card-note">An example post. Two flags, and Publish still works: checks flag, the writer decides.</p>
</section>
</header>

<dl class="cap-form-boxes" data-variant="readings">
<div class="cap-form-boxes-box"><dt>Sites on this Desk</dt><dd>${SITES.length}</dd></div>
<div class="cap-form-boxes-box"><dt>Roles</dt><dd>3</dd></div>
<div class="cap-form-boxes-box"><dt>AI tools</dt><dd>${TOOL_COUNT}</dd></div>
<div class="cap-form-boxes-box"><dt>License</dt><dd>MIT</dd></div>
</dl>

<section class="cap-part" id="what" aria-labelledby="what-title">
<h2 class="cap-part-title" id="what-title"><span class="cap-part-no">1.1</span>What it does</h2>
<p class="cap-part-lead">A carrel is a library study desk. Carrel is one place to write for every site you run and every book you are working on.</p>
<section class="cap-checklist" aria-label="What Carrel does">
<p class="cap-checklist-strip" aria-hidden="true"><span>Carrel · Features</span><span>${FEATURES.length} cards</span></p>
<ol class="cap-checklist-items">
${FEATURES.map(checklistItem).join("\n")}
</ol>
</section>
</section>

<section class="cap-part" id="path" aria-labelledby="path-title">
<h2 class="cap-part-title" id="path-title"><span class="cap-part-no">1.2</span>From draft to live</h2>
<p class="cap-part-lead">Each site keeps its own content and design. Carrel reaches it through one shared API, so a post looks the same in the preview as on the site.</p>
<ol class="cap-timeline">
${PATH.map(([mark, text], i) => `<li><span class="cap-timeline-mark">${i + 1}</span><div class="cap-timeline-body"><p><b>${esc(mark)}.</b> ${esc(text)}</p></div></li>`).join("\n")}
</ol>
</section>

<section class="cap-part" id="checks" aria-labelledby="checks-title">
<h2 class="cap-part-title" id="checks-title"><span class="cap-part-no">1.3</span>Checks that flag</h2>
<p class="cap-part-lead">A check points at a problem and leaves the choice to you. Nothing holds a save.</p>
<dl class="cap-form-boxes">
<div class="cap-form-boxes-box"><dt>Search title</dt><dd>Empty or over 60 characters</dd></div>
<div class="cap-form-boxes-box"><dt>Description</dt><dd>Missing, under 50 or over 155 characters</dd></div>
<div class="cap-form-boxes-box"><dt>Images</dt><dd>No alt text, or no share card</dd></div>
<div class="cap-form-boxes-box"><dt>Scenes</dt><dd>Continuity, timeline and world rules against the story bible</dd></div>
<div class="cap-form-boxes-box" data-span="2"><dt>Voice</dt><dd>Habits of AI-written text, measured against your own published writing</dd></div>
<div class="cap-form-boxes-box" data-span="2"><dt>Sources</dt><dd>Names and numbers with no source behind them</dd></div>
</dl>
</section>

<section class="cap-part" id="ai" aria-labelledby="ai-title">
<h2 class="cap-part-title" id="ai-title"><span class="cap-part-no">1.4</span>AI that stays beside you</h2>
<p class="cap-part-lead">Connect Claude or any MCP client. It can read, search, preview and draft, under the same roles as a person.</p>
<div class="rules">
<p><b>Your prose is yours.</b> An AI never rewrites your text unless you ask. Its draft is saved next to yours, and you choose what to use.</p>
<p><b>Flags, not verdicts.</b> AI reviewers and checks raise flags. A post with an open flag cannot be published by an AI.</p>
<p><b>Publishing is yours.</b> An AI publishes only when the Owner tells it to in that session, and every publish is emailed with a link to undo it.</p>
<p><b>A record of who wrote what.</b> Each change is marked as yours or an AI's, kept with the book.</p>
</div>
</section>

<section class="cap-part" id="run" aria-labelledby="run-title">
<h2 class="cap-part-title" id="run-title"><span class="cap-part-no">1.5</span>Run your own</h2>
<p class="cap-part-lead">Carrel is one Cloudflare Worker with a D1 database, behind Cloudflare Access. Each site connects through <a href="https://github.com/DrDustinEdwards/site-api">site-api</a>.</p>
<div class="run">
<ol class="cap-leader-index">
<li><span class="cap-leader-index-link"><span class="cap-leader-index-no">1</span><span class="cap-leader-index-name">Create the database and add yourself as Owner</span><span class="cap-leader-index-dots" aria-hidden="true"></span><span class="cap-leader-index-fact">D1</span></span></li>
<li><span class="cap-leader-index-link"><span class="cap-leader-index-no">2</span><span class="cap-leader-index-name">Deploy with no public address</span><span class="cap-leader-index-dots" aria-hidden="true"></span><span class="cap-leader-index-fact">Workers</span></span></li>
<li><span class="cap-leader-index-link"><span class="cap-leader-index-no">3</span><span class="cap-leader-index-name">Turn on Access for the Worker</span><span class="cap-leader-index-dots" aria-hidden="true"></span><span class="cap-leader-index-fact">Access</span></span></li>
<li><span class="cap-leader-index-link"><span class="cap-leader-index-no">4</span><span class="cap-leader-index-name">Add your domain and connect your sites</span><span class="cap-leader-index-dots" aria-hidden="true"></span><span class="cap-leader-index-fact">site-api</span></span></li>
</ol>
<figure class="patch">${patch}<figcaption>This Desk publishes to ${SITES.length} sites: ${esc(SITES.join(", "))}.</figcaption></figure>
</div>
<nav class="cap-signs" aria-label="Install"><a class="cap-sign" rel="next" href="${REPO}#develop">The steps on GitHub</a></nav>
</section>
</main>
<footer>${familyFooterHtml({ site: "carrel", center })}</footer>`;
};

/** The share card: the top of the page at 1200 by 630. */
const CARD = { url: "/og-card.png", width: 1200, height: 630, alt: "Carrel: one desk for everything you write" };

/** The family letterhead (capsomer/site-header) with its theme button, wired by /site.js. */
const HEADER = letterheadHtml({
  name: "Carrel",
  mark: '<img src="/icon.svg" alt="" width="32" height="32">',
  links: [
    ["/", "Home"],
    ["/#what", "What it does"],
    ["/#path", "Draft to live"],
    ["/#ai", "AI"],
    ["/#run", "Run your own"],
  ],
  current: "Home",
});

/** The home page's structured data: the site, and Carrel itself as an open-source application. */
const AUTHOR = { "@type": "Person", name: "Dustin Edwards", url: "https://dustinedwards.info" };
const SCHEMA = graph([
  website({ origin: ORIGIN, name: "Carrel", description: DESCRIPTION, publisher: AUTHOR }),
  thing("SoftwareApplication", {
    "@id": `${ORIGIN}/#app`,
    name: "Carrel",
    url: `${ORIGIN}/`,
    description: DESCRIPTION,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Cloudflare Workers",
    license: "https://opensource.org/licenses/MIT",
    sameAs: [REPO],
    author: AUTHOR,
  }),
]);

/** llms.txt (llmstxt.org): what Carrel is and where its source and docs are. */
const LLMS = llmsDocument({
  title: "Carrel",
  summary: DESCRIPTION,
  intro: ["This page is the public front of Dustin Edwards's own instance. Desk, the signed-in app, is behind Cloudflare Access and is not for crawlers."],
  sections: [
    {
      heading: "Carrel",
      links: [
        { title: "Home", url: `${ORIGIN}/`, description: "What Carrel does, how a post goes from draft to live, and how its AI tools work" },
        { title: "Source code", url: REPO, description: "MIT licensed, with the steps to run your own" },
        { title: "site-api", url: "https://github.com/DrDustinEdwards/site-api", description: "the shared API each site uses to connect to Carrel" },
      ],
    },
  ],
});

const ICON_LINKS = iconLinks()
  .map((link) => `<link ${Object.entries(link).map(([name, value]) => `${name}="${value}"`).join(" ")}>`)
  .join("\n");

const head = defineHead({ origin: ORIGIN, siteName: "Carrel", image: CARD, locale: "en_US" });

/**
 * @param {{ title: string, description: string, body: string, index?: boolean }} p
 * @param {{ theme: string, site: string }} integrity each script's integrity (integrityHash): with crossorigin, what
 *   Integrity-Policy asks of a script, a classic one included.
 */
const documentHtml = ({ title, description, body, index = true }, integrity) => `<!doctype html>
<html lang="en" data-family="${FAMILY}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${headHtml([...head({ path: "/", title, fullTitle: true, description, noindex: !index }), ...(index ? [jsonLd(SCHEMA)] : [])])}
${ICON_LINKS}
<link rel="stylesheet" href="/site.css">
<script src="/theme.js" integrity="${integrity.theme}" crossorigin="anonymous"></script>
</head>
<body>
${HEADER}
<div class="cap-page">
${body}
</div>
<script type="module" src="/site.js" integrity="${integrity.site}" crossorigin="anonymous"></script>
</body>
</html>
`;

/**
 * Bundles a script of www/browser/ with Capsomer's behavior in it, minified, as one file.
 *
 * @param {string} file
 * @param {"es" | "iife"} format
 * @returns {Promise<string>}
 */
async function bundle(file, format) {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: true,
      lib: { entry: join(HERE, "browser", file), formats: [format], name: "carrel" },
    },
  });
  const [{ output }] = /** @type {import("vite").Rolldown.RolldownOutput[]} */ (Array.isArray(result) ? result : [result]);
  const [chunk] = output;
  if (output.length !== 1 || chunk?.type !== "chunk") throw new Error(`${file}: expected one chunk`);
  return chunk.code;
}

/** site-runtime's one `_headers` writer, from the public site's registry entry, with Prelum's TDMRep header. */
const HEADERS_BIN = join(HERE, "..", "node_modules", "@dustinedwards", "site-runtime", "bin", "site-runtime-headers.mjs");

/**
 * @param {string} outDir
 * @returns {Promise<{ files: string[] }>}
 */
export async function buildSite(outDir) {
  // Only an earlier build is deleted: a mistyped outDir must not take the working tree with it.
  if (existsSync(outDir) && readdirSync(outDir).length > 0 && !existsSync(join(outDir, "site.css"))) {
    throw new Error(`${outDir} is not empty and holds no earlier build; refusing to delete it`);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const name of readdirSync(join(HERE, "static"))) copyFileSync(join(HERE, "static", name), join(outDir, name));
  execFileSync(process.execPath, [HEADERS_BIN, "--site", "carrel", "--out", join(outDir, "_headers"), "--header", "tdm-reservation: 1"]);
  writeStyles(outDir);
  const theme = await bundle("theme.js", "iife");
  const site = await bundle("site.js", "es");
  writeFileSync(join(outDir, "theme.js"), theme);
  writeFileSync(join(outDir, "site.js"), site);
  const integrity = { theme: await integrityHash(theme), site: await integrityHash(site) };

  writeFileSync(
    join(outDir, "index.html"),
    documentHtml({
      title: TITLE,
      description: DESCRIPTION,
      body: page(),
    }, integrity),
  );
  writeFileSync(
    join(outDir, "404.html"),
    documentHtml({
      title: "Not found: Carrel",
      description: "There is no page at this address.",
      index: false,
      body: `<main id="main" tabindex="-1">\n<h1>Not found</h1>\n<p>There is no page at this address. Carrel is at <a href="/">carrel.dustinedwards.info</a>, and Desk, the signed-in app, at <a href="${DESK}" rel="nofollow">desk.dustinedwards.info</a>.</p>\n</main>\n<footer>${familyFooterHtml({ site: "carrel" })}</footer>`,
    }, integrity),
  );

  mkdirSync(join(outDir, ".well-known"), { recursive: true });
  writeFileSync(join(outDir, ".well-known", "security.txt"), securityTxt({ origin: ORIGIN, contact: CONTACT, expires: SECURITY_TXT_EXPIRES }));
  writeFileSync(join(outDir, "sitemap.xml"), sitemapDocument([{ loc: `${ORIGIN}/` }]));
  writeFileSync(join(outDir, "robots.txt"), robotsDocument({ origin: ORIGIN, notes: [`llms.txt: ${ORIGIN}/llms.txt`] }));
  writeFileSync(join(outDir, "ai.txt"), aiTxt({ origin: ORIGIN, name: "Carrel", contact: CONTACT }));
  writeFileSync(join(outDir, "llms.txt"), LLMS);
  writeFileSync(join(outDir, "site.webmanifest"), JSON.stringify(webManifest({ name: "Carrel", description: DESCRIPTION, themeColor: "#687603", backgroundColor: "#687603", lang: "en" })));
  writeFileSync(join(outDir, `${INDEXNOW_KEY}.txt`), INDEXNOW_KEY);

  /** @type {string[]} */
  const files = [];
  const walk = (/** @type {string} */ dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(relative(outDir, path));
    }
  };
  walk(outDir);
  const missing = PAGE_PRELOADS.links.filter(({ href }) => !files.includes(href.slice(1)));
  if (missing.length) throw new Error(`preloads name files the build did not write: ${missing.map(({ href }) => href).join(", ")}`);
  return { files: files.sort() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2] ?? join(HERE, "dist");
  const { files } = await buildSite(outDir);
  console.log(`www: ${files.length} files in ${relative(process.cwd(), outDir) || "."}`);
}
