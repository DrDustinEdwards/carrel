// Carrel deploys through devkit's shared deploy, verify and rollback workflow (merge pipeline PR 8, part 2).
// A merge to main is a production deploy, so the call is pinned here as text: the workflow, the full sha
// of the devkit tag, the Worker, the health route the live gate polls, the verify command, the guard that
// runs before the deploy, and that nothing else in CI deploys.

import { describe, expect, it } from "vitest";

import ci from "../.github/workflows/ci.yml?raw";
import pkg from "../package.json?raw";
import verify from "../scripts/verify-live.mjs?raw";

// The devkit tag ci.yml pins. A move to a newer tag changes both.
const DEVKIT_SHA = "27e0a1ca0747b5839bf7e0433c307ae671de8501";
const DEVKIT_TAG = "v0.7.0";

/** The deploy job's text, from its key to the end of the file (it is the last job). */
const deployJob = ci.slice(ci.indexOf("\n  deploy:\n"));
const uncommented = (text: string) => text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

describe("the deploy", () => {
  it("calls devkit's worker-deploy.yml pinned to the full sha of its devkit tag", () => {
    expect(ci.indexOf("\n  deploy:\n")).toBeGreaterThan(0);
    const uses = /\n {4}uses: DrDustinEdwards\/devkit\/\.github\/workflows\/worker-deploy\.yml@(\S+) # (\S+)\n/.exec(deployJob);
    expect(uses, "the deploy job does not call devkit's worker-deploy.yml").not.toBeNull();
    // A branch or a tag moves under Carrel without a reviewed change here; only a full sha does not.
    expect(uses![1]).toMatch(/^[0-9a-f]{40}$/);
    expect(uses![1]).toBe(DEVKIT_SHA);
    expect(uses![2]).toBe(DEVKIT_TAG);
  });

  it("runs on a push to main only, after check and gates", () => {
    expect(deployJob).toContain("\n    needs: [check, gates]\n");
    expect(deployJob).toContain("\n    if: github.event_name == 'push' && github.ref == 'refs/heads/main'\n");
  });

  it("passes the Worker, the AI door's /health, the verify command and the sha var", () => {
    expect(deployJob).toContain("\n      worker-name: carrel\n");
    // The browser host's /health is behind Access, so the live gate could never read it from CI.
    expect(deployJob).toContain("\n      health-url: https://carrel-mcp.dustinedwards.info/health\n");
    expect(deployJob).toContain("\n      verify-command: node scripts/verify-live.mjs\n");
    expect(deployJob).toContain("\n      sha-var: DEPLOY_SHA\n");
    expect(deployJob).toContain("\n      node-version-file: package.json\n");
  });

  it("keeps Carrel's guard before the deploy: deploy.mjs --prepare, with the three variables", () => {
    const pre = /\n {6}pre-deploy: >-\n((?: {8}.*\n)+)/.exec(deployJob)?.[1] ?? "";
    expect(pre).toContain("node scripts/deploy.mjs --prepare");
    for (const name of ["CARREL_D1_DATABASE_ID", "CARREL_KV_OAUTH_ID", "CARREL_ALERT_EMAIL"]) {
      expect(pre).toContain(`${name}='\${{ vars.${name} }}'`);
    }
    // The secrets go to devkit by name, never inherited, and never into an input.
    expect(deployJob).toContain("\n      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n");
    expect(deployJob).toContain("\n      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}\n");
    expect(uncommented(ci)).not.toMatch(/secrets: inherit/);
    expect(pre).not.toMatch(/secrets\./);
  });

  it("nothing else in CI deploys: no deploy:ci, no wrangler deploy of its own", () => {
    const code = uncommented(ci);
    expect(code).not.toMatch(/npm run deploy/);
    expect(code).not.toMatch(/wrangler (deploy|rollback)/);
    expect(JSON.parse(pkg).scripts["deploy:ci"]).toBe("node scripts/deploy.mjs");
  });

  it("the verify needs no install: Node's standard library and global fetch only", () => {
    expect(verify).not.toMatch(/^\s*import\s/m);
    expect(verify).not.toMatch(/\brequire\(/);
  });
});
