---
name: verify
description: Use before committing or opening a pull request that changes what Desk shows or does (app/, app/app.css, the screens). Boots the screen harness, the real app with a fake site and no Access, drives the changed flow end to end in Chromium with Playwright, runs the checks that cover it, and reports the evidence. Not for Worker-only or MCP changes (those are proved in test/).
---

# Verify a Desk change

Do it before every commit that changes a screen, and before the pull request.

## 1. Boot the harness

Carrel needs Node 26 (`engines`; there is no `.nvmrc`). If `node -v` is older, put
the Node 26 the SessionStart hook installs on PATH first.
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
// errors, log and step(): the helpers in devkit docs/verify.md
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
Drive the whole flow (act, see the result, reload and see it hold). For a flow that
has a driver in `SCREENS` (`scripts/lib/harness.mjs`), copy its selectors rather than
inventing new ones. Repeat the end state at 390 px and dark when the change is
responsive or themed.

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
- `npm run typecheck` and `npm run lint` before the commit.

## Rules and report

Follow the Rules and the report in [devkit's docs/verify.md](https://github.com/DrDustinEdwards/devkit/blob/main/docs/verify.md). For this repo:

- Anything the harness cannot show, named as not verified: the real Cloudflare Access
  sign-in and the AI door's OAuth, live D1, R2 and Durable Object rooms under real
  load, the real site through site-api, GitHub and Google. The live check after a
  merge deploys is the `live gate` job: `scripts/verify-live.mjs`, described in
  `docs/auto-deploy.md`.
