// Writing 2 and 3 (job_b4555715afcf): the binder and corkboard reorder a book by renaming its numbered
// files in ONE commit, carrying Carrel's records to the new paths; a file's history lists its
// versions (saved in Carrel, moved, or committed elsewhere) back through its moves, and any two, or
// Dustin's text and an AI draft, compare.

import { RouterContextProvider } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { reorderBook } from "~/lib/binder.server";
import { refreshBook, requireBookProject, saveBookFile } from "~/lib/books.server";
import { autosave } from "~/lib/content.server";
import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { describe as describeFile, isBookPath } from "~/lib/novels/layout";
import { clearTokenCache, GitConflict } from "~/lib/novels/repo.server";
import { binderTree, canMoveTo, currentOrder, firstSentence, orderFromTree, parseOrder, planRenames, siteBinderTree, withChapterOrder } from "~/lib/writing/binder";
import { action as bookAction } from "~/routes/book";
import { action as corkAction, loader as corkLoader } from "~/routes/book.corkboard";
import { loader as historyLoader } from "~/routes/book.history";

import { addBook, addPerson, resetDb, share, testEnv } from "./env";
import { fakeNovels, githubStyleKey } from "./novels";
import { viewerFor } from "./site";

const SLUG = "test-book";
const A1 = "chapters/01-arrival/01-the-gate.md";
const A2 = "chapters/01-arrival/02-supper.md";
const B1 = "chapters/02-the-crossing/01-the-chain.md";
const B2 = "chapters/02-the-crossing/02-the-bank.md";
const PATHS = [A1, A2, B1, B2, "book.md", "bible/characters/wade.md"];

// ---------- pure

describe("planning a reorder", () => {
  it("renumbers the scenes of a chapter when one moves within it", () => {
    const plan = planRenames(PATHS, withChapterOrder(PATHS, "01-arrival", [A2, A1]));
    expect(plan).toEqual({
      ok: true,
      renames: [
        { from: A2, to: "chapters/01-arrival/01-supper.md" },
        { from: A1, to: "chapters/01-arrival/02-the-gate.md" },
      ],
    });
  });

  it("renumbers both chapters when a scene moves from one to the other", () => {
    const plan = planRenames(PATHS, [
      { chapter: "01-arrival", scenes: [A1, B1, A2] },
      { chapter: "02-the-crossing", scenes: [B2] },
    ]);
    expect(plan).toEqual({
      ok: true,
      renames: [
        { from: B1, to: "chapters/01-arrival/02-the-chain.md" },
        { from: A2, to: "chapters/01-arrival/03-supper.md" },
        { from: B2, to: "chapters/02-the-crossing/01-the-bank.md" },
      ],
    });
  });

  it("renames every file of a chapter that moves, and closes up behind a chapter left empty", () => {
    expect(planRenames(PATHS, [currentOrder(PATHS)[1]!, currentOrder(PATHS)[0]!])).toEqual({
      ok: true,
      renames: [
        { from: B1, to: "chapters/01-the-crossing/01-the-chain.md" },
        { from: B2, to: "chapters/01-the-crossing/02-the-bank.md" },
        { from: A1, to: "chapters/02-arrival/01-the-gate.md" },
        { from: A2, to: "chapters/02-arrival/02-supper.md" },
      ],
    });
    const emptied = planRenames(PATHS, [
      { chapter: "01-arrival", scenes: [] },
      { chapter: "02-the-crossing", scenes: [A1, A2, B1, B2] },
    ]);
    expect(emptied.ok && emptied.renames.map((r) => r.to)).toEqual([
      "chapters/01-the-crossing/01-the-gate.md",
      "chapters/01-the-crossing/02-supper.md",
      "chapters/01-the-crossing/03-the-chain.md",
      "chapters/01-the-crossing/04-the-bank.md",
    ]);
  });

  it("moves nothing when the order is the one there is", () => {
    expect(planRenames(PATHS, currentOrder(PATHS))).toEqual({ ok: true, renames: [] });
  });

  it("PLANT: refuses an order that loses, repeats or invents a scene or a chapter", () => {
    const now = currentOrder(PATHS);
    expect(planRenames(PATHS, [{ chapter: "01-arrival", scenes: [A1] }, now[1]!]).ok).toBe(false);
    expect(planRenames(PATHS, [{ chapter: "01-arrival", scenes: [A1, A2, A2] }, now[1]!]).ok).toBe(false);
    expect(planRenames(PATHS, [{ chapter: "01-arrival", scenes: [A1, A2, "chapters/01-arrival/03-new.md"] }, now[1]!]).ok).toBe(false);
    expect(planRenames(PATHS, [now[0]!]).ok).toBe(false);
    expect(planRenames(PATHS, [...now, { chapter: "03-later", scenes: [] }]).ok).toBe(false);
  });

  it("numbers past 99 with three digits, which the layout reads in order", () => {
    const many = Array.from({ length: 100 }, (_, i) => `chapters/01-long/${String(i + 1).padStart(2, "0")}-s${i}.md`.replace("/100-", "/100-"));
    const plan = planRenames(many, withChapterOrder(many, "01-long", [...many].reverse()));
    expect(plan.ok && plan.renames[0]).toEqual({ from: many[99], to: "chapters/01-long/001-s99.md" });
    expect(plan.ok && plan.renames.every((r) => isBookPath(r.to))).toBe(true);
  });
});

