// Named agent keys at the AI door (job_77fd33040bdd). An agent that cannot complete OAuth (Grok Build)
// presents a key, and the key's Worker secret NAME is the agent: AGENT_KEY_GROK is "grok". The key
// says who is knocking and grants nothing: the agent is the person row "agent:grok" in People, its
// role comes from there, and it is credited as "agent:grok", never as Dustin. Every refusal below
// must end with nothing written, and each is planted in scripts/plant-gates.mjs or by hand (see the
// PR) and must turn the named test red.

import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentPrincipal, keysMatch } from "~/lib/agent-keys.server";
import { addAgent, listPeople, PeopleRefusal, setProjectRole } from "~/lib/people-admin.server";
import { findAgentViewer } from "~/lib/people.server";
import { aiDoor } from "~/lib/mcp/door";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { MCP_HOST, modernRequest, readMessage, type ToolCallResult } from "./mcp-client";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const KEY = "grok-test-key-0123456789abcdefghijklmnop";
const OTHER_KEY = "other-test-key-0123456789abcdefghijklmnop";
const SLUG = "de-info";
const UNSHARED = "other-site";

let site: ReturnType<typeof fakeSite>;
let agentId: number;
let projectId: number;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  agentId = await addPerson("agent:grok");
  projectId = await addProject(SLUG, "dustinedwards");
  await addProject(UNSHARED, "foxing");
  await share(projectId, agentId, "editor");
  site = fakeSite();
  vi.stubGlobal("fetch", site.fetch);
});

afterEach(() => vi.unstubAllGlobals());

const env = (extra: Record<string, string> = {}): Env => connectedEnv({ AGENT_KEY_GROK: KEY, ...extra });

async function door(request: Request, e: Env = env()) {
  return aiDoor(request, e, createExecutionContext());
}

function authed(authorization: string | null, name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return modernRequest(3, "tools/call", { name, arguments: args }, { ...(authorization ? { Authorization: authorization } : {}), ...headers });
}

async function call(name: string, args: Record<string, unknown> = {}, opts: { key?: string; env?: Env; headers?: Record<string, string> } = {}) {
  const response = await door(authed(`Bearer ${opts.key ?? KEY}`, name, args, opts.headers), opts.env);
  if (response.status !== 200) return { status: response.status, result: undefined as ToolCallResult | undefined };
  return { status: 200, result: (await readMessage(response)).result as unknown as ToolCallResult };
}

async function seedPost() {
  return (await site.adapter.content.saveDraft("post-one", { source: "---\ntitle: Post one\n---\nDustin's words.\n", expectedVersion: null, changeId: "seed" })).version;
}

const rows = async (sql: string) => (await testEnv.DB.prepare(sql).all()).results;

