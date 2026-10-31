import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { headersFile } from "@dustinedwards/site-runtime/headers";
import { defineConfig, type Plugin } from "vite";

import { securityHeaders } from "./workers/security-headers.ts";

/**
 * Static files never run the Worker, so every build rewrites public/_headers (committed, so the family check reads its
 * cache rule) with site-runtime's headersFile: Desk's set on every file, charset=utf-8 on the text files, cross-origin CORP
 * on stylesheets, scripts and fonts (the sandboxed preview frame's origin is opaque, site-runtime corpFor), and a year's
 * cache for Vite's hashed /assets/.
 */
function staticHeaders(): Plugin {
  const comment = [
    "Written by vite.config.ts on every build from workers/security-headers.ts; do not edit.",
    "Vite names each built file by its content hash, so a year is safe for /assets/; without the rule every page load",
    "revalidates every file. Files at stable paths (favicon, logo) keep the default revalidation.",
  ];
  const IMMUTABLE = { "Cache-Control": "public, max-age=31536000, immutable" };
  return {
    name: "carrel-static-headers",
    apply: "build",
    buildStart() {
      if (this.environment.name === "client") writeFileSync("public/_headers", headersFile(securityHeaders, { comment, charset: true, paths: { "/assets/*": IMMUTABLE } }));
    },
  };
}

export default defineConfig({
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), reactRouter(), staticHeaders()],
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