describe("the binder's tree", () => {
  const files = [A1, A2, B1, "book.md", "bible/characters/wade.md", "outline/plan.md", "notes/ideas.md"].map((path) => ({ path, ...describeFile(path, "---\nstatus: Drafting\nname: Wade Pruitt\n---\nTwo words.\n") }));

  it("shows the title page, chapters with their scenes, the bible, the outline and notes", () => {
    const tree = binderTree(files, "/b/x");
    expect(tree.map((n) => n.label)).toEqual(["Title page", "Chapters", "Bible", "Outline", "Notes"]);
    const chapters = tree[1]!.children!;
    expect(chapters.map((c) => [c.label, c.meta, c.children!.map((s) => [s.label, s.meta, s.href])])).toEqual([
      ["Arrival", "4 words", [["The gate", "Drafting, 2 words", `/b/x/f/${A1}`], ["Supper", "Drafting, 2 words", `/b/x/f/${A2}`]]],
      ["The crossing", "2 words", [["The chain", "Drafting, 2 words", `/b/x/f/${B1}`]]],
    ]);
    expect(tree[2]!.children![0]!.children![0]!.label).toBe("Wade Pruitt");
    expect(tree[4]!.children!.map((n) => n.href)).toEqual(["/b/x/f/notes/ideas.md"]);
    expect(orderFromTree(tree)).toEqual(currentOrder(files.map((f) => f.path)));
  });

  it("PLANT: lets a scene move only into a chapter, and a chapter only among chapters", () => {
    expect(canMoveTo(`f:${A1}`, "ch:02-the-crossing")).toBe(true);
    expect(canMoveTo(`f:${A1}`, "group:chapters")).toBe(false);
    expect(canMoveTo(`f:${A1}`, null)).toBe(false);
    expect(canMoveTo("ch:01-arrival", "group:chapters")).toBe(true);
    expect(canMoveTo("ch:01-arrival", "ch:02-the-crossing")).toBe(false);
    expect(canMoveTo("f:bible/characters/wade.md", "group:bible-places")).toBe(false);
    expect(canMoveTo("f:book.md", "group:chapters")).toBe(false);
  });

  it("admits notes as flat files, and nothing deeper", () => {
    expect(isBookPath("notes/ideas.md")).toBe(true);
    expect(isBookPath("notes/a/b.md")).toBe(false);
  });

  it("reads a posted order and refuses anything else", () => {
    expect(parseOrder(JSON.stringify([{ chapter: "01-a", scenes: [A1] }]))).toEqual([{ chapter: "01-a", scenes: [A1] }]);
    for (const bad of ["nope", "{}", '[{"chapter":1,"scenes":[]}]', '[{"chapter":"a","scenes":[1]}]']) expect(parseOrder(bad)).toBeNull();
  });

  it("groups a site's writing by kind, posts first", () => {
    const tree = siteBinderTree(
      [
        { itemId: "about", kind: "page", title: "About", status: "published" },
        { itemId: "foxhound", kind: "post", title: "Foxhound", status: "draft" },
      ],
      "/p/site",
    );
    expect(tree.map((k) => [k.label, k.children!.map((c) => [c.label, c.meta, c.href])])).toEqual([
      ["Posts", [["Foxhound", "Draft", "/p/site/e/foxhound"]]],
      ["Pages", [["About", "Published", "/p/site/e/about"]]],
    ]);
  });

  it("gives a card with no summary the first sentence of its scene", () => {
    expect(firstSentence("# Heading\n\nThe gate was shut. Wade waited.")).toBe("The gate was shut.");
    expect(firstSentence("x".repeat(300)).length).toBe(162);
  });
});

