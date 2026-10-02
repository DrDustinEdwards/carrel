// The screen harness: the real app under Vite, with the gate replaced and every backend a test fake
// (test/harness). Used by `npm run check:a11y` and `npm run harness`; never built or deployed.
import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare({ configPath: "./test/harness/wrangler.jsonc", viteEnvironment: { name: "ssr" }, persistState: false }), reactRouter()],
  build: {
    // A font is always a file of its own: a font inlined as a data: URI is refused by font-src 'self'.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
  resolve: {
    alias: [{ find: /^~\//, replacement: fileURLToPath(new URL("./app/", import.meta.url)) }],
  },
});
