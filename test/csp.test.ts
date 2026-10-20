// The security headers (workers/security-headers.ts): the portfolio's shared set on every response
// of both hosts, redirects and refusals included; a per-request nonce policy with no unsafe script
// source on every page; the preview alone may be framed and only by Carrel, and the site's page inside
// it runs sandboxed. The shared check (@dustinedwards/site-runtime) grades the rendered responses.

import { checkSecurityHeaders, failures, STANDARD_SECURITY_HEADERS } from "@dustinedwards/site-runtime";
import type { KeySource } from "@dustinedwards/site-runtime/access-login";
import { stubAccess } from "@dustinedwards/devkit/access";
import { createExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { aiDoor } from "~/lib/mcp/door";
import { previewPolicy, previewResponse, withSiteBase } from "~/lib/preview.server";

import { cspReport } from "../workers/csp-report";
import { gate } from "../workers/gate";
import {
  appPolicy,
  DOOR_POLICY,
  doorSecurityHeaders,
  newNonce,
  securityHeaders,
  withDoorSecurityHeaders,
  withSecurityHeaders,
} from "../workers/security-headers";

import { addPerson, localKeys, resetDb, testEnv } from "./env";
import { MCP_HOST } from "./mcp-client";

const NONCE = "bm9uY2Utbm9uY2Utbm9uY2U=";
const DOOR = `https://${MCP_HOST}`;
const directive = (policy: string, name: string) => policy.split("; ").find((d) => d.startsWith(`${name} `));
const failed = (headers: Headers, options?: Parameters<typeof checkSecurityHeaders>[1]) =>
  failures(checkSecurityHeaders(headers, options)).map((r) => `${r.name}: ${r.detail}`);

describe("the header set", () => {
  it("is the shared standard exactly on the browser host, and differs on the AI door only by COOP", () => {
    expect(securityHeaders).toEqual(STANDARD_SECURITY_HEADERS);
    const { "Cross-Origin-Opener-Policy": coop, ...rest } = STANDARD_SECURITY_HEADERS;
    expect(coop).toBe("same-origin");
    expect(doorSecurityHeaders).toEqual(rest);
  });
});

describe("the app policy", () => {
  it("allows scripts only by this render's nonce, never inline or eval", () => {
    const policy = appPolicy(NONCE);
    // 'self' is ignored beside 'strict-dynamic' by every browser that knows strict-dynamic.
    expect(directive(policy, "script-src")).toBe(`script-src 'nonce-${NONCE}' 'self' 'strict-dynamic'`);
    expect(policy).not.toMatch(/'unsafe-eval'/);
    expect(directive(policy, "script-src")).not.toMatch(/'unsafe-inline'/);
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("frame-src 'self'");
    expect(policy).toContain(`style-src 'self' 'nonce-${NONCE}'`);
    expect(policy).toContain("style-src-attr 'unsafe-inline'");
  });

  it("reports violations to the AI door, the one host a browser reaches without Access", () => {
    const policy = appPolicy(NONCE, [], DOOR);
    expect(directive(policy, "report-uri")).toBe(`report-uri ${DOOR}/csp-report`);
    expect(directive(policy, "report-to")).toBe("report-to csp");
  });

  it("stays strict for Cloudflare's Web Analytics beacon: no host in script-src, connect-src is 'self'", () => {
    const why =
      "Carrel is private and its hosts are excluded from Web Analytics in the Cloudflare dashboard; do not loosen the policy for the beacon (static.cloudflareinsights.com).";
    // Only the nonce, 'self' and 'strict-dynamic' may appear: no scheme, no host, no wildcard.
    expect(directive(appPolicy(NONCE), "script-src")!.split(" ").slice(1), why).toEqual([`'nonce-${NONCE}'`, "'self'", "'strict-dynamic'"]);
    expect(directive(appPolicy(NONCE), "connect-src"), why).toBe("connect-src 'self'");
  });

  it("mints a different nonce every time", () => {
    const nonces = new Set(Array.from({ length: 50 }, newNonce));
    expect(nonces.size).toBe(50);
  });

  it("PLANT: a page without a policy gets one; a route's own policy is kept", () => {
    const page = withSecurityHeaders(new Response("<html></html>"), NONCE);
    expect(page.headers.get("Content-Security-Policy")).toBe(appPolicy(NONCE));
    const preview = withSecurityHeaders(previewResponse("<html><head></head></html>", "https://site.test"), NONCE);
    expect(preview.headers.get("Content-Security-Policy")).toBe(previewPolicy("https://site.test"));
  });

  it("adds every header to a response whose headers are immutable", () => {
    const redirect = withSecurityHeaders(Response.redirect("https://carrel.test/", 302), NONCE, { reportOrigin: DOOR });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("Location")).toBe("https://carrel.test/");
    expect(redirect.headers.get("Content-Security-Policy")).toBe(appPolicy(NONCE, [], DOOR));
    expect(failed(redirect.headers)).toEqual([]);
  });
});