// ---------- the repository, the server and the routes

let key: string;
beforeAll(async () => {
  key = (await githubStyleKey()).pkcs1Pem;
});

let gh: ReturnType<typeof fakeNovels>;
let env: Env;
const scene = (pov: string, text: string) => `---\nstatus: Drafting\npov: ${pov}\n---\n\n${text}\n`;

beforeEach(async () => {
  clearTokenCache();
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const reader = await addPerson("reader@test.invalid");
  const id = await addBook(SLUG);
  await share(id, editor, "editor");
  await share(id, reader, "reader");
  gh = fakeNovels({
    [`${SLUG}/book.md`]: "---\ntitle: T\n---\n",
    [`${SLUG}/${A1}`]: scene("Nell", "Nell came to the gate."),
    [`${SLUG}/${A2}`]: scene("Nell", "They ate."),
    [`${SLUG}/${B1}`]: scene("Wade", "The chain held."),
    [`${SLUG}/${B2}`]: scene("Wade", "The bank gave way."),
    [`${SLUG}/outline/plan.md`]: "# Plan\n",
  });
  vi.stubGlobal("fetch", gh.fetch);
  env = { ...testEnv, NOVELS_APP_ID: "123", NOVELS_APP_PRIVATE_KEY: key };
});

async function as(email: string, action: "read" | "edit" = "read") {
  const viewer = await viewerFor(email);
  return { viewer, project: await requireBookProject(testEnv.DB, viewer, SLUG, action) };
}

async function refresh() {
  const { project } = await as("owner@test.invalid");
  await refreshBook(testEnv.DB, gh.repo, project);
}

async function contextFor(email: string) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
  context.set(viewerContext, await viewerFor(email));
  context.set(nonceContext, "test-nonce");
  return context;
}

