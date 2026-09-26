// The Content Security Policy, required before the editor ships: every page carries a per-request
// nonce policy with no unsafe script source, the preview alone may be framed and only by Carrel, and
// the site's page inside it runs sandboxed.

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { previewPolicy, previewResponse, withSiteBase } from "~/lib/preview.server";

import { appPolicy, newNonce, withPolicy } from "../workers/csp";
import { gate } from "../workers/gate";

import { addPerson, resetDb, testEnv } from "./env";

describe("the app policy", () => {
  it("allows scripts only by this render's nonce, never inline or eval", () => {
    const policy = appPolicy("abc123");
    const scripts = policy.split("; ").find((d) => d.startsWith("script-src "))!;
    expect(scripts).toBe("script-src 'nonce-abc123' 'strict-dynamic'");
    expect(policy).not.toMatch(/'unsafe-eval'/);
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("frame-src 'self'");
  });

  it("mints a different nonce every time", () => {
    const nonces = new Set(Array.from({ length: 50 }, newNonce));
    expect(nonces.size).toBe(50);
  });

  it("PLANT: a page without a policy gets one; a route's own policy is kept", () => {
    const page = withPolicy(new Response("<html></html>"), "n1");
    expect(page.headers.get("Content-Security-Policy")).toBe(appPolicy("n1"));
    const preview = withPolicy(previewResponse("<html><head></head></html>", "https://site.test"), "n1");
    expect(preview.headers.get("Content-Security-Policy")).toBe(previewPolicy("https://site.test"));
  });

  it("adds the policy to a response whose headers are immutable", () => {
    const redirect = Response.redirect("https://carrel.test/", 302);
    expect(withPolicy(redirect, "n2").headers.get("Content-Security-Policy")).toBe(appPolicy("n2"));
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

describe("framing through the gate", () => {
  let keys: ReturnType<typeof createLocalJWKSet>;
  let token: string;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256" };
    keys = createLocalJWKSet({ keys: [jwk] });
    token = await new SignJWT({ email: "owner@test.invalid" })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(testEnv.ACCESS_TEAM_DOMAIN)
      .setAudience(testEnv.ACCESS_AUD)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(pair.privateKey);
  });

  beforeEach(async () => {
    await resetDb();
    await addPerson("owner@test.invalid", { owner: true });
  });

  /** A verified Owner's request, so the test reads only what the gate does to the rendered response. */
  function through(render: () => Response) {
    const request = new Request("https://carrel.test/", { headers: { "Cf-Access-Jwt-Assertion": token } });
    return gate(request, testEnv, async () => render(), keys);
  }

  it("PLANT: denies framing of every page by default", async () => {
    const response = await through(() => new Response("page"));
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("lets the preview be framed by Carrel alone", async () => {
    const response = await through(() => previewResponse("<html><head></head></html>", "https://site.test"));
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  it("cannot be loosened by a route asking for ALLOW-FROM or anything else", async () => {
    const response = await through(() => new Response("page", { headers: { "X-Frame-Options": "ALLOW-FROM https://evil.test" } }));
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