describe("what a named agent key does", () => {
  it("lets the agent read, save an AI draft beside Dustin's, flag and preview, credited as agent:grok", async () => {
    await seedPost();
    const listed = await call("list_projects");
    expect(listed.result!.structuredContent).toMatchObject({ projects: [{ slug: SLUG, role: "editor" }] });
    expect(((listed.result!.structuredContent as { projects: unknown[] }).projects).length).toBe(1);

    const saved = await call("save_draft", { project: SLUG, item: "post-one", source: "---\ntitle: Post one\n---\nGrok's try.\n", note: "A try." });
    expect(saved.result!.isError).toBeUndefined();
    expect(await rows("SELECT client, source FROM ai_drafts")).toEqual([{ client: "agent:grok", source: "---\ntitle: Post one\n---\nGrok's try.\n" }]);
    const owner = await viewerFor("owner@test.invalid");
    expect(await rows(`SELECT person_id FROM ai_drafts WHERE person_id = ${owner.id}`)).toEqual([]);
    expect(await rows(`SELECT person_id FROM ai_drafts WHERE person_id = ${agentId}`)).toHaveLength(1);

    const flagged = await call("add_finding", { project: SLUG, item: "post-one", message: "A flag." });
    expect(flagged.result!.structuredContent).toMatchObject({ flagged: true });
    expect(await rows("SELECT message FROM findings")).toEqual([{ message: "A flag. (from agent:grok)" }]);

    const preview = await call("preview", { project: SLUG, item: "post-one" });
    expect(preview.result!.isError).toBeUndefined();

    // Nothing reached the site's record: an agent's saved draft lives only in Carrel, and nothing is credited to Dustin.
    expect(await rows("SELECT id FROM changes")).toEqual([]);
    expect(site.requests.filter((r) => (r.startsWith("POST") || r.startsWith("PUT")) && !r.endsWith("/preview"))).toEqual([]);
  });

  it("PLANT: a key trying publish is refused with the Owner-only message, and nothing is published", async () => {
    const version = await seedPost();
    const { result } = await call("publish", { project: SLUG, item: "post-one", expected_version: version });
    expect(result).toMatchObject({ isError: true, content: [{ text: "Only the Owner's own sessions may publish." }] });
    expect((await site.adapter.content.get("post-one"))!.status).not.toBe("published");
    expect(await rows("SELECT * FROM ai_publications")).toEqual([]);
    expect(await rows("SELECT id FROM changes")).toEqual([]);
  });

  it("PLANT: the role is the person's role in People, never the key's: a Reader agent cannot save a draft", async () => {
    await seedPost();
    await testEnv.DB.prepare("UPDATE project_members SET role = 'reader' WHERE person_id = ?").bind(agentId).run();
    const { result } = await call("save_draft", { project: SLUG, item: "post-one", source: "x" });
    expect(result).toMatchObject({ isError: true, content: [{ text: "You may not write drafts on this project." }] });
    expect(await rows("SELECT id FROM ai_drafts")).toEqual([]);
  });

  it("PLANT: a project the agent has no role on is not there for it: not listed, not read, not drafted, not flagged", async () => {
    const { result: listed } = await call("list_projects");
    expect(JSON.stringify(listed!.structuredContent)).not.toContain(UNSHARED);
    for (const [name, args] of [
      ["search_items", {}],
      ["read_item", { item: "post-one" }],
      ["save_draft", { item: "post-one", source: "x" }],
      ["add_finding", { item: "post-one", message: "m" }],
      ["publish", { item: "post-one", expected_version: "v" }],
    ] as const) {
      const { result } = await call(name, { project: UNSHARED, ...args });
      expect(result, name).toMatchObject({ isError: true, content: [{ text: "Not found, or not shared with this person." }] });
    }
    expect(await rows("SELECT id FROM ai_drafts")).toEqual([]);
    expect(await rows("SELECT id FROM findings")).toEqual([]);
  });

  it("PLANT: a row marked Owner is never an agent: the key is refused", async () => {
    // The database allows one Owner, so the real one has to go before the agent's row can be flagged.
    await testEnv.DB.prepare("DELETE FROM people WHERE email = 'owner@test.invalid'").run();
    await testEnv.DB.prepare("UPDATE people SET is_owner = 1 WHERE email = 'agent:grok'").run();
    expect(await findAgentViewer(testEnv.DB, "grok")).toBeNull();
    expect((await call("list_projects")).status).toBe(403);
  });
});

