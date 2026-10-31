import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // public/_headers is written before the build by site-runtime-headers from Desk's registry entry (npm run headers).
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), reactRouter()],
  build: {
    // A font is always a file of its own: a font inlined as a data: URI is refused by font-src 'self'.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
  // The Worker bundle. The Cloudflare plugin ignores wrangler's `minify`, so it is set here; source
  // maps are already emitted and uploaded by the plugin's default.
  environments: { ssr: { build: { minify: true } } },
  resolve: {
    alias: [{ find: /^~\//, replacement: fileURLToPath(new URL("./app/", import.meta.url)) }],
  },
});
