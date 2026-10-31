// The security headers (workers/security-headers.ts) where the live check (site-runtime-security) cannot see them:
// Desk's pages are behind Access, so a stranger gets Access's redirect, never a page. The shared set on every signed-in
// response, redirects and refusals included, graded against Desk's registry entry; the preview alone may be framed and
// only by Carrel, and the site's page inside it runs sandboxed. The AI door is public, so the live check grades it.

import { checkSecurityHeaders, failures, STANDARD_SECURITY_HEADERS } from "@dustinedwards/site-runtime";
import type { KeySource } from "@dustinedwards/site-runtime/access-login";
import { stubAccess } from "@dustinedwards/devkit/access";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { previewPolicy, previewResponse, withSiteBase } from "~/lib/preview.server";

import { gate } from "../workers/gate";
import { appPolicy, withSecurityHeaders } from "../workers/security-headers";

import { addPerson, localKeys, resetDb, testEnv } from "./env";
import { MCP_HOST } from "./mcp-client";

const NONCE = "bm9uY2Utbm9uY2Utbm9uY2U=";
const DOOR = `https://${MCP_HOST}`;
const failed = (headers: Headers, options: Parameters<typeof checkSecurityHeaders>[1] = { site: "carrel-desk" }) =>
  failures(checkSecurityHeaders(headers, options)).map((r) => `${r.name}: ${r.detail}`);

describe("a page's policy", () => {
  it("PLANT: a page without a policy gets one", () => {
    const page = withSecurityHeaders(new Response("<html></html>"), NONCE);
    expect(page.headers.get("Content-Security-Policy")).toBe(appPolicy(NONCE));
  });

});

describe("the preview", () => {
  it("resolves the page's relative URLs against the site and drops the page's own <base>", () => {
    const html = withSiteBase('<html><head lang="en"><base href="https://evil.test/"><link href="/a.css"></head></html>', "https://site.test");
    expect(html).toBe('<html><head lang="en"><base href="https://site.test/"><link href="/a.css"></head></html>');
    expect(withSiteBase("<p>no head</p>", "https://site.test")).toBe('<base href="https://site.test/"><p>no head</p>');
  });
});

describe("rendered responses through the gate", () => {
  let keys: KeySource;
  let token: string;

  beforeAll(async () => {
    const access = await stubAccess({ issuer: testEnv.ACCESS_TEAM_DOMAIN, audience: testEnv.ACCESS_AUD, email: "owner@test.invalid", install: false });
    keys = localKeys(access.jwk);
    token = await access.token();
  });

  beforeEach(async () => {
    await resetDb();
    await addPerson("owner@test.invalid", { owner: true });
  });

  /** What app.ts does on the browser host: the gate, then the security headers on whatever it returns. */
  async function through(render: () => Response, { signedIn = true } = {}) {
    const headers: Record<string, string> = signedIn ? { "Cf-Access-Jwt-Assertion": token } : {};
    const request = new Request("https://carrel.test/", { headers });
    return withSecurityHeaders(await gate(request, testEnv, async () => render(), keys), NONCE, { imageOrigins: ["https://site.test"], reportOrigin: DOOR });
  }

  const html = (body: string, init: ResponseInit = {}) =>
    new Response(body, { ...init, headers: { "Content-Type": "text/html; charset=utf-8", ...(init.headers as Record<string, string>) } });

  it("a page passes the shared check: every header, an enforced strict policy, a report sink", async () => {
    const response = await through(() => html("<!doctype html><p>page</p>"));
    expect(failed(response.headers)).toEqual([]);
    expect(response.headers.get("Strict-Transport-Security")).toBe(STANDARD_SECURITY_HEADERS["Strict-Transport-Security"]);
    expect(response.headers.get("Reporting-Endpoints")).toBe(`csp-endpoint="${DOOR}/csp-report"`);
    // The gate's caching survives: private, and untransformed so the beacon is never injected.
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, no-transform");
  });

  it("a redirect and a JSON answer pass it too", async () => {
    expect(failed((await through(() => new Response(null, { status: 302, headers: { Location: "/next" } }))).headers)).toEqual([]);
    expect(failed((await through(() => Response.json({ ok: true }))).headers)).toEqual([]);
  });

  it("PLANT: the gate's refusal passes it, so a stranger is never served a bare 403", async () => {
    const refused = await through(() => html("never rendered"), { signedIn: false });
    expect(refused.status).toBe(403);
    expect(failed(refused.headers)).toEqual([]);
  });

  it("the preview carries every shared header and keeps its own sandboxed policy", async () => {
    const response = await through(() => previewResponse("<html><head></head></html>", "https://site.test"));
    expect(failed(response.headers, { site: "carrel-desk", csp: false })).toEqual([]);
    expect(response.headers.get("Content-Security-Policy")).toBe(previewPolicy("https://site.test"));
  });

  it("cannot be loosened by a route asking for ALLOW-FROM or anything else", async () => {
    const response = await through(() => new Response("page", { headers: { "X-Frame-Options": "ALLOW-FROM https://evil.test" } }));
    expect(response.headers.get("X-Frame-Options")?.toUpperCase()).toBe("DENY");
  });
});