describe("the preview", () => {
  it("runs the site's page sandboxed: no script, no forms, only the site's styles and images", () => {
    const policy = previewPolicy("https://site.test");
    expect(policy.split("; ")[0]).toBe("sandbox");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("style-src https://site.test 'unsafe-inline'");
    expect(policy).toContain("frame-ancestors 'self'");
  });

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
    expect(response.headers.get("Reporting-Endpoints")).toBe(`csp="${DOOR}/csp-report"`);
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

  it("PLANT: the check fails a page whose headers were not applied", async () => {
    const bare = await gate(new Request("https://carrel.test/", { headers: { "Cf-Access-Jwt-Assertion": token } }), testEnv, async () => html("page"), keys);
    expect(failed(bare.headers).length).toBeGreaterThan(5);
  });

  it("the preview carries every shared header and keeps its own sandboxed policy", async () => {
    const response = await through(() => previewResponse("<html><head></head></html>", "https://site.test"));
    expect(failed(response.headers, { csp: false })).toEqual([]);
    expect(response.headers.get("Content-Security-Policy")).toBe(previewPolicy("https://site.test"));
  });

  it("PLANT: denies framing of every page by default", async () => {
    const response = await through(() => new Response("page"));
    expect(response.headers.get("X-Frame-Options")?.toUpperCase()).toBe("DENY");
  });

  it("lets the preview be framed by Carrel alone", async () => {
    const response = await through(() => previewResponse("<html><head></head></html>", "https://site.test"));
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(failed(response.headers, { csp: false })).toEqual([]);
  });

  it("cannot be loosened by a route asking for ALLOW-FROM or anything else", async () => {
    const response = await through(() => new Response("page", { headers: { "X-Frame-Options": "ALLOW-FROM https://evil.test" } }));
    expect(response.headers.get("X-Frame-Options")?.toUpperCase()).toBe("DENY");
  });
});

describe("rendered responses on the AI door", () => {
  const door = async (request: Request) => withDoorSecurityHeaders(await aiDoor(request, testEnv, createExecutionContext()), DOOR);

  it("liveness, a 404 and the OAuth metadata pass the shared check against the door's set", async () => {
    for (const path of ["/health", "/no-such-page", "/.well-known/oauth-authorization-server"]) {
      const response = await door(new Request(`${DOOR}${path}`));
      expect(failed(response.headers, { standard: doorSecurityHeaders }), path).toEqual([]);
      expect(response.headers.get("Content-Security-Policy"), path).toBe(DOOR_POLICY);
    }
  });

  it("the consent page's policy runs no script and leaves form-action out, so the sign-in's redirect chain is not cut", () => {
    expect(DOOR_POLICY).toContain("default-src 'none'");
    expect(DOOR_POLICY).not.toMatch(/form-action/);
    expect(DOOR_POLICY).not.toMatch(/script-src/);
  });
});

describe("the report sink", () => {
  const sink = (init: RequestInit) => cspReport(new Request(`${DOOR}/csp-report`, init), "https://carrel.test");
  const post = (body: string, headers: Record<string, string> = {}) =>
    sink({ method: "POST", body, headers: { "Content-Type": "application/csp-report", ...headers } });

  it("logs one line per violation, URLs cut to origin and path, and answers 204 with CORS for Carrel's own pages", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const body = JSON.stringify({
      "csp-report": { "document-uri": "https://carrel.test/p/x?draft=secret", "effective-directive": "script-src-elem", "blocked-uri": "inline" },
    });
    const response = await post(body, { Origin: "https://carrel.test" });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://carrel.test");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe(doorSecurityHeaders["X-Content-Type-Options"]);
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ event: "csp-violation", page: "https://carrel.test/p/x", directive: "script-src-elem", blocked: "inline" });
    expect(JSON.stringify(line)).not.toContain("secret");
    log.mockRestore();
  });

  it("answers the Reporting API's preflight for Carrel's origin alone", async () => {
    const ours = await sink({ method: "OPTIONS", headers: { Origin: "https://carrel.test" } });
    expect(ours.status).toBe(204);
    expect(ours.headers.get("Access-Control-Allow-Origin")).toBe("https://carrel.test");
    const theirs = await sink({ method: "OPTIONS", headers: { Origin: "https://evil.test" } });
    expect(theirs.status).toBe(204);
    expect(theirs.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("PLANT: answers 204 to an oversized, malformed or empty report, and logs nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await post("x".repeat(20000), { "Content-Length": "20000" })).status).toBe(204);
    expect((await post("not json")).status).toBe(204);
    expect((await post("")).status).toBe(204);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("refuses any method but POST and OPTIONS", async () => {
    const response = await sink({ method: "GET" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST, OPTIONS");
  });
});
