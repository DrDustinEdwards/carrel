// The MCP endpoint and its tools, as an AI client meets them: the protocol in both eras, the tools
// over posts, and the planted refusals from design decision 2 (a shared user's session publishing, a
// reviewer publishing, an Owner's publish with an open flag). The site is site-api's own handler over
// its reference adapter; the email binding is a mailbox the tests read. The session is what the door
// hands over from the OAuth grant: the person and the client, credited by the client's name.

import { beforeEach, describe, expect, it } from "vitest";

import { autosave, readDraft } from "~/lib/content.server";
import { runHealth } from "~/lib/health.server";
import { requireSiteProject } from "~/lib/projects.server";

import { addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectAs, legacyRequest, LEGACY, MCP_HOST, MCP_URL, modernRequest, readMessage } from "./mcp-client";
import { connectedEnv, fakeSite, viewerFor } from "./site";

const SLUG = "de-info";
const CARREL = "https://carrel.test";

type Sent = { from: string; to: string; subject: string; text: string };

function mailbox(fail = false) {
  const sent: Sent[] = [];
  const EMAIL = {
    async send(message: Sent) {
      if (fail) throw new Error("send failed");
      sent.push(message);
      return { messageId: `m${sent.length}` };
    },
  } as unknown as SendEmail;
  return { sent, EMAIL };
}

let site: ReturnType<typeof fakeSite>;
let box: ReturnType<typeof mailbox>;
let env: Env;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const reader = await addPerson("reader@test.invalid");
  const reviewer = await addPerson("reviewer@test.invalid", { reviewer: true });
  await addPerson("stranger@test.invalid");
  const id = await addProject(SLUG, "dustinedwards");
  await share(id, editor, "editor");
  await share(id, reader, "reader");
  await share(id, reviewer, "reader");
  site = fakeSite();
  box = mailbox();
  env = { ...connectedEnv(), EMAIL: box.EMAIL };
});

async function connect(email: string, client = "Claude", e: Env = env) {
  return connectAs(email, client, { env: e, deps: { fetcher: site.fetch, carrelOrigin: CARREL } });
}

/** A post the Owner saved on the site through the buttons' own function, returned with its version. */
async function seedPost(status: "draft" | "published" = "draft") {
  const saved = await site.adapter.content.saveDraft("post-one", { source: "---\ntitle: Post one\n---\nDustin's words.\n", expectedVersion: null, changeId: "seed" });
  if (status === "draft") return saved.version;
  return (await site.adapter.content.publish("post-one", { expectedVersion: saved.version, changeId: "seed-publish" })).version;
}

describe("the protocol", () => {
  it("lists the tools in the 2026-07-28 era, each carrying the rule", async () => {
    const tools = await (await connect("owner@test.invalid")).list();
    expect(tools.map((t) => t.name)).toEqual(["carrel_list_projects", "carrel_search_items", "carrel_read_item", "carrel_save_draft", "carrel_preview_item", "carrel_get_checks", "carrel_add_finding", "carrel_publish_item", "carrel_list_book_files", "carrel_read_book_file", "carrel_check_book_text", "carrel_save_book_draft", "carrel_add_book_finding", "carrel_draft_social_post"]);
    for (const tool of tools) expect(tool.description).toContain("AI never rewrites Dustin's prose unasked.");
  });

  it("answers a 2025-era client through the legacy shim: initialize, then calls with no session", async () => {
    const ai = await connect("reader@test.invalid");
    const init = await readMessage(
      await ai.send(legacyRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "Claude Code", version: "2.1" } } })),
    );
    expect(init.result).toMatchObject({ protocolVersion: LEGACY, serverInfo: { name: "carrel" }, capabilities: { tools: {} } });
    const legacy = await connectAs("reader@test.invalid", "Claude", { env, deps: { fetcher: site.fetch, carrelOrigin: CARREL }, era: "legacy" });
    expect((await legacy.list()).length).toBe(14);
    expect((await legacy.call("carrel_list_projects")).structuredContent).toMatchObject({ projects: [{ slug: SLUG, role: "reader" }] });
  });

  it("answers an unknown protocol version at initialize with one it speaks", async () => {
    const ai = await connect("owner@test.invalid");
    const init = await readMessage(await ai.send(legacyRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "x", version: "1" } } })));
    expect(["2025-11-25", "2025-06-18", "2025-03-26"]).toContain(init.result?.protocolVersion);
  });

  it("PLANT: a page elsewhere cannot drive the tools, a rebinding host is refused, and GET, DELETE, 2026-era batches and bad JSON are refused", async () => {
    const ai = await connect("owner@test.invalid");
    expect((await ai.send(modernRequest(2, "tools/list", {}, { Origin: "https://evil.example" }))).status).toBe(403);
    expect((await ai.send(modernRequest(2, "tools/list", {}, { Host: "evil.example" }))).status).toBe(403);
    expect((await ai.send(new Request(MCP_URL, { headers: { Host: MCP_HOST, Accept: "text/event-stream" } }))).status).toBe(405);
    expect((await ai.send(new Request(MCP_URL, { method: "DELETE", headers: { Host: MCP_HOST } }))).status).toBe(405);
    const one = modernRequest(1, "tools/list");
    const body = [JSON.parse(await one.clone().text()), JSON.parse(await one.clone().text())];
    const batch = await ai.send(new Request(one, { body: JSON.stringify(body) }));
    // Refused in the design-center era. The legacy shim answers 2025-era batches as that era allowed;
    // each message in one still runs as this same session, so a batch widens nothing.
    expect(batch.status).toBe(400);
    const bad = new Request(MCP_URL, { method: "POST", body: "{not json", headers: { Host: MCP_HOST, "Content-Type": "application/json", Accept: "application/json, text/event-stream" } });
    expect((await ai.send(bad)).status).toBe(400);
  });
});

