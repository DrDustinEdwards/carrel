// Starts the screen harness (vite dev over test/harness) and opens screens in headless Chromium.
// Shared by check-a11y.mjs (the accessibility scan) and screens.mjs (screenshots for a human to look at).
// Nothing here reaches the network or needs Cloudflare credentials.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js");

export const VIEWERS = {
  owner: "dustin@harness.invalid",
  editor: "rosa@harness.invalid",
  reader: "sam@harness.invalid",
};

const SITE = "dustinedwards-info";
const REFRESH = "how-the-index-refreshes";
const BOOK = "paluxy-portal";

/**
 * Puts back a post a screen typed into: waits out the autosave, then discards the draft, so the next
 * size or theme opens the same text and not the draft the last one left.
 */
async function discardDraft(/** @type {import("playwright").Page} */ page) {
  await page.waitForTimeout(1800);
  await page.evaluate(async () => {
    // In the page: its own globals, which this file's Node types do not describe.
    const w = /** @type {any} */ (globalThis);
    const body = new FormData();
    body.set("intent", "discard");
    await fetch(w.location.pathname, { method: "POST", body });
  });
}

/**
 * Puts the caret at the end of the formatted editor's last paragraph. Through the browser's selection,
 * which ProseMirror follows: on a phone the fixed tab bar can sit over the end of the text, and a
 * click there does not always reach it.
 */
