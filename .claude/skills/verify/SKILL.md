---
name: verify
description: Use before committing or opening a pull request that changes what Desk shows or does (app/, app/app.css, the screens). Boots the screen harness, the real app with a fake site and no Access, drives the changed flow end to end in Chromium with Playwright, runs the checks that cover it, and reports the evidence. Not for Worker-only or MCP changes (those are proved in test/).
---

# Verify a Desk change

Tests prove what someone thought to test. This skill proves the change itself: run
the real app, use the changed flow as Dustin would, and look at the result. Do it
before every commit that changes a screen, and before the pull request.

## 1. Boot the harness

Carrel needs Node 26 (`engines`; there is no `.nvmrc`). If `node -v` is older, put
Node 26 on PATH first (in the cloud, `~/.cache/capsid-node/node-v26.13.1-linux-x64/bin`).
Then, from the repo root:

```sh
npm ci
npm run harness   # run in the background
```

`npm run harness` builds `vite.harness.config.ts` and serves the real app on
`http://127.0.0.1:5199` with the Access gate replaced by a header and a fake site,
writing repository and Google (`test/harness`; fake data, example hosts). No Cloudflare
credentials. It is a production build under `vite preview`, so the app's
Content Security Policy applies. Wait until this prints 200:

```sh
curl -s -o /dev/null -w '%{http_code}' -H 'x-harness-viewer: dustin@harness.invalid' http://127.0.0.1:5199/
```

The port is fixed. If another server holds 5199 the preview refuses to start, so a
200 from a port you did not start may be another repo's app: confirm the page title
names Carrel (`Carrel Desk` or `Home · Carrel`) before trusting a run.

The viewer is the `x-harness-viewer` header (plus a `harness-viewer` cookie for
WebSockets): `dustin@harness.invalid` is the Owner, `rosa@harness.invalid` an Editor,
`sam@harness.invalid` a Reader. Drive the role the change is about, and a lesser role
when the change is a permission. The fake site is `dustinedwards-info`, the fake book
`paluxy-portal` (see `SCREENS` in `scripts/lib/harness.mjs` for the paths).

## 2. Drive the changed flow

Write a short script in the session's scratchpad, never in the repo. Name each step
the way a person would say it, act through roles and labels, and assert what the
person should see afterward. Collect console errors and page errors, and keep a
screenshot of the end state.

```js
// <scratchpad>/drive.mjs: REPO=<repo> node drive.mjs http://127.0.0.1:5199
import { createRequire } from "node:module";
const { chromium } = createRequire(`${process.env.REPO}/package.json`)("playwright");
const origin = process.argv[2];
const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const context = await browser.newContext({
  viewport: { width: 1280, height: 860 },
  extraHTTPHeaders: { "x-harness-viewer": "dustin@harness.invalid" },
});
await context.addCookies([
  { name: "harness-viewer", value: "dustin%40harness.invalid", url: origin },
]);
const page = await context.newPage();
const errors = [];
page.on(
  "console",
  (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()),
);
page.on("pageerror", (e) => errors.push(String(e)));
const log = [];
async function step(name, fn) {
  try {
    await fn();
    log.push(`ok   ${name}`);
  } catch (e) {
    log.push(`FAIL ${name}: ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: "fail.png", fullPage: true });
    throw e;
  }
}
try {
  await step("open Home as the Owner", async () => {
    const r = await page.goto(origin);
    if (!r.ok()) throw new Error(`status ${r.status()}`);
    await page.locator("main").waitFor();
    log.push(`     title: ${await page.title()}`);
  });
  await step("go to Writing from the rail", async () => {
    await page.getByRole("link", { name: "Writing", exact: true }).first().click();
    await page.waitForURL("**/writing");
    await page.locator("main h1").first().waitFor();
  });
  // ...the changed flow: click, fill, save, then assert the visible result.
  await page.screenshot({ path: "after.png", fullPage: true });
} finally {
  console.log(log.join("\n"));
  console.log("console errors:", errors.length ? errors : "none");
  await browser.close();
}
```

Run it from the scratchpad with `REPO=<repo> node drive.mjs http://127.0.0.1:5199`.
Drive the whole flow, not just the page load: open the dialog, submit the form, see
the row change, reload and see it hold. For a flow that has a driver in `SCREENS`
(`scripts/lib/harness.mjs`, for example Home's `l` key to set a row aside, the header
search on Ctrl+K, a post's editor), copy its selectors rather than inventing new ones.
If the change is responsive or themed, repeat the end state at 390 px wide and in dark
mode (`page.setViewportSize`, `page.emulateMedia({ colorScheme: "dark" })`). A write
the harness accepts changes only its in-memory fakes; `persistState` is off, so a
restart gives the seed back.

If launch fails with "Executable doesn't exist" (the repo's Playwright build does not
match the container's Chromium), set `PW_CHROMIUM=/opt/pw-browsers/chromium`. Do not run `playwright install`.

## 3. Run the checks that cover the area

Stop the step 1 server first: the checks start their own harness on 5199 and refuse
a busy port. Stop it by the PID of what you started, not by name, because another
session may share the machine.

- Accessibility of every screen, both themes, desktop and phone:
  `npm run check:a11y -- <part of a screen name>` (for example `home`; no argument
  scans all of them, which takes minutes). Its launcher falls back to the container's
  Chromium by itself.
- The unit and integration tests for the area, in workerd with local D1:
  `npx vitest run test/<name>.test.ts` (for example `waiting.test.ts` for Home's rows,
  `posts.test.ts`, `books.test.ts`, `media.test.ts`, `mentions.test.ts`, `roles.test.ts`).
- A change to headers or the CSP: `npx vitest run test/csp.test.ts test/access.test.ts`.
- `node scripts/screens.mjs <directory> <screen>` writes light and dark screenshots at
  desktop and phone widths of one screen, to look at. Write them outside the repo.
- `npm run typecheck` and `npm run lint` before the commit; `npm run format:check`
  covers this file and any Markdown you touch.

CI runs the rest (`npm test`, `check:conformance`, `check:plants`, `check:bloat`); do
not run the whole set here.

## Rules

- A failed step is a finding about the change. Fix the code, then run the same script
  again. Never add a sleep, a retry or a looser selector to make it pass.
- If a step fails sometimes, find out why before going on; a flaky check teaches the
  next thread to re-run instead of fix.
- Never edit an existing test to make it agree with new behavior unless the change is
  meant to alter that behavior, and say so in the pull request.
- Leave nothing behind: stop the server, and keep the scripts and screenshots in the
  scratchpad. Nothing from this skill is committed.

## The report

Put this in the reply and the pull request body:

- First line: verified, partly verified (and what was not), or failed.
- Each step's ok or FAIL line, verbatim, and the console errors line.
- The end-state screenshot, attached (Dustin cannot open a scratchpad path).
- The summary line of each check you ran.
- Anything the harness cannot show, named as not verified: the real Cloudflare Access
  sign-in and the AI door's OAuth, live D1, R2 and Durable Object rooms under real
  load, the real site through site-api, GitHub and Google. The live check after a
  merge deploys is the `live gate` job: `scripts/verify-live.mjs`, described in
  `docs/auto-deploy.md`.
