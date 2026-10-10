// Rule 12.1 of the MCP ruling (capsid/rulings/mcp-2026-10-10.md): every tool that takes an id proves
// the caller may reach it. Carrel's ids are a project slug (with an item id or a book path inside it)
// and a social event id. Each tool is called by a person the project is not shared with, and by a
// person whose project is another one, and must refuse without writing anything. The checks live in
// the functions the buttons call (requireSiteProject, requireBookProject, aiDraftSocialPost); the
// plants in check:plants remove each one and this file must notice.

import { beforeEach, describe, expect, it } from "vitest";

import { TOOLS } from "~/lib/mcp/tools";

import { addBook, addPerson, addProject, resetDb, share, testEnv } from "./env";
import { connectAs } from "./mcp-client";
import { connectedEnv, fakeSite } from "./site";

const SITE = "de-info";
const BOOK = "wade";
const SCENE = "chapters/01-arrival/01-the-gate.md";

/** Each id-taking tool with arguments that would work for someone the project is shared with. */
const CALLS: Record<string, Record<string, unknown>> = {
  carrel_search_items: { project: SITE },
  carrel_read_item: { project: SITE, item: "post-one" },
  carrel_save_draft: { project: SITE, item: "post-one", source: "---\ntitle: Post one\n---\nNot yours.\n" },
  carrel_preview_item: { project: SITE, item: "post-one", source: "# x" },
  carrel_get_checks: { project: SITE, item: "post-one" },
  carrel_add_finding: { project: SITE, item: "post-one", message: "m" },
  carrel_publish_item: { project: SITE, item: "post-one", expected_version: "v" },
  carrel_list_book_files: { project: BOOK },
  carrel_read_book_file: { project: BOOK, path: SCENE },
  carrel_check_book_text: { project: BOOK, path: SCENE, source: "x" },
  carrel_save_book_draft: { project: BOOK, path: SCENE, source: "x" },
  carrel_add_book_finding: { project: BOOK, path: SCENE, message: "m" },
  carrel_draft_social_post: { account: "germomics-bluesky", project: SITE, item: "post-one", text: "x" },
};

let site: ReturnType<typeof fakeSite>;
let eventId: number;

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const elsewhere = await addPerson("elsewhere@test.invalid");
  await addPerson("stranger@test.invalid");
  const editor = await addPerson("editor@test.invalid");
  const siteId = await addProject(SITE, "dustinedwards");
  await addBook(BOOK);
  const other = await addBook("other-book");
  // An editor of every project here, so only the Owner check stands between them and a social post.
  await share(siteId, editor, "editor");
  await share(other, elsewhere, "editor");
  site = fakeSite();
  await site.adapter.content.saveDraft("post-one", { source: "---\ntitle: Post one\n---\nWords.\n", expectedVersion: null, changeId: "seed" });
  const account = await testEnv.DB.prepare("INSERT INTO social_accounts (key, name, platform, kind, handle, project_id) VALUES ('germomics-bluesky', 'Germomics', 'bluesky', 'brand', 'x', ?) RETURNING id")
    .bind(siteId)
    .first<{ id: number }>();
  const event = await testEnv.DB.prepare("INSERT INTO social_events (account_id, project_id, item_id) VALUES (?, ?, 'post-one') RETURNING id").bind(account!.id, siteId).first<{ id: number }>();
  eventId = event!.id;
});

const connect = (email: string) => connectAs(email, "Claude", { env: connectedEnv(), deps: { fetcher: site.fetch, carrelOrigin: "https://carrel.test" } });

async function written() {
  const counts = await testEnv.DB.batch([
    testEnv.DB.prepare("SELECT COUNT(*) AS n FROM ai_drafts"),
    testEnv.DB.prepare("SELECT COUNT(*) AS n FROM findings"),
    testEnv.DB.prepare("SELECT COUNT(*) AS n FROM social_posts"),
    testEnv.DB.prepare("SELECT COUNT(*) AS n FROM ai_publications"),
  ]);
  return counts.map((c) => (c.results[0] as { n: number }).n);
}

describe("every id-taking tool proves the caller may reach the id", () => {
  it("covers every tool that takes a project, an item, a path or an event id", () => {
    const takesId = TOOLS.filter((t) => ["project", "item", "path", "event_id"].some((key) => key in t.inputSchema.properties)).map((t) => t.name);
    expect(Object.keys(CALLS).sort()).toEqual(takesId.sort());
  });

  for (const [tool, args] of Object.entries(CALLS)) {
    it(`PLANT: ${tool} refuses a person the project is not shared with, and one whose project is another`, async () => {
      for (const email of ["stranger@test.invalid", "elsewhere@test.invalid"]) {
        const result = await (await connect(email)).call(tool, args);
        expect(result.isError, `${tool} as ${email}: ${result.content[0]?.text}`).toBe(true);
      }
      expect(await written()).toEqual([0, 0, 0, 0]);
      expect((await site.adapter.content.get("post-one"))?.status).toBe("draft");
    });
  }

  it("PLANT: a social event id is reachable by the Owner's sessions only, even by an editor of its project", async () => {
    for (const email of ["editor@test.invalid", "stranger@test.invalid"]) {
      const result = await (await connect(email)).call("carrel_draft_social_post", { event_id: eventId, text: "x" });
      expect(result.isError, email).toBe(true);
    }
    expect(await written()).toEqual([0, 0, 0, 0]);
  });
});