async function endOfText(/** @type {import("playwright").Page} */ page) {
  await page.evaluate(() => {
    // In the page: its own globals, which this file's Node types do not describe.
    const w = /** @type {any} */ (globalThis);
    const surface = w.document.querySelector(".app-rich-surface");
    const last = [...surface.querySelectorAll(":scope > p")].at(-1) ?? surface;
    surface.focus();
    const range = w.document.createRange();
    range.selectNodeContents(last);
    range.collapse(false);
    const selection = w.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.waitForTimeout(100);
}

/**
 * Every screen, as who sees it. `after` runs once the page is up (open a dialog, type), and `wait` is a
 * selector that must exist before the page counts as ready.
 */
/**
 * @typedef {import("playwright").Page} Page
 * @type {{ name: string; viewer: keyof typeof VIEWERS; path: string; wait?: string; open?: string; skipFor?: string; after?: (page: Page) => Promise<void>; restore?: (page: Page) => Promise<void> }[]}
 */
export const SCREENS = [
  { name: "home", viewer: "owner", path: "/" },
  { name: "home-editor", viewer: "editor", path: "/" },
  { name: "home-reader", viewer: "reader", path: "/" },
  { name: "site", viewer: "owner", path: `/p/${SITE}` },
  { name: "site-filtered", viewer: "owner", path: `/p/${SITE}?status=draft` },
  { name: "site-reader", viewer: "reader", path: `/p/${SITE}` },
  { name: "site-new", viewer: "editor", path: `/p/${SITE}/new` },
  { name: "flags", viewer: "owner", path: `/p/${SITE}/flags` },
  { name: "flags-reader", viewer: "reader", path: `/p/${SITE}/flags` },
  { name: "legal", viewer: "owner", path: `/p/${SITE}/legal` },
  { name: "legal-editor", viewer: "editor", path: `/p/${SITE}/legal` },
  { name: "legal-page", viewer: "owner", path: `/p/${SITE}/e/page.privacy`, wait: ".app-rich-surface" },
  { name: "media", viewer: "owner", path: `/p/${SITE}/media` },
  { name: "media-detail", viewer: "owner", path: `/p/${SITE}/media`, open: "media" },
  { name: "media-editor", viewer: "editor", path: `/p/${SITE}/media` },
  { name: "media-reader", viewer: "reader", path: `/p/${SITE}/media` },
  { name: "media-detail-editor", viewer: "editor", path: `/p/${SITE}/media`, open: "media" },
  { name: "media-trash", viewer: "owner", path: `/p/${SITE}/media?view=trash` },
  { name: "media-trash-editor", viewer: "editor", path: `/p/${SITE}/media?view=trash` },
  { name: "media-tag", viewer: "owner", path: `/p/${SITE}/media?tag=foxhound` },
  { name: "mentions", viewer: "owner", path: `/p/${SITE}/mentions` },
  { name: "mentions-failed", viewer: "owner", path: `/p/${SITE}/mentions?status=failed` },
  { name: "mentions-all", viewer: "owner", path: `/p/${SITE}/mentions?status=all` },
  { name: "mentions-select", viewer: "owner", path: `/p/${SITE}/mentions`, after: (page) => selectMentions(page, 2) },
  // The site refuses to decide a failed mention, so this shows the per mention result without changing anything.
  {
    name: "mentions-result",
    viewer: "owner",
    path: `/p/${SITE}/mentions?status=failed`,
    after: async (page) => {
      await selectMentions(page, 2);
      await page.getByRole("region", { name: "Bulk actions" }).getByRole("button", { name: /^Approve/ }).click();
      await page.locator("#mention-result").waitFor();
      await page.waitForTimeout(600);
    },
  },
  { name: "mentions-delete", viewer: "owner", path: `/p/${SITE}/mentions?status=failed`, after: async (page) => {
      await selectMentions(page, 1);
      await press(page, "button", /^Delete$/, "alertdialog");
    } },
  { name: "mentions-sweep", viewer: "owner", path: `/p/${SITE}/mentions`, after: (page) => pressUntilOpen(page, /^Remove \d+ expired/, "alertdialog") },
  { name: "mentions-editor", viewer: "editor", path: `/p/${SITE}/mentions`, skipFor: "the queue is the Owner's alone: this page answers 403, which test/mentions.test.ts asserts" },
  { name: "mentions-reader", viewer: "reader", path: `/p/${SITE}/mentions`, skipFor: "the queue is the Owner's alone: this page answers 403, which test/mentions.test.ts asserts" },
  { name: "people", viewer: "owner", path: "/people" },
  { name: "manuscripts", viewer: "owner", path: "/manuscripts" },
  { name: "manuscripts-search", viewer: "owner", path: "/manuscripts?q=paluxy" },
  { name: "social", viewer: "owner", path: "/social" },
  { name: "book-new", viewer: "owner", path: "/books/new" },
  { name: "book", viewer: "owner", path: `/b/${BOOK}`, wait: ".cap-meter" },
  { name: "book-editor", viewer: "editor", path: `/b/${BOOK}` },
  { name: "book-reader", viewer: "reader", path: `/b/${BOOK}`, skipFor: "reader has no role on the book" },
  { name: "book-empty", viewer: "owner", path: "/b/salt-roads" },
  { name: "chapter", viewer: "owner", path: `/b/${BOOK}/c/01-arrival` },
  { name: "book-outliner", viewer: "owner", path: `/b/${BOOK}/outliner` },
  { name: "book-outliner-filtered", viewer: "owner", path: `/b/${BOOK}/outliner?status=revised` },
  { name: "book-outliner-none", viewer: "owner", path: `/b/${BOOK}/outliner?status=final` },
  { name: "book-outliner-labels", viewer: "editor", path: `/b/${BOOK}/outliner`, after: (page) => page.getByText("Edit the list").click() },
  { name: "book-target", viewer: "owner", path: `/b/${BOOK}`, wait: ".cap-meter", after: (page) => page.getByText("Your target").click() },
  { name: "book-corkboard", viewer: "owner", path: `/b/${BOOK}/corkboard`, wait: ".cap-sortable" },
  { name: "book-corkboard-lifted", viewer: "editor", path: `/b/${BOOK}/corkboard`, wait: ".cap-sortable", after: (page) => page.getByRole("button", { name: "Move Supper", exact: true }).press("Space") },
  { name: "book-history", viewer: "owner", path: `/b/${BOOK}/h/chapters/01-arrival/01-the-gate.md` },
  {
    name: "book-history-compare",
    viewer: "owner",
    path: `/b/${BOOK}/h/chapters/01-arrival/01-the-gate.md`,
    after: async (page) => {
      for (const box of await page.getByRole("checkbox").all()) await box.check();
      await page.getByRole("button", { name: "Compare the two picked" }).click();
      await page.locator(".cap-compare, .cap-patch").first().waitFor();
    },
  },
  { name: "book-history-ai", viewer: "owner", path: `/b/${BOOK}/h/chapters/01-arrival/01-the-gate.md?compare=ai&ai=3` },
  { name: "book-scene", viewer: "owner", path: `/b/${BOOK}/f/chapters/01-arrival/01-the-gate.md`, wait: ".app-rich-surface" },
  { name: "book-scene-flagged", viewer: "owner", path: `/b/${BOOK}/f/chapters/02-the-crossing/01-the-chain.md`, wait: ".app-rich-surface" },
  { name: "book-bible", viewer: "owner", path: `/b/${BOOK}/f/bible/characters/nell.md`, wait: ".app-rich-surface" },
  { name: "book-scene-editor", viewer: "editor", path: `/b/${BOOK}/f/chapters/01-arrival/01-the-gate.md`, wait: ".app-rich-surface" },
  { name: "post-live", viewer: "owner", path: `/p/${SITE}/e/foxhound-waits`, wait: ".app-rich-surface" },
  { name: "post-draft", viewer: "owner", path: `/p/${SITE}/e/counting-what-the-build-skips`, wait: ".app-rich-surface" },
  { name: "post-working-copy", viewer: "owner", path: `/p/${SITE}/e/what-a-carrel-is-for`, wait: ".app-rich-surface" },
  { name: "post-scheduled", viewer: "owner", path: `/p/${SITE}/e/bacterial-genetics-primer`, wait: ".app-rich-surface" },
  { name: "post-editor-live", viewer: "editor", path: `/p/${SITE}/e/foxhound-waits`, wait: ".app-rich-surface" },
  { name: "post-reader", viewer: "reader", path: `/p/${SITE}/e/foxhound-waits`, wait: ".app-rich-surface" },
  { name: "ai-draft", viewer: "owner", path: `/p/${SITE}/e/counting-what-the-build-skips/ai/1` },
  { name: "post-history", viewer: "owner", path: `/p/${SITE}/e/${REFRESH}`, wait: ".app-rich-surface" },
  { name: "history", viewer: "owner", path: `/p/${SITE}/e/${REFRESH}/history` },
  { name: "history-reader", viewer: "reader", path: `/p/${SITE}/e/${REFRESH}/history` },
  { name: "history-source", viewer: "owner", path: `/p/${SITE}/e/${REFRESH}/history`, after: openOldestSource },
  { name: "history-diff", viewer: "owner", path: `/p/${SITE}/e/${REFRESH}/history`, after: (page) => compareOutermost(page, ".cap-patch") },
  {
    name: "history-diff-word",
    viewer: "owner",
    path: `/p/${SITE}/e/${REFRESH}/history`,
    after: async (page) => {
      await compareOutermost(page, ".cap-patch");
      await chooseByWord(page);
      await page.waitForSelector(".cap-compare[data-cap]", { timeout: 30_000 });
      await page.waitForTimeout(600);
    },
  },
  { name: "history-draft-compare", viewer: "owner", path: `/p/${SITE}/e/${REFRESH}/history?compare=site`, wait: ".cap-patch" },
  { name: "history-ai-compare", viewer: "owner", path: `/p/${SITE}/e/${REFRESH}/history?compare=ai&ai=2`, wait: ".cap-patch" },
  { name: "history-problem", viewer: "owner", path: `/p/${SITE}/e/${REFRESH}/history?v=nope` },
  { name: "site-select", viewer: "owner", path: `/p/${SITE}`, after: (page) => selectPosts(page, ["Counting what the build skips", "What a carrel is for", "How the index refreshes"]) },
  { name: "site-select-editor", viewer: "editor", path: `/p/${SITE}`, after: (page) => selectPosts(page, ["Counting what the build skips", "Why Foxhound waits before it pages you"]) },
  {
    name: "site-bulk-delete",
    viewer: "owner",
    path: `/p/${SITE}`,
    after: async (page) => {
      await selectPosts(page, ["Counting what the build skips", "What a carrel is for"]);
      await press(page, "button", /^Delete$/, "alertdialog");
    },
  },
  {
    name: "site-bulk-result",
    viewer: "editor",
    path: `/p/${SITE}`,
    after: async (page) => {
      await selectPosts(page, ["Counting what the build skips", "Why Foxhound waits before it pages you", "A primer on bacterial genetics"]);
      await page.getByLabel("Tag").fill("colophon");
      await page.getByRole("button", { name: /^Add tag$/ }).click();
      await page.locator("#bulk-result").waitFor();
      await page.waitForTimeout(600);
    },
  },
  { name: "unpublish", viewer: "owner", path: `/p/${SITE}/e/foxhound-waits/unpublish` },
  { name: "not-found", viewer: "owner", path: "/p/nowhere" },

  // The states a person reaches by acting: dialogs, menus and the publish controls.
  {
    name: "more-sheet",
    viewer: "owner",
    path: "/",
    // The tab bar, and so More, exists only on a phone.
    after: async (page) => {
      const more = page.getByRole("button", { name: /^More/ });
      if (!(await more.isVisible())) return;
      await more.click();
      await page.getByRole("dialog").first().waitFor();
      await page.waitForTimeout(300);
    },
  },
  { name: "flags-dismiss", viewer: "owner", path: `/p/${SITE}/flags`, after: (page) => press(page, "button", /^Dismiss/, "alertdialog") },
  {
    name: "media-select",
    viewer: "owner",
    path: `/p/${SITE}/media`,
    after: async (page) => {
      await page.getByRole("checkbox", { name: /^Select/ }).first().setChecked(true, { force: true });
      await page.getByRole("region", { name: "Bulk actions" }).waitFor();
      await page.waitForTimeout(300);
    },
  },
  { name: "media-empty-trash", viewer: "owner", path: `/p/${SITE}/media?view=trash`, after: (page) => press(page, "button", /^Empty the trash/, "alertdialog") },
  { name: "media-delete", viewer: "owner", path: `/p/${SITE}/media`, open: "media", after: (page) => press(page, "button", /^Delete/, "alertdialog") },
  { name: "post-discard", viewer: "owner", path: `/p/${SITE}/e/what-a-carrel-is-for`, wait: ".app-rich-surface", after: (page) => press(page, "button", /^Discard my draft/, "alertdialog") },
  { name: "post-schedule", viewer: "owner", path: `/p/${SITE}/e/counting-what-the-build-skips`, wait: ".app-rich-surface", after: (page) => press(page, "button", /^Schedule/, "dialog") },
  { name: "post-first-publish", viewer: "owner", path: `/p/${SITE}/e/counting-what-the-build-skips`, wait: ".app-rich-surface", after: (page) => press(page, "button", /^Publish$/, "alertdialog") },
  { name: "post-library", viewer: "owner", path: `/p/${SITE}/e/foxhound-waits`, wait: ".app-rich-surface", after: (page) => press(page, "button", /^Insert from library/, "dialog") },
  {
    name: "post-link-palette",
    viewer: "owner",
    path: `/p/${SITE}/e/foxhound-waits`,
    wait: ".app-rich-surface",
    after: async (page) => {
      await page.locator(".app-rich-surface").click();
      await page.keyboard.press("Control+K");
      await page.getByRole("combobox").first().waitFor();
    },
  },
  {
    name: "post-slash-menu",
    viewer: "owner",
    path: `/p/${SITE}/e/what-a-carrel-is-for`,
    wait: ".app-rich-surface",
    after: async (page) => {
      await endOfText(page);
      await page.keyboard.type("\n\n/");
      await page.getByText("Figure", { exact: false }).first().waitFor();
      // Typing steps the chrome back by design; a mouse move brings it back, and that is the screen scanned.
      await page.mouse.move(180, 300);
      await page.waitForTimeout(400);
    },
    restore: discardDraft,
  },
  { name: "post-markdown-mode", viewer: "owner", path: `/p/${SITE}/e/foxhound-waits`, wait: ".app-rich-surface", after: (page) => page.getByRole("radio", { name: "Markdown" }).check({ force: true }).then(() => page.locator(".cm-editor").waitFor()), restore: (page) => page.evaluate(() => localStorage.removeItem("carrel:editor-mode")) },
  { name: "post-source-block", viewer: "owner", path: `/p/${SITE}/e/what-a-carrel-is-for`, wait: ".app-rich-surface", after: async (page) => {
      await endOfText(page);
      await page.getByRole("button", { name: "Figure", exact: true }).click();
      await page.locator(".app-src-text").last().waitFor();
    }, restore: discardDraft },
  { name: "post-split", viewer: "owner", path: `/p/${SITE}/e/foxhound-waits`, wait: ".app-rich-surface", after: (page) => page.getByRole("radio", { name: "Split" }).check({ force: true }).then(() => page.waitForTimeout(800)) },
  { name: "social-reject", viewer: "owner", path: "/social", after: (page) => press(page, "button", /^Reject/, "alertdialog") },
  { name: "book-dismiss", viewer: "owner", path: `/b/${BOOK}/f/chapters/02-the-crossing/01-the-chain.md`, wait: ".app-rich-surface", after: (page) => press(page, "button", /^Dismiss/, "alertdialog") },
  {
    name: "people-disable",
    viewer: "owner",
    path: "/people",
    after: async (page) => {
      await page.getByRole("button", { name: /^Disable/ }).first().click();
      await page.getByRole("button", { name: /Undo/ }).waitFor();
    },
    // The harness's database is shared by every scan, so the person is enabled again afterwards.
    restore: async (page) => {
      await page.getByRole("button", { name: /Undo/ }).click();
      await page.getByText("is enabled again").waitFor();
    },
  },
];

/**
 * Ticks the rows of the posts list whose titles are named, and waits for the bulk bar to say so.
 * @param {Page} page
 * @param {string[]} titles
 */
async function selectPosts(page, titles) {
  for (const title of titles) await page.getByRole("checkbox", { name: new RegExp(`^Select ${title}`) }).check();
  await page.getByRole("region", { name: "Bulk actions" }).getByText(`${titles.length} selected`).waitFor();
  await page.waitForTimeout(400);
}

/**
 * Ticks the first `count` rows of the Mentions table, and waits for the bulk bar to say so. Rows are
 * named by their sender, and several senders are unnamed, so they are taken by position.
 * @param {Page} page
 * @param {number} count
 */
async function selectMentions(page, count) {
  // The boxes are controlled: a click before the page has hydrated is undone when React takes over, so
  // each click is repeated until the bar's count says it landed, never a fixed wait.
  const boxes = page.getByRole("checkbox", { name: /^Select the mention from/ });
  const bar = page.getByRole("region", { name: "Bulk actions" });
  for (let i = 0; i < count; i++) {
    for (let attempt = 1; ; attempt++) {
      await boxes.nth(i).click();
      try {
        await bar.getByText(`${i + 1} selected`).waitFor({ timeout: 3_000 });
        break;
      } catch (error) {
        if (attempt === 8) throw error;
      }
    }
  }
  await page.waitForTimeout(400);
}

/**
 * Presses a button that opens a dialog, repeating the click until the dialog is there: the button is
 * wired by React, so a click before hydration does nothing.
 * @param {Page} page
 * @param {RegExp} name
 * @param {"dialog" | "alertdialog"} opens
 */
async function pressUntilOpen(page, name, opens) {
  for (let attempt = 1; ; attempt++) {
    await page.getByRole("button", { name }).first().click();
    try {
      await page.getByRole(opens).first().waitFor({ timeout: 3_000 });
      break;
    } catch (error) {
      if (attempt === 8) throw error;
    }
  }
  await page.waitForTimeout(300);
}

/**
 * Opens the source of the oldest revision on the history page.
 * @param {Page} page
 */
async function openOldestSource(page) {
  await page.getByRole("link", { name: /open its source/ }).last().click();
  await page.getByLabel("Source of this revision").waitFor();
}

/**
 * Chooses the By word view on the history page, retrying until the hydrated handler has acted.
 * @param {Page} page
 */
async function chooseByWord(page) {
  // The switch is a controlled radio: a click before the page has hydrated is undone when React takes
  // over, and Playwright's check() then fails on "did not change its state". Click until the address
  // carries by=word, which only the hydrated handler writes.
  const radio = page.getByRole("radio", { name: "By word" });
  for (let attempt = 1; ; attempt++) {
    await radio.click({ force: true });
    try {
      await page.waitForURL(/[?&]by=word\b/, { timeout: 3_000 });
      return;
    } catch (error) {
      if (attempt === 8) throw error;
    }
  }
}

/**
 * Picks the newest and the oldest revision, compares them, and waits for the view named by `ready`.
 * @param {Page} page
 * @param {string} ready
 */
async function compareOutermost(page, ready) {
  const boxes = page.getByRole("checkbox", { name: /^Compare the revision/ });
  await boxes.first().check();
  await boxes.last().check();
  await page.getByRole("button", { name: /^Compare the two picked/ }).click();
  await page.waitForSelector(ready, { timeout: 30_000 });
  await page.waitForTimeout(400);
}

/**
 * Presses the first button whose name matches and waits for the dialog it opens.
 * @param {Page} page
 * @param {"button"} role
 * @param {RegExp} name
 * @param {"dialog" | "alertdialog"} opens
 */
async function press(page, role, name, opens) {
  await page.getByRole(role, { name }).first().click();
  await page.getByRole(opens).first().waitFor();
  await page.waitForTimeout(300);
}

/**
 * Built, then previewed, not run under `vite dev`: dev injects its styles through script, which the
 * app's Content Security Policy refuses, and the page must be what a deploy would serve.
 */
export async function startHarness(port = 5199) {
  execFileSync(process.execPath, [VITE, "build", "--config", "vite.harness.config.ts"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const child = spawn(process.execPath, [VITE, "preview", "--config", "vite.harness.config.ts", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const origin = `http://127.0.0.1:${port}`;
  const stop = () => {
    child.kill("SIGTERM");
  };
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    try {
      const res = await fetch(origin, { headers: { "x-harness-viewer": VIEWERS.owner }, signal: AbortSignal.timeout(60_000) });
      if (res.ok) return { origin, stop };
      if (res.status >= 500) {
        stop();
        throw new Error(`the harness answered ${res.status} for /\n${output.slice(-4000)}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("the harness")) throw error;
    }
    if (child.exitCode !== null) throw new Error(`the harness exited\n${output.slice(-4000)}`);
  }
  stop();
  throw new Error(`the harness did not come up\n${output.slice(-4000)}`);
}

/** The bundled Chromium when Playwright has one, else the one in PLAYWRIGHT_BROWSERS_PATH (a sandbox's). */
export async function launch() {
  try {
    return await chromium.launch();
  } catch (error) {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "";
    const dir = base && existsSync(base) ? readdirSync(base).find((d) => /^chromium-\d+$/.test(d)) : undefined;
    if (!dir) throw error;
    return chromium.launch({ executablePath: join(base, dir, "chrome-linux", "chrome") });
  }
}

const COLOURS = ["#8c5fd2", "#2f7d6d", "#c0803b", "#4a78b5", "#b8566f", "#6b7f3a"];
/** @param {string} url */
const picture = (url) => {
  const n = [...url].reduce((a, c) => a + c.charCodeAt(0), 0);
  const c = COLOURS[n % COLOURS.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320"><rect width="320" height="320" fill="${c}" opacity="0.28"/><circle cx="${90 + (n % 120)}" cy="140" r="56" fill="${c}" opacity="0.8"/><rect x="40" y="220" width="240" height="14" rx="7" fill="${c}" opacity="0.6"/></svg>`;
};

/**
 * A page for one viewer, in one theme at one size, with the site's pictures answered locally.
 * @param {import("playwright").Browser} browser
 * @param {string} origin
 * @param {{ viewer: keyof typeof VIEWERS; theme: "light" | "dark"; width: number; height: number }} options
 */
export async function open(browser, origin, { viewer, theme, width, height }) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    extraHTTPHeaders: { "x-harness-viewer": VIEWERS[viewer] },
    reducedMotion: "reduce",
  });
  await context.route("https://site.test/**", (route) => {
    const url = route.request().url();
    return /\/media\//.test(url) ? route.fulfill({ status: 200, contentType: "image/svg+xml", body: picture(url) }) : route.fulfill({ status: 404, body: "" });
  });
  const page = await context.newPage();
  return { page, context };
}

/**
 * @param {import("playwright").Page} page
 * @param {string} origin
 * @param {{ path: string; wait?: string; open?: string; after?: (page: Page) => Promise<void> }} screen
 */
export async function visit(page, origin, screen) {
  const response = await page.goto(`${origin}${screen.path}`, { waitUntil: "load" });
  if (screen.wait) await page.waitForSelector(screen.wait, { timeout: 30_000 });
  // Hydration finishes a beat after load; a screen with its own marker waits for that instead.
  await page.waitForTimeout(screen.wait ? 600 : 900);
  if (screen.open === "media") {
    const href = await page.locator(".cap-media-open").first().getAttribute("href");
    if (href) {
      await page.goto(new URL(href, origin).href, { waitUntil: "load" });
      await page.waitForTimeout(900);
    }
  }
  if (screen.after) await screen.after(page);
  return response;
}
