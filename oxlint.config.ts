import { defineConfig } from "oxlint";
import { base, react, node, ignorePatterns } from "@dustinedwards/devkit/oxlint";

export default defineConfig({
  extends: [base, react],
  ignorePatterns,
  overrides: [{ files: ["scripts/**", "bin/**", "test/**"], ...node }],
});
