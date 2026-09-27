// A fake Google for the tests, answering the requests Carrel makes the way Google does (shapes
// recorded from the Drive v3, OAuth 2.0 and Search Console APIs). No real Google call and no real
// key: the service account key is generated here, and the token endpoint verifies its signed JWT
// with the matching public key, so a wrong signature, issuer, audience or scope is caught.

import { exportJWK, importJWK, jwtVerify, type JWK } from "jose";

export const CLIENT_EMAIL = "carrel-reader@carrel-test.iam.gserviceaccount.com";
export const KEY_ID = "0123456789abcdef0123456789abcdef01234567";
export const SA_TOKEN = "ya29.sa-test-token";
export const USER_TOKEN = "ya29.user-test-token";
export const CODE = "4/test-authorization-code";
export const REFRESH = "1//test-refresh-token";

function pem(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(s).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
}

/** A service account key file as Google downloads it, and the public half to verify with. */
export async function serviceAccountKey() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const json = JSON.stringify({
    type: "service_account",
    project_id: "carrel-test",
    private_key_id: KEY_ID,
    private_key: pem((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer),
    client_email: CLIENT_EMAIL,
    client_id: "1234567890",
    token_uri: "https://oauth2.googleapis.com/token",
  });
  return { json, publicJwk: (await exportJWK(pair.publicKey)) as JWK };
}

export type FakeFile = { id: string; name: string; mimeType: string; parent: string; content?: string; modifiedTime?: string };

export function fakeGoogle(opts: { publicJwk: JWK; files?: FakeFile[]; scRows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] }) {
  const files = [...(opts.files ?? [])];
  const docs = new Map<string, { name: string; content: string }>();
  const requests: string[] = [];
  const assertions: Record<string, unknown>[] = [];
  const state = { refuseFullText: false, saRevoked: false, userRevoked: false, grantedScope: "https://www.googleapis.com/auth/drive.file", scStatus: 200, docEdits: new Map<string, string>() };

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.origin}${url.pathname}`);
    const auth = request.headers.get("Authorization");

    if (url.href === "https://oauth2.googleapis.com/token" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const grant = form.get("grant_type");
      if (grant === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
        try {
          const { payload } = await jwtVerify(form.get("assertion") ?? "", await importJWK(opts.publicJwk, "RS256"), {
            issuer: CLIENT_EMAIL,
            audience: "https://oauth2.googleapis.com/token",
          });
          assertions.push(payload as Record<string, unknown>);
        } catch {
          return json(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
        }
        if (state.saRevoked) return json(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
        return json(200, { access_token: SA_TOKEN, expires_in: 3599, token_type: "Bearer" });
      }
      if (grant === "authorization_code") {
        if (form.get("code") !== CODE) return json(400, { error: "invalid_grant" });
        return json(200, { access_token: USER_TOKEN, refresh_token: REFRESH, expires_in: 3599, scope: state.grantedScope, token_type: "Bearer" });
      }
      if (grant === "refresh_token") {
        if (state.userRevoked || form.get("refresh_token") !== REFRESH) return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        return json(200, { access_token: USER_TOKEN, expires_in: 3599, scope: state.grantedScope, token_type: "Bearer" });
      }
      return json(400, { error: "unsupported_grant_type" });
    }

    if (url.origin === "https://www.googleapis.com" && url.pathname === "/drive/v3/files" && request.method === "GET") {
      if (auth !== `Bearer ${SA_TOKEN}`) return json(401, { error: { code: 401 } });
      const q = url.searchParams.get("q") ?? "";
      const parent = /^'([^']+)' in parents and trashed = false$/.exec(q)?.[1];
      const words = /^fullText contains '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
      const title = /^name contains '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
      if (words !== undefined && state.refuseFullText) return json(403, { error: { code: 403, message: "Insufficient Permission" } });
      const hits = parent
        ? files.filter((f) => f.parent === parent)
        : words !== undefined
          ? files.filter((f) => f.content?.toLowerCase().includes(words.toLowerCase()))
          : title !== undefined
            ? files.filter((f) => f.mimeType !== "application/vnd.google-apps.folder" && f.name.toLowerCase().includes(title.toLowerCase()))
            : [];
      return json(200, {
        files: hits.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          webViewLink: `https://docs.google.com/document/d/${f.id}/edit`,
          createdTime: "2026-01-01T00:00:00.000Z",
          modifiedTime: f.modifiedTime ?? "2026-09-01T00:00:00.000Z",
          owners: [{ displayName: "Dustin Edwards", emailAddress: "owner@test.invalid" }],
          lastModifyingUser: { displayName: "A Coauthor", emailAddress: "coauthor@test.invalid" },
        })),
      });
    }

    if (url.href.startsWith("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart") && request.method === "POST") {
      if (auth !== `Bearer ${USER_TOKEN}`) return json(401, { error: { code: 401 } });
      const boundary = /boundary=(.+)$/.exec(request.headers.get("Content-Type") ?? "")?.[1] ?? "";
      const parts = (await request.text()).split(`--${boundary}`).slice(1, -1).map((p) => p.replace(/^\r\n/, "").split("\r\n\r\n"));
      const meta = JSON.parse(parts[0]![1]!.trim()) as { name: string; mimeType: string };
      if (meta.mimeType !== "application/vnd.google-apps.document") return json(400, { error: "expected a Doc" });
      const content = parts[1]!.slice(1).join("\r\n\r\n").replace(/\r\n$/, "");
      const id = `doc${docs.size + 1}`;
      docs.set(id, { name: meta.name, content });
      return json(200, { id, webViewLink: `https://docs.google.com/document/d/${id}/edit` });
    }

    const exported = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(url.pathname);
    if (url.origin === "https://www.googleapis.com" && exported && request.method === "GET") {
      if (auth !== `Bearer ${USER_TOKEN}`) return json(401, { error: { code: 401 } });
      if (url.searchParams.get("mimeType") !== "text/markdown") return json(400, { error: "mimeType" });
      const doc = docs.get(decodeURIComponent(exported[1]!));
      if (!doc) return json(404, { error: { code: 404 } });
      // Dustin's coauthor edited the Doc; Google exports it as Markdown.
      return new Response(state.docEdits.get(exported[1]!) ?? doc.content, { headers: { "Content-Type": "text/markdown" } });
    }

    const sc = /^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(url.pathname);
    if (url.origin === "https://searchconsole.googleapis.com" && sc && request.method === "POST") {
      if (auth !== `Bearer ${SA_TOKEN}`) return json(401, { error: { code: 401 } });
      if (state.scStatus !== 200) return json(state.scStatus, { error: { code: state.scStatus, message: "User does not have sufficient permission" } });
      return json(200, { rows: opts.scRows ?? [], responseAggregationType: "byPage" });
    }

    throw new Error(`the tests reach only the fake Google, not ${request.method} ${request.url}`);
  }) as typeof globalThis.fetch;

  return { fetch, files, docs, requests, assertions, state };
}
