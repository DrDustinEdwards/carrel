// One rule, from Cloudflare's Workers best practices ("Promise handling"): a promise is awaited,
// returned, caught, passed to ctx.waitUntil(), or marked with `void`. A floating one fails silently.
// This is not a style linter; add a rule only when it guards behaviour.
//
// Needs the generated types, so run it after `npm run typecheck` (which runs wrangler types and
// react-router typegen).

import tseslint from "typescript-eslint";

export default [
  { ignores: ["build/**", ".react-router/**", "node_modules/**", "worker-configuration.d.ts"] },
  {
    files: ["app/**/*.{ts,tsx}", "workers/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.cloudflare.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    // Inline eslint-disable comments in the source name a rule this config does not load, and would also
    // let a floating promise be waved through; ignore all inline config.
    linterOptions: { noInlineConfig: true },
    rules: { "@typescript-eslint/no-floating-promises": "error" },
  },
];
