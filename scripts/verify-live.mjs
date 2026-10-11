// The live gate's verify for Carrel: run by devkit's worker-deploy.yml after the AI door's /health reports
// this run's commit. It asks what a deploy that broke Carrel would answer differently, from outside and
// with no credential, so it needs no secret and no install (Node's standard library and global fetch only):
//
//   1. the AI door's /health is 200 and names EXPECT_SHA, the commit this run deployed;
//   2. the AI door's OAuth metadata is served, with Carrel's own issuer (the provider and OAUTH_KV work);
//   3. the AI door's /mcp refuses a request with no token (the door did not open);
//   4. the AI door answers an unknown path with 404 (the pages are never served there);
//   5. the browser host does not serve Carrel to someone who has not signed in: Access answers first,
//      with a redirect to the team's sign-in or a 401 or 403.
//
// Exit 0 passes. Exit 1 is a REFUSAL, and the workflow rolls the deploy back. Exit 3 is "could not run":
// a check never got an answer (a reset connection, a timeout), so nothing refused the deploy and nothing
// is rolled back. A refusal wins over a missing answer.
//
// CARREL_MCP_ORIGIN and CARREL_ORIGIN override the two origins, for scripts/check-verify-live.mjs, which
// runs this against local stubs.

const MCP = (process.env.CARREL_MCP_ORIGIN || "https://carrel-mcp.dustinedwards.info").replace(/\/+$/, "");
const BROWSER = (process.env.CARREL_ORIGIN || "https://carrel.dustinedwards.info").replace(/\/+$/, "");
const EXPECT_SHA = (process.env.EXPECT_SHA ?? "").trim().toLowerCase();
const TRIES = 3;
// The pause between tries. scripts/check-verify-live.mjs sets it to 0.
const RETRY_MS = Number(process.env.VERIFY_RETRY_MS ?? 2_000);

/** @type {string[]} */
const refusals = [];
/** @type {string[]} */
const unanswered = [];

/**
 * One request, retried only when there was no answer at all. Null when every try went unanswered.
 * @param {string} url @param {RequestInit} [init]
 */
async function ask(url, init = {}) {
  for (let i = 1; i <= TRIES; i++) {
    try {
      return await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), ...init });
    } catch {
      if (i < TRIES) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
  return null;
}

/** @param {string} name @param {string} url @param {(res: Response) => Promise<string | null>} judge @param {RequestInit} [init] */
async function check(name, url, judge, init) {
  const res = await ask(url, init);
  if (!res) {
    unanswered.push(`${name}: no answer from ${url}`);
    return;
  }
  const problem = await judge(res);
  if (problem) refusals.push(`${name}: ${problem}`);
  else console.log(`ok   ${name}`);
}

/** @param {Response} res @returns {Promise<Record<string, unknown> | null>} */
async function json(res) {
  try {
    const body = await res.json();
    return body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body) : null;
  } catch {
    return null;
  }
}

if (!/^[0-9a-f]{7,40}$/.test(EXPECT_SHA)) {
  console.error("verify-live: EXPECT_SHA is not a commit sha, so there is nothing to verify against.");
  process.exit(3);
}

await check("the AI door's /health names this run's commit", `${MCP}/health`, async (res) => {
  if (res.status !== 200) return `answered ${res.status}, not 200`;
  const sha = String((await json(res))?.sha ?? "").toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return `reported '${sha}', not a sha`;
  return sha.startsWith(EXPECT_SHA) || EXPECT_SHA.startsWith(sha) ? null : `reported ${sha}, not ${EXPECT_SHA}`;
});

await check("the AI door serves its OAuth metadata with Carrel's issuer", `${MCP}/.well-known/oauth-authorization-server`, async (res) => {
  if (res.status !== 200) return `answered ${res.status}, not 200`;
  const issuer = String((await json(res))?.issuer ?? "").replace(/\/+$/, "");
  return issuer === MCP ? null : `issuer is '${issuer}', not ${MCP}`;
});

await check(
  "the AI door's /mcp refuses a request with no token",
  `${MCP}/mcp`,
  async (res) => (res.status === 401 ? null : `answered ${res.status}, not 401`),
  { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) },
);

await check("the AI door answers an unknown path with 404", `${MCP}/verify-live-no-such-route`, async (res) =>
  res.status === 404 ? null : `answered ${res.status}, not 404`,
);

await check("the browser host is behind Access", `${BROWSER}/`, async (res) => {
  if (res.status === 401 || res.status === 403) return null;
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") ?? "";
    let host = "";
    try {
      host = new URL(location, BROWSER).hostname;
    } catch {
      // An unparsable Location is not Access.
    }
    return host.endsWith(".cloudflareaccess.com") ? null : `redirected to '${location}', not to Access`;
  }
  return `answered ${res.status} to a request with no sign-in: Access is not in front of Carrel`;
});

for (const line of refusals) console.error(`REFUSED ${line}`);
for (const line of unanswered) console.error(`NO ANSWER ${line}`);
if (refusals.length) process.exit(1);
if (unanswered.length) process.exit(3);
console.log("verify-live: every check passed.");
