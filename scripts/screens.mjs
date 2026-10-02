// Screenshots of every screen, in both themes at a desktop and a phone width, for a person to look at.
// Written outside the repository: node scripts/screens.mjs <directory> [part of a screen's name]
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { launch, open, SCREENS, startHarness, visit } from "./lib/harness.mjs";

const out = process.argv[2];
const only = process.argv[3];
if (!out) {
  console.error("usage: node scripts/screens.mjs <directory> [screen]");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const harness = await startHarness();
const browser = await launch();
try {
  for (const screen of SCREENS) {
    if (screen.skipFor || (only && !screen.name.includes(only))) continue;
    for (const theme of /** @type {const} */ (["light", "dark"])) {
      for (const { size, width, height } of [{ size: "desktop", width: 1280, height: 860 }, { size: "phone", width: 390, height: 800 }]) {
        const { page, context } = await open(browser, harness.origin, { viewer: screen.viewer, theme, width, height });
        await visit(page, harness.origin, screen);
        await page.screenshot({ path: join(out, `${screen.name}-${theme}-${size}.png`), fullPage: true });
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  harness.stop();
}
