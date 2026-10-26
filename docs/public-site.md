# The public site and Desk

Since 2026-10-26 Carrel has two faces, as Capsid has its public site and the Portal:

- **Carrel**, https://carrel.dustinedwards.info: the public page saying what Carrel is (`www/`). A static assets Worker,
  `carrel-www`, with its own committed config (`www/wrangler.jsonc`). No script, no binding, nothing private.
- **Desk**, https://desk.dustinedwards.info: the signed-in writing app (the `carrel` Worker), behind Worker-level Cloudflare
  Access as before. The AI door stays at carrel-mcp.dustinedwards.info.

`npm run www` builds the page into `www/dist`; CI builds it on every push. `npm run deploy:www` deploys it, as does the
"Deploy public site" workflow (by hand, or on a push to main touching `www/` once `CARREL_WWW_LIVE` is `true`).

## The cutover, once

The app answered at carrel.dustinedwards.info until now, so the hostnames move in this order. Each step is Dustin's.

1. **Google sign-in.** In Google Cloud Console, on Carrel's OAuth client, add
   `https://desk.dustinedwards.info/auth/google/callback` to the authorized redirect URIs. Keep the old one until step 5.
2. **Desk's domain.** In Workers & Pages, carrel, Settings, Domains & Routes, add the custom domain
   `desk.dustinedwards.info`. Worker-level Access already covers it; open it and check that Access asks you to sign in.
3. **Merge the pull request** that moves the app's config to desk.dustinedwards.info. The CI deploy then verifies Desk
   live at the new address.
4. **Free the old name.** In the same Domains & Routes list, remove `carrel.dustinedwards.info` from the carrel Worker.
5. **The public page.** Run the "Deploy public site" workflow (Actions, Deploy public site, Run workflow). It creates
   `carrel-www` and attaches carrel.dustinedwards.info. Then set the repository variable `CARREL_WWW_LIVE` to `true`, and
   remove the old Google redirect URI.

If step 5's deploy is refused for permissions (creating a Worker needs the token to be a Workers Admin), run
`npm run deploy:www` once from a checkout signed in with `npx wrangler login`.
