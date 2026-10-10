// Books through Carrel's service layer, against the fake writing repository: who may open, save and
// export; a save that commits with the version it expects and records who wrote what; the checks
// that run on save and never stop it; and export held while a flag is open.

import { beforeEach, describe, expect, it } from "vitest";

import {
  assembleBook,
  authorshipRecord,
  authorshipReport,
  checkDraft,
  createBook,
  dismissFinding,
  exportGate,
  listFiles,
  listFindings,
  refreshBook,
  requireBookProject,
  saveBookFile,
  wordDelta,
} from "~/lib/books.server";
import { autosave, readDraft } from "~/lib/content.server";
import { requireSiteProject } from "~/lib/projects.server";

import { addBook, addPerson, addProject, resetDb, share, testEnv } from "./env";
import { BASELINE, PLANT } from "./fixtures/voice";
import { fakeNovels } from "./novels";
import { viewerFor } from "./site";

const SLUG = "test-book";

const WADE = "---\nname: Wade Pruitt\naliases: [Wade]\nborn: 1996-02-11\n---\nRanch hand.\n";
const PLACE = "---\nname: Harlan place\n---\n";
const RULE = "---\nname: No phones past the ridge\nforbidden: [phone rang]\n---\n";
const HEADER = "---\npov: Wade\ndate: 2024-04-12\nlocation: Harlan place\ncharacters: [Wade]\ngoal: get in\nconflict: the lock\noutcome: he opens it\n---\n\n";

function seedRepo(extra: Record<string, string> = {}) {
  return fakeNovels({
    [`${SLUG}/book.md`]: "---\ntitle: The Test Book\nauthor: Test Author\n---\n",
    [`${SLUG}/bible/characters/wade.md`]: WADE,
    [`${SLUG}/bible/places/harlan-place.md`]: PLACE,
    [`${SLUG}/bible/rules/phones.md`]: RULE,
    [`${SLUG}/chapters/01-arrival/01-the-gate.md`]: `${HEADER}Wade opened the gate.\n`,
    [`${SLUG}/chapters/01-arrival/02-supper.md`]: HEADER.replace("2024-04-12", "2024-04-12 19:00") + "They ate at the kitchen table.\n",
    [`${SLUG}/outline/plan.md`]: "# Plan\n",
    [`${SLUG}/build/book.epub`]: "ignored",
    [`${SLUG}/notes.txt`]: "ignored",
    "shared/checks/ai-habits.md": "---\nwords: [suddenly]\n---\n",
    ...extra,
  });
}

async function refusal(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
  throw new Error("expected a refusal, and the call succeeded");
}

beforeEach(async () => {
  await resetDb();
  await addPerson("owner@test.invalid", { owner: true });
  const editor = await addPerson("editor@test.invalid");
  const reader = await addPerson("reader@test.invalid");
  await addPerson("stranger@test.invalid");
  const id = await addBook(SLUG);
  await share(id, editor, "editor");
  await share(id, reader, "reader");
});

async function as(email: string, action: "read" | "edit" | "publish" = "read") {
  const viewer = await viewerFor(email);
  return { viewer, project: await requireBookProject(testEnv.DB, viewer, SLUG, action) };
}

describe("opening a book", () => {
  it("PLANT: a non-member, a missing book, and a site all answer 404", async () => {
    const stranger = await viewerFor("stranger@test.invalid");
    const owner = await viewerFor("owner@test.invalid");
    await addProject("a-site", "dustinedwards");
    expect(await refusal(requireBookProject(testEnv.DB, stranger, SLUG, "read"))).toBe(404);
    expect(await refusal(requireBookProject(testEnv.DB, owner, "no-such-book", "read"))).toBe(404);
    expect(await refusal(requireBookProject(testEnv.DB, owner, "a-site", "read"))).toBe(404);
    // And the other way: a book is not a site.
    expect(await refusal(requireSiteProject(testEnv.DB, owner, SLUG, "read"))).toBe(404);
  });

  it("PLANT: a Reader asking to edit is refused 403", async () => {
    const reader = await viewerFor("reader@test.invalid");
    expect(await refusal(requireBookProject(testEnv.DB, reader, SLUG, "edit"))).toBe(403);
  });

  it("creates a book for the Owner only, with a folder name the layout allows", async () => {
    const owner = await viewerFor("owner@test.invalid");
    const editor = await viewerFor("editor@test.invalid");
    expect(await refusal(createBook(testEnv.DB, editor, { name: "Mine", folder: "mine" }))).toBe(403);
    expect(await createBook(testEnv.DB, owner, { name: "Paluxy Portal", folder: "paluxy-portal" })).toEqual({ ok: true, slug: "paluxy-portal" });
    expect((await createBook(testEnv.DB, owner, { name: "Again", folder: "paluxy-portal" })).ok).toBe(false);
    expect((await createBook(testEnv.DB, owner, { name: "Bad", folder: "../etc" })).ok).toBe(false);
    expect((await createBook(testEnv.DB, owner, { name: "Shared", folder: "shared" })).ok).toBe(false);
  });
});

