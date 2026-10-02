// check:a11y. One axe scan of every screen as it renders, in both themes at a desktop and a phone
// width, for each role that sees it differently. WCAG 2.2 at level A and AA, as the standard defines
// them: axe's own best-practice rules are not run. The screens come from test/harness, which runs the
// real app with a fake site, novels repository and Google, so this needs no Cloudflare credentials.
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

let harness;
try {
  harness = await startHarness();
} catch (error) {
  console.error(`check:a11y: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
}
const browser = await launch();
let scans = 0;
const failures = [];
try {
  for (const screen of SCREENS) {
    if (screen.skipFor || (only && !screen.name.includes(only))) continue;
    for (const theme of /** @type {const} */ (["light", "dark"])) {
      for (const size of SIZES) {
        const { page, context } = await open(browser, harness.origin, { viewer: screen.viewer, theme, ...size });
        // A script error, and above all a hydration mismatch, is a screen that renders one thing and runs another.
        const errors = /** @type {string[]} */ ([]);
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("console", (m) => {
          if (m.type() === "error" && !/Failed to load resource|Blocked script execution/.test(m.text())) errors.push(m.text());
        });
        try {
          const response = await visit(page, harness.origin, screen);
          if (!response || (response.status() >= 400 && screen.name !== "not-found")) {
            failures.push(`${screen.name} (${theme}, ${size.name}): the page answered ${response?.status()}`);
            continue;
          }
          const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
          scans++;
          for (const e of errors.slice(0, 2)) failures.push(`${screen.name} (${theme}, ${size.name}): the page logged an error: ${e.slice(0, 300)}`);
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
                  const again = await new AxeBuilder({ page }).withTags(TAGS).include(n.target).analyze();
                  if (again.violations.some((x) => x.id === "target-size")) bad.push(n);
                } catch {
                  bad.push(n);
                }
              }
            }
            if (bad.length === 0) continue;
            const nodes = bad.slice(0, 3).map((n) => `    ${n.target.join(" ")}\n      ${n.failureSummary?.split("\n").slice(0, 2).join(" ").trim()}`);
            failures.push(`${screen.name} (${theme}, ${size.name}): ${v.id}: ${v.help}\n${nodes.join("\n")}`);
          }
        } finally {
          await screen.restore?.(page).catch(() => undefined);
          await context.close();
        }
      }
    }
  }
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
