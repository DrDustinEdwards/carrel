// check:a11y. One axe scan of every screen as it renders, in both themes at a desktop and a phone
// width, for each role that sees it differently. WCAG 2.2 at level A and AA, as the standard defines
// them: axe's own best-practice rules are not run. The screens come from test/harness, which runs the
// real app with a fake site, writing repository and Google, so this needs no Cloudflare credentials.
//
// Exit 0: no violation on any screen. Exit 1: violations, listed. Exit 2: the harness did not start.
//
// Run: npm run check:a11y

import { AxeBuilder } from "@axe-core/playwright";

import { launch, open, SCREENS, startHarness, visit } from "./lib/harness.mjs";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
/** @type {{ name: string; width: number; height: number }[]} */
const SIZES = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 800 },
];
const only = process.argv[2];

/** The preview frame is the site's own page, sandboxed with no script: axe cannot enter it, and it is not Carrel's. */
const axe = (/** @type {import("playwright").Page} */ page) => new AxeBuilder({ page }).withTags(TAGS).exclude("iframe[sandbox]");

const harness = await startHarness().catch((error) => {
  console.error(`check:a11y: ${error instanceof Error ? error.message : error}`);
  return process.exit(2);
});
const browser = await launch();
let scans = 0;
const failures = /** @type {string[]} */ ([]);

/** @param {(typeof SCREENS)[number]} screen @param {"light" | "dark"} theme @param {(typeof SIZES)[number]} size */
async function scan(screen, theme, size) {
  const label = `${screen.name} (${theme}, ${size.name})`;
  // A scan that never ends is a failure with a name, not a job that runs until the runner gives up.
  let timer;
  const stuck = new Promise((resolve) => {
    timer = setTimeout(() => {
      failures.push(`${label}: did not finish in two minutes`);
      resolve(undefined);
    }, 120_000);
  });
  await Promise.race([scanOne(screen, theme, size), stuck]);
  clearTimeout(timer);
}

/** @param {(typeof SCREENS)[number]} screen @param {"light" | "dark"} theme @param {(typeof SIZES)[number]} size */
async function scanOne(screen, theme, size) {
  const { page, context } = await open(browser, harness.origin, { viewer: screen.viewer, theme, width: size.width, height: size.height });
  // A script error, and above all a hydration mismatch, is a screen that renders one thing and runs another.
  const errors = /** @type {string[]} */ ([]);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|Blocked script execution/.test(m.text())) errors.push(m.text());
  });
  const label = `${screen.name} (${theme}, ${size.name})`;
  try {
    page.setDefaultTimeout(30_000);
    const response = await visit(page, harness.origin, screen);
    if (!response || (response.status() >= 400 && screen.name !== "not-found")) {
      failures.push(`${label}: the page answered ${response?.status()}`);
      return;
    }
    const result = await axe(page).analyze();
    scans++;
    for (const e of errors.slice(0, 2)) failures.push(`${label}: the page logged an error: ${e.slice(0, 300)}`);
    for (const v of result.violations) {
      let bad = v.nodes;
      // A target the sticky tab bar covers at the top of the page is reached by scrolling, as a person
      // would. It counts only if it is still too small once it is scrolled clear of the bar.
      if (v.id === "target-size") {
        bad = [];
        for (const n of v.nodes) {
          const selector = n.target.join(" ");
          try {
            await page.locator(selector).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
            const again = await axe(page).include(n.target).analyze();
            if (again.violations.some((x) => x.id === "target-size")) bad.push(n);
          } catch {
            bad.push(n);
          }
        }
      }
      if (bad.length === 0) continue;
      const nodes = bad.slice(0, 3).map((n) => `    ${n.target.join(" ")}\n      ${n.failureSummary?.split("\n").slice(0, 2).join(" ").trim()}`);
      failures.push(`${label}: ${v.id}: ${v.help}\n${nodes.join("\n")}`);
    }
  } catch (error) {
    failures.push(`${label}: could not be scanned: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
  } finally {
    await screen.restore?.(page).catch(() => undefined);
    await context.close();
    console.log(`  scanned ${label}`);
  }
}

try {
  const jobs = SCREENS.filter((screen) => !screen.skipFor && (!only || screen.name.includes(only))).flatMap((screen) =>
    /** @type {const} */ (["light", "dark"]).flatMap((theme) => SIZES.map((size) => ({ screen, theme, size }))),
  );
  // Screens that change the shared world and put it back run alone; the rest run side by side.
  const alone = jobs.filter((j) => j.screen.restore);
  const queue = jobs.filter((j) => !j.screen.restore);
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) await scan(job.screen, job.theme, job.size);
    }),
  );
  for (const job of alone) await scan(job.screen, job.theme, job.size);
} finally {
  await browser.close();
  harness.stop();
}

if (scans === 0) {
  console.error("check:a11y: nothing was scanned.");
  process.exit(1);
}
if (failures.length > 0) {
  console.error(`check:a11y: ${failures.length} problem${failures.length === 1 ? "" : "s"} in ${scans} scans\n\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log(`check:a11y: ${scans} scans (every screen, both themes, desktop and phone), no WCAG 2.2 A or AA violation.`);
process.exit(0);