describe("reading, drafting, flagging", () => {
  it("lists projects, searches and reads posts through the buttons' own functions", async () => {
    await seedPost();
    const ai = await connect("reader@test.invalid");
    expect((await ai.call("carrel_list_projects")).structuredContent).toMatchObject({ projects: [{ slug: SLUG, role: "reader" }] });
    const read = await ai.call("carrel_read_item", { project: SLUG, item: "post-one" });
    expect(read.isError).toBeUndefined();
    expect(read.structuredContent).toMatchObject({ site: { id: "post-one", title: "Post one" }, dustinsDraft: null, aiDrafts: [], flags: [] });
  });

  it("PLANT: a stranger's session reads nothing", async () => {
    const ai = await connect("stranger@test.invalid");
    const result = await ai.call("carrel_read_item", { project: SLUG, item: "post-one" });
    expect(result).toMatchObject({ isError: true, content: [{ text: "Not found, or not shared with this person." }] });
  });

  it("saves an AI draft beside Dustin's, never over his draft or the site's text", async () => {
    const version = await seedPost();
    const owner = await viewerFor("owner@test.invalid");
    const project = await requireSiteProject(testEnv.DB, owner, SLUG, "read");
    await autosave(testEnv.DB, project, owner, "post-one", { source: "Dustin's working draft.", baseVersion: version });

    const ai = await connect("owner@test.invalid");
    const saved = await ai.call("carrel_save_draft", { project: SLUG, item: "post-one", source: "An AI rewrite.", note: "Tightened the opening." });
    expect(saved.structuredContent).toMatchObject({ saved: true, basedOnVersion: version });
    expect((await readDraft(testEnv.DB, project, owner, "post-one"))?.source).toBe("Dustin's working draft.");
    expect((await site.adapter.content.get("post-one"))?.source).toBe("---\ntitle: Post one\n---\nDustin's words.\n");
    expect(site.requests.filter((r) => !r.startsWith("GET"))).toEqual([]);
    const read = await ai.call("carrel_read_item", { project: SLUG, item: "post-one" });
    expect(read.structuredContent).toMatchObject({ aiDrafts: [{ client: "Claude", note: "Tightened the opening." }] });
  });

  it("PLANT: a Reader's session and a reviewer's cannot save a draft", async () => {
    await seedPost();
    expect(await (await connect("reader@test.invalid")).call("carrel_save_draft", { project: SLUG, item: "post-one", source: "x" })).toMatchObject({
      isError: true,
      content: [{ text: "You may not write drafts on this project." }],
    });
    expect(await (await connect("reviewer@test.invalid")).call("carrel_save_draft", { project: SLUG, item: "post-one", source: "x" })).toMatchObject({
      isError: true,
      content: [{ text: "A reviewer flags; it does not write text. Use carrel_add_finding." }],
    });
  });

  it("lets a reviewer flag, once per flag, credited to its client", async () => {
    await seedPost();
    const reviewer = await connect("reviewer@test.invalid", "Grok Build");
    const args = { project: SLUG, item: "post-one", message: "This number has no source.", excerpt: "Dustin's words." };
    expect((await reviewer.call("carrel_add_finding", args)).structuredContent).toMatchObject({ flagged: true, alreadyFlagged: false });
    expect((await reviewer.call("carrel_add_finding", args)).structuredContent).toMatchObject({ alreadyFlagged: true });
    const checks = await (await connect("owner@test.invalid")).call("carrel_get_checks", { project: SLUG, item: "post-one" });
    expect(checks.structuredContent).toMatchObject({ open: 1, flags: [{ check: "review", message: "This number has no source. (from Grok Build)" }] });
  });

  it("previews through the site's own renderer", async () => {
    await seedPost();
    const result = await (await connect("reader@test.invalid")).call("carrel_preview_item", { project: SLUG, item: "post-one", source: "---\ntitle: T\n---\nHello." });
    expect(result.isError).toBeUndefined();
    expect(String(result.structuredContent?.html)).toContain("Hello.");
  });
});