describe("what a named agent key refuses", () => {
  it("PLANT: an unknown key is refused by the OAuth path: 401 with the Bearer challenge, nothing run", async () => {
    const response = await door(authed(`Bearer ${OTHER_KEY}`, "list_projects"));
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
    const near = await door(authed(`Bearer ${KEY}x`, "list_projects"));
    expect(near.status).toBe(401);
    const short = await door(authed(`Bearer ${KEY.slice(0, -1)}`, "list_projects"));
    expect(short.status).toBe(401);
  });

  it("PLANT: a key whose secret is absent is refused, and so is one that was revoked by deleting the secret", async () => {
    const without = connectedEnv();
    expect((await call("list_projects", {}, { env: without })).status).toBe(401);
    const revoked: Env = { ...env() };
    delete revoked.AGENT_KEY_GROK;
    expect((await call("list_projects", {}, { env: revoked })).status).toBe(401);
    // A blank secret admits nobody, and is not a key that matches the empty string.
    expect((await call("list_projects", {}, { env: env({ AGENT_KEY_GROK: "  " }), key: " " })).status).toBe(401);
  });

  it("PLANT: a key whose person row is disabled, or missing, is refused at once, and never falls through to OAuth", async () => {
    expect((await call("list_projects")).status).toBe(200);
    await testEnv.DB.prepare("UPDATE people SET disabled_at = '2026-10-07T00:00:00Z' WHERE email = 'agent:grok'").run();
    expect((await call("list_projects")).status).toBe(403);
    await testEnv.DB.prepare("DELETE FROM project_members").run();
    await testEnv.DB.prepare("DELETE FROM people WHERE email = 'agent:grok'").run();
    expect((await call("list_projects")).status).toBe(403);
    expect(await rows("SELECT id FROM ai_drafts")).toEqual([]);
  });

  it("PLANT: the agent's name is the secret's name, never the request's: a header or body naming another agent changes nothing", async () => {
    await addPerson("agent:other");
    await share(projectId, (await viewerFor("agent:other")).id, "editor");
    await seedPost();
    const claims = {
      "X-Agent": "other",
      "X-Agent-Name": "other",
      "X-Carrel-Agent": "agent:other",
      "X-Forwarded-User": "owner@test.invalid",
      "Cf-Access-Authenticated-User-Email": "owner@test.invalid",
      "Cf-Access-Jwt-Assertion": "x.y.z",
      "Mcp-Client": "agent:other",
    };
    const saved = await call("save_draft", { project: SLUG, item: "post-one", source: "x" }, { headers: claims });
    expect(saved.result!.isError).toBeUndefined();
    // A body that claims an identity is refused by the tool's own schema; nothing is written.
    for (const claim of [{ agent: "other" }, { client: "agent:other" }, { person: "owner@test.invalid" }]) {
      const refused = await door(authed(`Bearer ${KEY}`, "save_draft", { project: SLUG, item: "post-one", source: "y", ...claim }, claims));
      expect(JSON.stringify(await readMessage(refused)), JSON.stringify(claim)).toMatch(/error|invalid|unrecognized|additional/i);
    }
    expect(await rows("SELECT client FROM ai_drafts")).toEqual([{ client: "agent:grok" }]);
    // Two agents with two keys: each key is its own name, whichever the request claims to be.
    const second = await call("save_draft", { project: SLUG, item: "post-one", source: "z" }, { env: env({ AGENT_KEY_OTHER: OTHER_KEY }), key: OTHER_KEY, headers: { "X-Agent-Name": "grok" } });
    expect(second.result!.isError).toBeUndefined();
    expect((await rows("SELECT client FROM ai_drafts ORDER BY id")).map((r) => r.client)).toEqual(["agent:grok", "agent:other"]);
  });

  it("PLANT: a malformed Authorization header is never an agent: it goes to the OAuth path and is refused there", async () => {
    for (const header of [`Basic ${KEY}`, "Bearer", "Bearer ", `Bearer ${KEY} extra`, `Token ${KEY}`, KEY, `Bearer\t${KEY}`, ""]) {
      expect((await door(authed(header || null, "list_projects"))).status, header).toBe(401);
    }
    // The scheme is case-insensitive, as HTTP's is.
    expect((await door(authed(`bearer ${KEY}`, "list_projects"))).status).toBe(200);
  });

  it("is inert until a secret exists: with none, the door answers as it did before", async () => {
    const none = connectedEnv();
    expect(await agentPrincipal(none, `Bearer ${KEY}`)).toBeNull();
    const response = await door(modernRequest(1, "tools/list"), none);
    expect(response.status).toBe(401);
  });

  it("keeps the agent key to /mcp: another path on the door is never an agent's", async () => {
    for (const path of ["/", "/p/de-info", "/authorize", "/token", "/health"]) {
      const response = await door(new Request(`https://${MCP_HOST}${path}`, { headers: { Authorization: `Bearer ${KEY}` } }));
      if (path !== "/health") expect(response.status, path).toBeGreaterThanOrEqual(400);
      expect(await response.text(), path).not.toContain("projects");
    }
  });
});