describe("refresh from Git", () => {
  it("indexes the book's Markdown files by kind, skips build/ and other files, and reads shared/", async () => {
    const gh = seedRepo();
    const { project } = await as("reader@test.invalid");
    const result = await refreshBook(testEnv.DB, gh.repo, project);
    expect(result).toMatchObject({ files: 7, read: 7, removed: 0, shared: 1, more: false });
    const files = await listFiles(testEnv.DB, project);
    expect(files.map((f) => [f.path, f.kind])).toEqual([
      ["bible/characters/wade.md", "character"],
      ["bible/places/harlan-place.md", "place"],
      ["bible/rules/phones.md", "rule"],
      ["book.md", "book"],
      ["chapters/01-arrival/01-the-gate.md", "scene"],
      ["chapters/01-arrival/02-supper.md", "scene"],
      ["outline/plan.md", "outline"],
    ]);
    // A clean book has nothing flagged.
    expect(await listFindings(testEnv.DB, project)).toEqual([]);
  });

  it("reads again only what changed, and drops what Git no longer has", async () => {
    const gh = seedRepo();
    const { project } = await as("reader@test.invalid");
    await refreshBook(testEnv.DB, gh.repo, project);
    gh.files.delete(`${SLUG}/outline/plan.md`);
    await gh.commitElsewhere(`${SLUG}/chapters/01-arrival/02-supper.md`, `${HEADER}Suddenly they ate.\n`);
    const before = gh.requests.length;
    expect(await refreshBook(testEnv.DB, gh.repo, project)).toMatchObject({ read: 1, removed: 1, shared: 0 });
    expect(gh.requests.slice(before).filter((r) => r.includes("/contents/"))).toEqual([
      `GET /repos/DrDustinEdwards/writing/contents/${SLUG}/chapters/01-arrival/02-supper.md`,
    ]);
    // The checks ran on what changed outside Carrel, with the book's own habits list.
    expect((await listFindings(testEnv.DB, project)).map((f) => f.excerpt)).toEqual(["Suddenly"]);
  });
});