describe("publish by instruction (decision 2)", () => {
  it("PLANT: a shared user's session publishing is refused, and the site and inbox hear nothing", async () => {
    const version = await seedPost();
    const result = await (await connect("editor@test.invalid")).call("carrel_publish_item", { project: SLUG, item: "post-one", expected_version: version });
    expect(result).toMatchObject({ isError: true, content: [{ text: "Only the Owner's own sessions may publish." }] });
    expect((await site.adapter.content.get("post-one"))?.status).toBe("draft");
    expect(site.requests.filter((r) => !r.startsWith("GET"))).toEqual([]);
    expect(box.sent).toEqual([]);
  });

  it("PLANT: a reviewer publishing is refused", async () => {
    const version = await seedPost();
    const result = await (await connect("reviewer@test.invalid")).call("carrel_publish_item", { project: SLUG, item: "post-one", expected_version: version });
    expect(result).toMatchObject({ isError: true, content: [{ text: "A reviewer never publishes." }] });
    expect((await site.adapter.content.get("post-one"))?.status).toBe("draft");
  });

  it("PLANT: the Owner's AI publish with an open flag is refused, naming the flag", async () => {
    const version = await seedPost();
    await (await connect("reviewer@test.invalid", "Grok Build")).call("carrel_add_finding", { project: SLUG, item: "post-one", message: "Unsourced claim." });
    const result = await (await connect("owner@test.invalid")).call("carrel_publish_item", { project: SLUG, item: "post-one", expected_version: version });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      "Publish is refused while 1 flag is open on this post: Unsourced claim. (from Grok Build) Dustin fixes the text or dismisses each flag in Carrel first.",
    );
    expect((await site.adapter.content.get("post-one"))?.status).toBe("draft");
    expect(box.sent).toEqual([]);
  });

  it("the Owner's AI publish with clean checks publishes, credits the client, and emails Dustin an unpublish link", async () => {
    const version = await seedPost();
    const result = await (await connect("owner@test.invalid", "Claude")).call("carrel_publish_item", { project: SLUG, item: "post-one", expected_version: version });
    expect(result.structuredContent).toMatchObject({ published: true, dustinEmailed: true });
    expect((await site.adapter.content.get("post-one"))?.status).toBe("published");

    const change = await testEnv.DB.prepare("SELECT action, client FROM changes WHERE item_id = 'post-one'").first();
    expect(change).toEqual({ action: "publish", client: "Claude" });
    const record = await testEnv.DB.prepare("SELECT client, emailed_at, email_error FROM ai_publications").first<{ client: string; emailed_at: string | null; email_error: string | null }>();
    expect(record).toMatchObject({ client: "Claude", email_error: null });
    expect(record!.emailed_at).not.toBeNull();

    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]).toMatchObject({ to: "owner@test.invalid", subject: 'Carrel: Claude published "Post one"' });
    expect(box.sent[0]!.text).toContain("Published by Claude on Dustin's instruction.");
    expect(box.sent[0]!.text).toContain(`Unpublish it: ${CARREL}/p/${SLUG}/e/post-one/unpublish`);
  });

  it("PLANT: publish sends no text, so an AI draft can never be what goes live", async () => {
    const version = await seedPost();
    const ai = await connect("owner@test.invalid");
    await ai.call("carrel_save_draft", { project: SLUG, item: "post-one", source: "---\ntitle: Post one\n---\nAI words.\n" });
    await ai.call("carrel_publish_item", { project: SLUG, item: "post-one", expected_version: version });
    expect((await site.adapter.content.get("post-one"))?.source).toBe("---\ntitle: Post one\n---\nDustin's words.\n");
  });

  it("PLANT: a stale expected version is refused by the site", async () => {
    await seedPost();
    const result = await (await connect("owner@test.invalid")).call("carrel_publish_item", { project: SLUG, item: "post-one", expected_version: "stale" });
    expect(result.isError).toBe(true);
    expect((await site.adapter.content.get("post-one"))?.status).toBe("draft");
  });

  it("keeps the publish when the email fails, records why, and the health check reports it", async () => {
    const version = await seedPost();
    const failing = mailbox(true);
    const e = { ...env, EMAIL: failing.EMAIL };
    const result = await (await connect("owner@test.invalid", "Claude", e)).call("carrel_publish_item", { project: SLUG, item: "post-one", expected_version: version });
    expect(result.structuredContent).toMatchObject({ published: true, dustinEmailed: false });

    const health = mailbox();
    const { results } = await runHealth({ ...testEnv, EMAIL: health.EMAIL }, async () => Response.json({ keys: [{ kid: "k" }] }));
    expect(results.find((r) => r.name === "ai-publish-email")).toMatchObject({ ok: false, detail: "1 AI publish was not emailed: post-one by Claude (send failed)." });
  });
});