describe("how the key is read", () => {
  it("names the agent from the secret's name, lower-cased, and only a valid name", async () => {
    expect(await agentPrincipal({ AGENT_KEY_GROK: KEY }, `Bearer ${KEY}`)).toBe("grok");
    expect(await agentPrincipal({ AGENT_KEY_Mixed_Case: KEY }, `Bearer ${KEY}`)).toBe("mixed_case");
    for (const name of ["AGENT_KEY_", "AGENT_KEY_has space", "AGENT_KEY_" + "x".repeat(33), "AGENT_KEY_-lead", "NOT_AGENT_KEY_GROK", "agent_key_grok"]) {
      expect(await agentPrincipal({ [name]: KEY }, `Bearer ${KEY}`), name).toBeNull();
    }
    expect(await agentPrincipal({ AGENT_KEY_GROK: 7 as unknown as string }, `Bearer 7`)).toBeNull();
  });

  it("picks the right agent among several and refuses a key that is none of them", async () => {
    const e = { AGENT_KEY_GROK: KEY, AGENT_KEY_OTHER: OTHER_KEY };
    expect(await agentPrincipal(e, `Bearer ${OTHER_KEY}`)).toBe("other");
    expect(await agentPrincipal(e, `Bearer ${KEY}`)).toBe("grok");
    expect(await agentPrincipal(e, "Bearer nope")).toBeNull();
    expect(await agentPrincipal(e, null)).toBeNull();
  });

  it("compares digests: equal keys match, and any difference in content or length does not", async () => {
    expect(await keysMatch(KEY, KEY)).toBe(true);
    expect(await keysMatch(KEY, `${KEY}x`)).toBe(false);
    expect(await keysMatch(KEY, KEY.slice(1))).toBe(false);
    expect(await keysMatch(KEY, OTHER_KEY)).toBe(false);
    expect(await keysMatch("", KEY)).toBe(false);
  });
});

describe("adding an agent in People", () => {
  it("is the Owner's alone, and the agent row is never an Owner or a reviewer, with no role until one is set", async () => {
    const owner = await viewerFor("owner@test.invalid");
    const added = await addAgent(testEnv.DB, owner, { name: " Claude-Two ", label: "Claude Two" });
    expect(added).toMatchObject({ email: "agent:claude-two", name: "Claude Two", isOwner: false, isReviewer: false, roles: [] });
    expect(await findAgentViewer(testEnv.DB, "claude-two")).toMatchObject({ email: "agent:claude-two" });

    const editor = await addPerson("editor@test.invalid");
    await share(projectId, editor, "editor");
    await expect(addAgent(testEnv.DB, await viewerFor("editor@test.invalid"), { name: "sneaky" })).rejects.toMatchObject({ status: 404 });
    await expect(addAgent(testEnv.DB, await viewerFor("agent:grok"), { name: "sneaky" })).rejects.toMatchObject({ status: 404 });
    expect(await rows("SELECT email FROM people WHERE email = 'agent:sneaky'")).toEqual([]);
  });

  it("refuses a duplicate and a name that is not a name, and changes nothing", async () => {
    const owner = await viewerFor("owner@test.invalid");
    const before = await rows("SELECT email FROM people");
    for (const name of ["grok", "GROK", "", "a b", "a@b.co", "-x", "x".repeat(33), "agent:x"]) {
      await expect(addAgent(testEnv.DB, owner, { name }), name).rejects.toBeInstanceOf(PeopleRefusal);
    }
    expect(await rows("SELECT email FROM people")).toEqual(before);
  });

  it("lists the agent and lets the Owner set its role like anyone's, Editor allowed", async () => {
    const owner = await viewerFor("owner@test.invalid");
    await addAgent(testEnv.DB, owner, { name: "fresh" });
    const fresh = (await viewerFor("agent:fresh")).id;
    await setProjectRole(testEnv.DB, owner, fresh, projectId, "editor");
    const { people } = await listPeople(testEnv.DB, owner);
    expect(people.find((p) => p.email === "agent:fresh")!.roles).toEqual([{ projectId, role: "editor" }]);
  });
});