describe("saving", () => {
  it("PLANT: a Reader cannot autosave or save, and Git hears nothing", async () => {
    const gh = seedRepo();
    const { viewer, project } = await as("reader@test.invalid");
    const path = "chapters/01-arrival/01-the-gate.md";
    expect(await refusal(autosave(testEnv.DB, project, viewer, path, { source: "x", baseVersion: null }))).toBe(403);
    expect(await refusal(saveBookFile(testEnv.DB, gh.repo, project, viewer, path, { source: "x", expectedVersion: null }))).toBe(403);
    expect(gh.requests.filter((r) => r.startsWith("PUT"))).toEqual([]);
  });

  it("PLANT: a path outside the layout is refused before Git is asked", async () => {
    const gh = seedRepo();
    const { viewer, project } = await as("owner@test.invalid");
    for (const path of ["../other-book/book.md", "build/x.md", "chapters/one/two.md", "notes.txt", "chapters/01-a/01-b.md/../../x.md"]) {
      expect(await refusal(saveBookFile(testEnv.DB, gh.repo, project, viewer, path, { source: "x", expectedVersion: null }))).toBe(404);
    }
    expect(gh.requests).toEqual([]);
  });

  it("commits as the person with a change id and no AI trailer, records authorship, clears the draft", async () => {
    const gh = seedRepo();
    const { viewer, project } = await as("editor@test.invalid");
    await refreshBook(testEnv.DB, gh.repo, project);
    const path = "chapters/01-arrival/01-the-gate.md";
    const file = (await listFiles(testEnv.DB, project)).find((f) => f.path === path)!;
    await autosave(testEnv.DB, project, viewer, path, { source: "draft", baseVersion: file.sha });

    const result = await saveBookFile(testEnv.DB, gh.repo, project, viewer, path, {
      source: `${HEADER}Wade opened the old gate slowly.\n`,
      expectedVersion: file.sha,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(gh.commits).toHaveLength(1);
    expect(gh.commits[0]).toMatchObject({ path: `${SLUG}/${path}`, author: { name: "editor", email: "editor@test.invalid" } });
    expect(gh.commits[0]!.message).toBe(`Save ${SLUG}/${path}\n\nCarrel-Change: ${result.changeId}`);
    expect(gh.commits[0]!.message).not.toMatch(/claude|anthropic|co-authored/i);
    expect(await readDraft(testEnv.DB, project, viewer, path)).toBeNull();

    const record = await authorshipRecord(testEnv.DB, project);
    expect(record).toMatchObject([{ id: result.changeId, path, who: "editor", client: null, wordsAdded: 2, wordsRemoved: 0, commit: result.commit }]);
    const report = authorshipReport(project, record, new Date("2026-09-27T00:00:00Z"));
    expect(report).toContain("| editor | 1 | 2 | 0 |");
    expect(report).toContain(`| editor | ${path} | 2 | 0 | ${result.commit.slice(0, 7)} |`);
  });

  it("PLANT: a stale expected version is refused as a conflict, and the draft is kept", async () => {
    const gh = seedRepo();
    const { viewer, project } = await as("owner@test.invalid");
    await refreshBook(testEnv.DB, gh.repo, project);
    const path = "chapters/01-arrival/01-the-gate.md";
    const opened = (await listFiles(testEnv.DB, project)).find((f) => f.path === path)!.sha;
    await autosave(testEnv.DB, project, viewer, path, { source: "my words", baseVersion: opened });
    await gh.commitElsewhere(`${SLUG}/${path}`, `${HEADER}Someone else's words.\n`);

    const result = await saveBookFile(testEnv.DB, gh.repo, project, viewer, path, { source: "my words", expectedVersion: opened });
    expect(result).toMatchObject({ ok: false, reason: "conflict" });
    expect(gh.files.get(`${SLUG}/${path}`)!.source).toBe(`${HEADER}Someone else's words.\n`);
    expect((await readDraft(testEnv.DB, project, viewer, path))?.source).toBe("my words");
    expect(await authorshipRecord(testEnv.DB, project)).toEqual([]);
  });

  it("creates a new scene only where no file exists", async () => {
    const gh = seedRepo();
    const { viewer, project } = await as("owner@test.invalid");
    const path = "chapters/02-letters/01-morning.md";
    const created = await saveBookFile(testEnv.DB, gh.repo, project, viewer, path, { source: `${HEADER.replace("2024-04-12", "2024-04-13")}Morning.\n`, expectedVersion: null });
    expect(created.ok).toBe(true);
    const again = await saveBookFile(testEnv.DB, gh.repo, project, viewer, path, { source: "overwrite", expectedVersion: null });
    expect(again).toMatchObject({ ok: false, reason: "conflict" });
  });
});

describe("checks on save", () => {
  it("PLANT: a flagged scene still saves; the flags come back and are recorded", async () => {
    const gh = seedRepo();
    const { viewer, project } = await as("owner@test.invalid");
    await refreshBook(testEnv.DB, gh.repo, project);
    const path = "chapters/01-arrival/03-late.md";
    const source = HEADER.replace("characters: [Wade]", "characters: [Wade, Tobias]").replace("2024-04-12", "2024-04-11") + "Then the phone rang. It's not just a farm, it's a promise.\n";
    const result = await saveBookFile(testEnv.DB, gh.repo, project, viewer, path, { source, expectedVersion: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(gh.files.get(`${SLUG}/${path}`)!.source).toBe(source);
    expect(result.findings.map((f) => f.check).sort()).toEqual(["ai-habits", "continuity", "timeline", "world-rules"]);
    expect((await listFindings(testEnv.DB, project, { path })).map((f) => f.check).sort()).toEqual(["ai-habits", "continuity", "timeline", "world-rules"]);
  });

  it("PLANT: the voice check flags another author's passage once shared/voice/ holds Dustin's", async () => {
    const voice = Object.fromEntries(BASELINE.map((text, i) => [`shared/voice/passage-${i + 1}.md`, text]));
    const gh = seedRepo({ ...voice, "shared/voice/README.md": "Put your passages here." });
    const { viewer, project } = await as("owner@test.invalid");
    await refreshBook(testEnv.DB, gh.repo, project);
    const result = await saveBookFile(testEnv.DB, gh.repo, project, viewer, "chapters/01-arrival/03-tea.md", {
      source: HEADER.replace("2024-04-12", "2024-04-13") + PLANT,
      expectedVersion: null,
    });
    expect(result.ok && result.findings.map((f) => f.check)).toEqual(["voice"]);
  });

  it("fixing the text clears the flag; saving a bible entry rechecks every scene", async () => {
    const gh = seedRepo();
    const { viewer, project } = await as("owner@test.invalid");
    await refreshBook(testEnv.DB, gh.repo, project);
    const path = "chapters/01-arrival/03-late.md";
    const withTobias = HEADER.replace("characters: [Wade]", "characters: [Wade, Tobias]").replace("2024-04-12", "2024-04-13") + "Quiet.\n";
    const saved = await saveBookFile(testEnv.DB, gh.repo, project, viewer, path, { source: withTobias, expectedVersion: null });
    expect((await listFindings(testEnv.DB, project, { status: "open" })).map((f) => f.excerpt)).toEqual(["Tobias"]);

    // Adding Tobias to the bible resolves the scene's flag without touching the scene.
    const bible = await saveBookFile(testEnv.DB, gh.repo, project, viewer, "bible/characters/tobias.md", { source: "---\nname: Tobias\n---\n", expectedVersion: null });
    expect(bible.ok && saved.ok).toBe(true);
    expect(await listFindings(testEnv.DB, project)).toEqual([]);
  });

  it("checks a draft without saving or recording anything", async () => {
    const gh = seedRepo();
    const { project } = await as("reader@test.invalid");
    await refreshBook(testEnv.DB, gh.repo, project);
    const found = await checkDraft(testEnv.DB, project, "chapters/01-arrival/01-the-gate.md", `${HEADER}A tapestry.\n`);
    expect(found.map((f) => f.excerpt)).toEqual(["tapestry"]);
    expect(await listFindings(testEnv.DB, project)).toEqual([]);
    expect(gh.requests.filter((r) => r.startsWith("PUT"))).toEqual([]);
  });
});

describe("dismissing flags and exporting", () => {
  async function flagged() {
    const gh = seedRepo();
    const owner = await as("owner@test.invalid");
    await refreshBook(testEnv.DB, gh.repo, owner.project);
    await saveBookFile(testEnv.DB, gh.repo, owner.project, owner.viewer, "chapters/01-arrival/03-late.md", {
      source: HEADER.replace("2024-04-12", "2024-04-13") + "A tapestry. Another tapestry.\n",
      expectedVersion: null,
    });
    return { gh, owner };
  }

  it("PLANT: export is refused while a flag is open, and to anyone but the Owner", async () => {
    const { owner } = await flagged();
    expect(await exportGate(testEnv.DB, owner.project)).toMatchObject({ ok: false, open: 2 });
    const editor = await as("editor@test.invalid");
    expect(await refusal(exportGate(testEnv.DB, editor.project))).toBe(403);
    expect(await refusal(assembleBook(testEnv.DB, editor.project, editor.viewer))).toBe(403);
  });

  it("PLANT: an Editor cannot dismiss a flag; the Owner can, and a dismissal survives the next save", async () => {
    const { gh, owner } = await flagged();
    const editor = await as("editor@test.invalid");
    const [first, second] = await listFindings(testEnv.DB, owner.project);
    expect(await refusal(dismissFinding(testEnv.DB, editor.project, editor.viewer, first!.id))).toBe(403);

    await dismissFinding(testEnv.DB, owner.project, owner.viewer, first!.id);
    await dismissFinding(testEnv.DB, owner.project, owner.viewer, second!.id);
    expect(await exportGate(testEnv.DB, owner.project)).toEqual({ ok: true });

    // Saving again with the same words keeps both dismissed; a new tapestry is a new flag.
    const path = "chapters/01-arrival/03-late.md";
    const current = gh.files.get(`${SLUG}/${path}`)!;
    await saveBookFile(testEnv.DB, gh.repo, owner.project, owner.viewer, path, { source: `${current.source}A third tapestry.\n`, expectedVersion: current.sha });
    const all = await listFindings(testEnv.DB, owner.project);
    expect(all.map((f) => f.status).sort()).toEqual(["dismissed", "dismissed", "open"]);
  });

  it("a dismissal in another book cannot be reached by id", async () => {
    const { owner } = await flagged();
    const [finding] = await listFindings(testEnv.DB, owner.project);
    await addBook("other-book");
    const other = await requireBookProject(testEnv.DB, owner.viewer, "other-book", "publish");
    expect(await refusal(dismissFinding(testEnv.DB, other, owner.viewer, finding!.id))).toBe(404);
  });

  it("assembles the book in reading order with its title and author from book.md", async () => {
    const gh = seedRepo({ [`${SLUG}/chapters/10-late/01-end.md`]: `${HEADER.replace("2024-04-12", "2024-05-01")}The end.\n` });
    const { viewer, project } = await as("owner@test.invalid");
    await refreshBook(testEnv.DB, gh.repo, project);
    const book = await assembleBook(testEnv.DB, project, viewer);
    expect(book.title).toBe("The Test Book");
    expect(book.author).toBe("Test Author");
    expect(book.chapters.map((c) => [c.title, c.scenes.map((s) => s.body)])).toEqual([
      ["Arrival", ["Wade opened the gate.", "They ate at the kitchen table."]],
      ["Late", ["The end."]],
    ]);
  });
});

describe("word counts for the authorship record", () => {
  it("counts a changed word once each way and a moved word not at all", () => {
    expect(wordDelta("the cat sat", "the dog sat")).toEqual({ added: 1, removed: 1 });
    expect(wordDelta("a b c", "c b a")).toEqual({ added: 0, removed: 0 });
    expect(wordDelta(null, "---\ntitle: x\n---\none two")).toEqual({ added: 2, removed: 0 });
  });
});