async function settle<T>(p: Promise<T>): Promise<T | Response> {
  try {
    return await p;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

function body(fields: Record<string, string | string[]>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) form.append(k, one);
  return form;
}

const post = async (route: (args: never) => Promise<unknown>, email: string, url: string, fields: Record<string, string | string[]>, params: Record<string, string>) =>
  settle(route({ request: new Request(`https://carrel.test${url}`, { method: "POST", body: body(fields) }), params, context: await contextFor(email) } as never));

async function history(email: string, path: string, query = "") {
  return settle(historyLoader({ request: new Request(`https://carrel.test/b/${SLUG}/h/${path}${query}`), params: { project: SLUG, "*": path }, context: await contextFor(email) } as never)) as Promise<
    Awaited<ReturnType<typeof historyLoader>>
  >;
}

const swapped = () => withChapterOrder(PATHS, "01-arrival", [A2, A1]);

describe("one commit for many renames", () => {
  it("renames every file in one commit, keeping each file's text and blob", async () => {
    const gate = gh.files.get(`${SLUG}/${A1}`)!;
    const supper = gh.files.get(`${SLUG}/${A2}`)!;
    const { commit } = await gh.repo.commitMany({
      renames: [
        { from: `${SLUG}/${A1}`, to: `${SLUG}/chapters/01-arrival/02-the-gate.md`, sha: gate.sha },
        { from: `${SLUG}/${A2}`, to: `${SLUG}/chapters/01-arrival/01-supper.md`, sha: supper.sha },
      ],
      message: "Reorder",
      author: { name: "Dustin Edwards", email: "dustin@test.invalid" },
    });
    expect(gh.commits).toHaveLength(1);
    expect(gh.commits[0]).toMatchObject({ sha: commit, message: "Reorder", author: { name: "Dustin Edwards" } });
    expect(gh.commits[0]!.paths).toEqual([`${SLUG}/${A1}`, `${SLUG}/${A2}`, `${SLUG}/chapters/01-arrival/01-supper.md`, `${SLUG}/chapters/01-arrival/02-the-gate.md`].sort());
    expect(gh.files.get(`${SLUG}/chapters/01-arrival/02-the-gate.md`)).toEqual(gate);
    expect(gh.files.has(`${SLUG}/${A1}`)).toBe(false);
  });

  it("PLANT: refuses when a file changed in Git since Carrel read it, and moves nothing", async () => {
    const gate = gh.files.get(`${SLUG}/${A1}`)!;
    await gh.commitElsewhere(`${SLUG}/${A1}`, scene("Nell", "Changed elsewhere."));
    const head = gh.head();
    await expect(
      gh.repo.commitMany({ renames: [{ from: `${SLUG}/${A1}`, to: `${SLUG}/chapters/01-arrival/03-the-gate.md`, sha: gate.sha }], message: "m", author: { name: "a", email: "a@b" } }),
    ).rejects.toBeInstanceOf(GitConflict);
    expect(gh.head()).toBe(head);
  });

  it("PLANT: refuses to land on a file that stays, and never forces a branch that moved meanwhile", async () => {
    const gate = gh.files.get(`${SLUG}/${A1}`)!;
    await expect(gh.repo.commitMany({ renames: [{ from: `${SLUG}/${A1}`, to: `${SLUG}/${A2}`, sha: gate.sha }], message: "m", author: { name: "a", email: "a@b" } })).rejects.toBeInstanceOf(GitConflict);
    gh.raceNextRefMove(async () => void (await gh.commitElsewhere(`${SLUG}/outline/plan.md`, "# Plan, pushed meanwhile\n")));
    await expect(
      gh.repo.commitMany({ renames: [{ from: `${SLUG}/${A1}`, to: `${SLUG}/chapters/01-arrival/03-the-gate.md`, sha: gate.sha }], message: "m", author: { name: "a", email: "a@b" } }),
    ).rejects.toBeInstanceOf(GitConflict);
    expect(gh.files.get(`${SLUG}/outline/plan.md`)!.source).toBe("# Plan, pushed meanwhile\n");
    expect(gh.files.has(`${SLUG}/${A1}`)).toBe(true);
  });

  it("lists a path's commits and reads a file as it was at one", async () => {
    const first = gh.files.get(`${SLUG}/${A1}`)!.source;
    const edit = await gh.commitElsewhere(`${SLUG}/${A1}`, scene("Nell", "Second version."), "Second pass");
    const commits = await gh.repo.history(`${SLUG}/${A1}`);
    expect(commits.map((c) => c.message)).toEqual(["Second pass", "Initial"]);
    expect((await gh.repo.readAt(`${SLUG}/${A1}`, commits[1]!.sha))?.source).toBe(first);
    expect((await gh.repo.readAt(`${SLUG}/${A1}`, edit))?.source).toContain("Second version.");
  });
});

describe("reordering a book", () => {
  it("commits once, and the index, flags and AI drafts follow the files, with each move recorded", async () => {
    await refresh();
    const { viewer, project } = await as("editor@test.invalid", "edit");
    await testEnv.DB.prepare("INSERT INTO findings (project_id, path, check_name, message, fingerprint, status) VALUES (?, ?, 'ai', 'a flag', 'fp1', 'open')").bind(project.id, A1).run();
    await testEnv.DB.prepare("INSERT INTO ai_drafts (project_id, item_id, person_id, client, source, note) VALUES (?, ?, ?, 'Claude', 'x', '')").bind(project.id, A1, viewer.id).run();
    const result = await reorderBook(testEnv.DB, gh.repo, project, viewer, swapped());
    expect(result).toMatchObject({ ok: true, renames: [{ from: A2, to: "chapters/01-arrival/01-supper.md" }, { from: A1, to: "chapters/01-arrival/02-the-gate.md" }] });
    expect(gh.commits).toHaveLength(1);
    expect(gh.commits[0]!.message).toMatch(/^Reorder test-book: 2 files renumbered\n\nCarrel-Change: [0-9a-f-]{36}$/);
    const paths = (await testEnv.DB.prepare("SELECT path FROM book_files ORDER BY path").all<{ path: string }>()).results.map((r) => r.path);
    expect(paths).toContain("chapters/01-arrival/02-the-gate.md");
    expect(paths).not.toContain(A1);
    expect(await testEnv.DB.prepare("SELECT path FROM findings WHERE check_name = 'ai'").first()).toEqual({ path: "chapters/01-arrival/02-the-gate.md" });
    expect(await testEnv.DB.prepare("SELECT item_id FROM ai_drafts").first()).toEqual({ item_id: "chapters/01-arrival/02-the-gate.md" });
    const moves = await testEnv.DB.prepare("SELECT from_path, to_path, person_id FROM book_moves ORDER BY id").all();
    expect(moves.results).toEqual([
      { from_path: A2, to_path: "chapters/01-arrival/01-supper.md", person_id: viewer.id },
      { from_path: A1, to_path: "chapters/01-arrival/02-the-gate.md", person_id: viewer.id },
    ]);
  });

  it("PLANT: waits while a moving file has a working draft, and refuses a Reader", async () => {
    await refresh();
    const { viewer, project } = await as("owner@test.invalid", "edit");
    await autosave(testEnv.DB, project, viewer, A1, { source: "half done", baseVersion: gh.files.get(`${SLUG}/${A1}`)!.sha });
    const held = await reorderBook(testEnv.DB, gh.repo, project, viewer, swapped());
    expect(held).toMatchObject({ ok: false, reason: "draft", message: expect.stringContaining(A1) });
    expect(gh.commits).toHaveLength(0);
    const reader = await as("reader@test.invalid");
    await expect(reorderBook(testEnv.DB, gh.repo, reader.project, reader.viewer, swapped())).rejects.toMatchObject({ status: 403 });
  });

  it("refuses an out-of-date order and a book changed in Git, and moves nothing", async () => {
    await refresh();
    const { viewer, project } = await as("owner@test.invalid", "edit");
    expect(await reorderBook(testEnv.DB, gh.repo, project, viewer, [{ chapter: "01-arrival", scenes: [A1] }])).toMatchObject({ ok: false, reason: "stale" });
    await gh.commitElsewhere(`${SLUG}/${A1}`, scene("Nell", "Changed elsewhere."));
    expect(await reorderBook(testEnv.DB, gh.repo, project, viewer, swapped())).toMatchObject({ ok: false, reason: "conflict" });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM book_moves").first()).toEqual({ n: 0 });
  });

  it("takes a binder move through the book page's action", async () => {
    await refresh();
    const answer = await post(bookAction, "editor@test.invalid", `/b/${SLUG}`, { intent: "reorder", order: JSON.stringify(swapped()) }, { project: SLUG });
    expect(answer).toMatchObject({ reorder: { ok: true } });
    expect(((await post(bookAction, "editor@test.invalid", `/b/${SLUG}`, { intent: "reorder", order: "nonsense" }, { project: SLUG })) as Response).status).toBe(400);
  });
});

describe("the corkboard", () => {
  it("shows each chapter's cards with summary, point of view, status and words", async () => {
    await refresh();
    const data = (await settle(corkLoader({ request: new Request(`https://carrel.test/b/${SLUG}/corkboard`), params: { project: SLUG }, context: await contextFor("reader@test.invalid") } as never))) as Awaited<
      ReturnType<typeof corkLoader>
    >;
    expect(data.canMove).toBe(false);
    expect(data.chapters[0]!.cards[0]).toMatchObject({ path: A1, title: "The gate", summary: "Nell came to the gate.", fromText: true, pov: "Nell", status: "Drafting", words: 5 });
  });

  it("moves with no script: Move down, a chapter up, and a card to another chapter", async () => {
    await refresh();
    const url = `/b/${SLUG}/corkboard`;
    const down = await post(corkAction, "editor@test.invalid", url, { intent: "scenes", chapter: "01-arrival", order: [A1, A2], down: A1 }, { project: SLUG });
    expect(down).toMatchObject({ result: { ok: true, renames: [{ from: A2, to: "chapters/01-arrival/01-supper.md" }, { from: A1, to: "chapters/01-arrival/02-the-gate.md" }] } });
    const up = await post(corkAction, "editor@test.invalid", url, { intent: "chapters", order: ["01-arrival", "02-the-crossing"], up: "02-the-crossing" }, { project: SLUG });
    expect(up).toMatchObject({ result: { ok: true } });
    expect([...gh.files.keys()].filter((p) => p.includes("chapters/")).sort()).toEqual(
      [`${SLUG}/chapters/01-the-crossing/01-the-chain.md`, `${SLUG}/chapters/01-the-crossing/02-the-bank.md`, `${SLUG}/chapters/02-arrival/01-supper.md`, `${SLUG}/chapters/02-arrival/02-the-gate.md`].sort(),
    );
    const moved = await post(corkAction, "editor@test.invalid", url, { intent: "move-to", path: "chapters/02-arrival/01-supper.md", target: "01-the-crossing" }, { project: SLUG });
    expect(moved).toMatchObject({ result: { ok: true } });
    expect(gh.files.has(`${SLUG}/chapters/01-the-crossing/03-supper.md`)).toBe(true);
    expect(gh.commits).toHaveLength(3);
  });

  it("PLANT: a Reader cannot move a card", async () => {
    await refresh();
    const answer = await post(corkAction, "reader@test.invalid", `/b/${SLUG}/corkboard`, { intent: "scenes", chapter: "01-arrival", order: [A2, A1] }, { project: SLUG });
    expect((answer as Response).status).toBe(403);
    expect(gh.commits).toHaveLength(0);
  });
});

describe("a file's history", () => {
  it("lists Carrel's saves, its moves and commits made elsewhere, back through its old paths", async () => {
    await refresh();
    const { viewer, project } = await as("owner@test.invalid", "edit");
    const opened = gh.files.get(`${SLUG}/${A1}`)!;
    const saved = await saveBookFile(testEnv.DB, gh.repo, project, viewer, A1, { source: scene("Nell", "Nell came to the old gate."), expectedVersion: opened.sha });
    expect(saved.ok).toBe(true);
    await reorderBook(testEnv.DB, gh.repo, project, viewer, swapped());
    const moved = "chapters/01-arrival/02-the-gate.md";
    await gh.commitElsewhere(`${SLUG}/${moved}`, scene("Nell", "Nell came to the old gate at dusk."), "Edited on the laptop");

    const data = await history("reader@test.invalid", moved);
    expect(data.versions.map((v) => [v.kind, v.path, v.message.split(":")[0]])).toEqual([
      ["outside", moved, "Edited on the laptop"],
      ["move", moved, `Moved from ${A1}`],
      ["carrel", A1, "Saved in Carrel"],
      ["outside", A1, "Initial"],
    ]);

    // Any two versions side by side, the oldest under its old path.
    const oldest = data.versions[3]!.version;
    const newest = data.versions[0]!.version;
    const compared = await history("reader@test.invalid", moved, `?v=${newest}&v=${oldest}`);
    expect(compared.view).toMatchObject({ kind: "compare", before: { title: "Earlier version", text: expect.stringContaining("Nell came to the gate.") }, after: { text: expect.stringContaining("at dusk") } });
    const patch = await history("reader@test.invalid", moved, `?v=${newest}&v=${oldest}&by=line`);
    expect(patch.view).toMatchObject({ kind: "compare", patch: expect.stringContaining("+Nell came to the old gate at dusk.") });
    const source = await history("reader@test.invalid", moved, `?version=${data.versions[2]!.version}`);
    expect(source.view).toMatchObject({ kind: "source", source: expect.stringContaining("Nell came to the old gate."), current: false });
  });

  it("sets Dustin's text against an AI draft beside it, and his draft against the saved file", async () => {
    await refresh();
    const { viewer, project } = await as("owner@test.invalid", "edit");
    const ai = await testEnv.DB.prepare("INSERT INTO ai_drafts (project_id, item_id, person_id, client, source, note) VALUES (?, ?, ?, 'Claude', ?, '') RETURNING id")
      .bind(project.id, A1, viewer.id, scene("Nell", "An AI version of the gate."))
      .first<{ id: number }>();
    const against = await history("owner@test.invalid", A1, `?compare=ai&ai=${ai!.id}`);
    expect(against.view).toMatchObject({ kind: "compare", before: { title: "Your text, saved in Git", text: expect.stringContaining("Nell came to the gate.") }, after: { title: "AI draft from Claude" } });
    expect(against.aiDrafts).toHaveLength(1);
    await autosave(testEnv.DB, project, viewer, A1, { source: scene("Nell", "My own rewrite."), baseVersion: gh.files.get(`${SLUG}/${A1}`)!.sha });
    const mine = await history("owner@test.invalid", A1, "?compare=git");
    expect(mine.view).toMatchObject({ kind: "compare", before: { title: "Saved in Git" }, after: { title: "Your working draft", text: expect.stringContaining("My own rewrite.") } });
    expect((await history("owner@test.invalid", A1, `?compare=ai&ai=${ai!.id}`)).view).toMatchObject({ before: { title: "Your working draft" } });
  });

  it("PLANT: refuses a path outside the layout, and a person with no role on the book", async () => {
    expect(((await history("owner@test.invalid", "../secrets.md")) as unknown as Response).status).toBe(404);
    await addPerson("stranger@test.invalid");
    expect(((await history("stranger@test.invalid", A1)) as unknown as Response).status).toBe(404);
  });
});
