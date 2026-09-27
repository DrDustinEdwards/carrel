// The book routes, driven through their loaders and actions with a real request context and the
// Worker's own GitHub client (App key and all) against the fake novels repository.

import { RouterContextProvider } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext, nonceContext, viewerContext } from "~/lib/context";
import { clearTokenCache } from "~/lib/novels/repo.server";
import { loader as authorshipLoader } from "~/routes/book.authorship";
import { loader as chapterLoader } from "~/routes/book.chapter";
import { action as fileAction, loader as fileLoader } from "~/routes/book.file";
import { loader as newBookLoader } from "~/routes/book.new";
import { action as bookAction, loader as bookLoader } from "~/routes/book";
import { loader as exportLoader } from "~/routes/book.export";
import { loader as homeLoader } from "~/routes/home";

import { addBook, addPerson, resetDb, share, testEnv } from "./env";
import { fakeNovels, githubStyleKey } from "./novels";
import { viewerFor } from "./site";

const SLUG = "test-book";
const HEADER = "---\npov: Wade\ndate: 2024-04-12\nlocation: Harlan place\ncharacters: [Wade]\ngoal: g\nconflict: c\noutcome: o\n---\n\n";
const SCENE = "chapters/01-arrival/01-the-gate.md";

let key: string;
beforeAll(async () => {
  key = (await githubStyleKey()).pkcs1Pem;
});

let gh: ReturnType<typeof fakeNovels>;
let env: Env;

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
    [`${SLUG}/bible/characters/wade.md`]: "---\nname: Wade\n---\nRanch hand.\n",
    [`${SLUG}/bible/places/harlan-place.md`]: "---\nname: Harlan place\n---\n",
    [`${SLUG}/${SCENE}`]: `${HEADER}Wade opened the gate. <script>alert(1)</script>\n`,
  });
  vi.stubGlobal("fetch", gh.fetch);
  env = { ...testEnv, NOVELS_APP_ID: "123", NOVELS_APP_PRIVATE_KEY: key };
});

async function contextFor(email: string, e: Env = env) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env: e, ctx: {} as ExecutionContext });
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

function form(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return body;
}

async function bookPost(email: string, fields: Record<string, string>) {
  const request = new Request(`https://carrel.test/b/${SLUG}`, { method: "POST", body: form(fields) });
  return settle(bookAction({ request, params: { project: SLUG }, context: await contextFor(email) } as never));
}

async function openFile(email: string, path: string, e: Env = env, query = "") {
  const request = new Request(`https://carrel.test/b/${SLUG}/f/${path}${query}`);
  return settle(fileLoader({ request, params: { project: SLUG, "*": path }, context: await contextFor(email, e) } as never));
}

async function filePost(email: string, path: string, fields: Record<string, string>, e: Env = env) {
  const request = new Request(`https://carrel.test/b/${SLUG}/f/${path}`, { method: "POST", body: form(fields) });
  return settle(fileAction({ request, params: { project: SLUG, "*": path }, context: await contextFor(email, e) } as never));
}

async function exportAs(email: string, format: string) {
  const request = new Request(`https://carrel.test/b/${SLUG}/export/${format}`);
  return settle(exportLoader({ request, params: { project: SLUG, format }, context: await contextFor(email) } as never)) as Promise<Response>;
}

describe("the book view", () => {
  it("lists nothing until a refresh, then the chapters with each scene's header", async () => {
    const before = (await settle(bookLoader({ request: new Request("https://carrel.test/b/x"), params: { project: SLUG }, context: await contextFor("reader@test.invalid") } as never))) as Awaited<
      ReturnType<typeof bookLoader>
    >;
    expect(before.chapters).toEqual([]);
    expect(before.connected).toBe(true);

    const refreshed = (await bookPost("reader@test.invalid", { intent: "refresh" })) as { refreshed: { files: number } };
    expect(refreshed.refreshed.files).toBe(3);
    const after = (await bookLoader({ request: new Request("https://carrel.test/b/x"), params: { project: SLUG }, context: await contextFor("reader@test.invalid") } as never)) as Awaited<
      ReturnType<typeof bookLoader>
    >;
    expect(after.chapters).toMatchObject([{ slug: "01-arrival", title: "Arrival", scenes: [{ path: SCENE, name: "The gate", pov: "Wade", date: "2024-04-12" }] }]);
    expect(after.bible.map((b) => b.name)).toEqual(["Wade", "Harlan place"]);
  });

  it("PLANT: a Reader cannot start a chapter; an Editor is sent to the editor on the next number", async () => {
    expect(((await bookPost("reader@test.invalid", { intent: "new-chapter", name: "Letters" })) as Response).status).toBe(403);
    await bookPost("editor@test.invalid", { intent: "refresh" });
    const started = (await bookPost("editor@test.invalid", { intent: "new-chapter", name: "The Letters", scene: "Morning" })) as Response;
    expect(started.headers.get("Location")).toBe(`/b/${SLUG}/f/chapters/02-the-letters/01-morning.md`);
  });

  it("says why when Git is not connected, and still shows the index", async () => {
    const offline = { ...testEnv };
    const data = (await bookLoader({ request: new Request("https://carrel.test/b/x"), params: { project: SLUG }, context: await contextFor("owner@test.invalid", offline) } as never)) as Awaited<
      ReturnType<typeof bookLoader>
    >;
    expect(data.connected).toBe(false);
    expect(data.connectionDetail).toMatch(/GitHub App for the novels repository is not set up yet/);
  });
});

describe("the file editor", () => {
  it("opens a scene from Git with its version and the bible entries it names", async () => {
    await bookPost("reader@test.invalid", { intent: "refresh" });
    const data = (await openFile("reader@test.invalid", SCENE)) as Awaited<ReturnType<typeof fileLoader>>;
    expect(data.source).toContain("Wade opened the gate.");
    expect(data.version).toBe(gh.files.get(`${SLUG}/${SCENE}`)!.sha);
    expect(data.canEdit).toBe(false);
    expect(data.bible.map((b) => [b.name, b.body])).toEqual([
      ["Wade", "Ranch hand."],
      ["Harlan place", ""],
    ]);
  });

  it("PLANT: a path outside the layout is 404, and a Reader cannot start a new file", async () => {
    expect(((await openFile("owner@test.invalid", "../secrets.md")) as Response).status).toBe(404);
    expect(((await openFile("owner@test.invalid", "build/book.md")) as Response).status).toBe(404);
    expect(((await openFile("reader@test.invalid", "chapters/02-a/01-b.md")) as Response).status).toBe(404);
  });

  it("starts a new file from its template, named from the link", async () => {
    const scene = (await openFile("editor@test.invalid", "chapters/02-a/01-b.md")) as Awaited<ReturnType<typeof fileLoader>>;
    expect(scene.fresh).toBe(true);
    expect(scene.source).toMatch(/^---\npov:\ndate:\nlocation:\ncharacters: \[\]\ngoal:\nconflict:\noutcome:\n---/);
    const person = (await openFile("editor@test.invalid", "bible/characters/june-harlan.md", env, "?name=June%20Harlan")) as Awaited<ReturnType<typeof fileLoader>>;
    expect(person.source).toContain("name: June Harlan");
  });

  it("saves through the route: a commit, the flags, and the draft gone", async () => {
    await bookPost("editor@test.invalid", { intent: "refresh" });
    const opened = (await openFile("editor@test.invalid", SCENE)) as Awaited<ReturnType<typeof fileLoader>>;
    await filePost("editor@test.invalid", SCENE, { intent: "autosave", source: "draft", expectedVersion: opened.version! });
    const result = (await filePost("editor@test.invalid", SCENE, {
      intent: "save",
      source: `${HEADER}Wade opened the gate. It was a tapestry.\n`,
      expectedVersion: opened.version!,
    })) as { intent: "save"; outcome: { ok: boolean; findings: { excerpt: string }[] } };
    expect(result.outcome.ok).toBe(true);
    expect(result.outcome.findings.map((f) => f.excerpt)).toEqual(["tapestry"]);
    expect(gh.commits).toHaveLength(1);
    const reopened = (await openFile("editor@test.invalid", SCENE)) as Awaited<ReturnType<typeof fileLoader>>;
    expect(reopened.draftAt).toBeNull();
    expect(reopened.findings.map((f) => f.status)).toEqual(["open"]);
  });

  it("PLANT: without Git, Save keeps the draft and says why; nothing is committed", async () => {
    const offline = { ...testEnv };
    await filePost("editor@test.invalid", SCENE, { intent: "autosave", source: "kept", expectedVersion: "" }, offline);
    const result = (await filePost("editor@test.invalid", SCENE, { intent: "save", source: "kept", expectedVersion: "" }, offline)) as {
      outcome: { ok: boolean; message: string };
    };
    expect(result.outcome.ok).toBe(false);
    expect(result.outcome.message).toMatch(/not set up yet.*Your text is kept here as your draft\./);
    expect(gh.commits).toHaveLength(0);
    expect(((await openFile("editor@test.invalid", SCENE, offline)) as Awaited<ReturnType<typeof fileLoader>>).source).toBe("kept");
  });

  it("PLANT: an Editor cannot dismiss a flag through the route", async () => {
    await bookPost("owner@test.invalid", { intent: "refresh" });
    const opened = (await openFile("owner@test.invalid", SCENE)) as Awaited<ReturnType<typeof fileLoader>>;
    await filePost("owner@test.invalid", SCENE, { intent: "save", source: `${HEADER}A tapestry.\n`, expectedVersion: opened.version! });
    const flag = ((await openFile("owner@test.invalid", SCENE)) as Awaited<ReturnType<typeof fileLoader>>).findings[0]!;
    expect(((await filePost("editor@test.invalid", SCENE, { intent: "dismiss", finding: String(flag.id) })) as Response).status).toBe(403);
    expect(await filePost("owner@test.invalid", SCENE, { intent: "dismiss", finding: String(flag.id) })).toEqual({ intent: "dismiss", dismissed: flag.id });
  });
});

describe("the chapter view", () => {
  it("PLANT: markup in a scene is shown as text, never run", async () => {
    await bookPost("reader@test.invalid", { intent: "refresh" });
    const data = (await chapterLoader({ request: new Request("https://carrel.test/"), params: { project: SLUG, chapter: "01-arrival" }, context: await contextFor("reader@test.invalid") } as never)) as Awaited<
      ReturnType<typeof chapterLoader>
    >;
    expect(data.scenes[0]!.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(data.scenes[0]!.html).not.toContain("<script>");
  });
});

describe("export and the authorship record", () => {
  it("PLANT: export is 403 to an Editor, and 409 to the Owner while a flag is open", async () => {
    expect((await exportAs("editor@test.invalid", "epub")).status).toBe(403);
    gh.files.set(`${SLUG}/${SCENE}`, { source: `${HEADER}A tapestry.\n`, sha: "0".repeat(40) });
    const held = await exportAs("owner@test.invalid", "epub");
    expect(held.status).toBe(409);
    expect(await held.text()).toMatch(/^1 flag is open\. Fix the text or dismiss each flag before exporting\./);
  });

  it("exports a clean book as ePub, Word and a print page with its own policy", async () => {
    gh.files.set(`${SLUG}/${SCENE}`, { source: `${HEADER}Wade opened the gate.\n`, sha: "1".repeat(40) });
    const epub = await exportAs("owner@test.invalid", "epub");
    expect(epub.status).toBe(200);
    expect(epub.headers.get("Content-Type")).toBe("application/epub+zip");
    expect(epub.headers.get("Content-Disposition")).toBe('attachment; filename="book-test-book.epub"');
    const docx = await exportAs("owner@test.invalid", "docx");
    expect(docx.headers.get("Content-Type")).toContain("wordprocessingml");
    const print = await exportAs("owner@test.invalid", "print");
    expect(print.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(await print.text()).toContain("Wade opened the gate.");
    expect((await exportAs("owner@test.invalid", "pdf")).status).toBe(404);
  });

  it("serves the authorship record as Markdown to a Reader", async () => {
    const response = (await settle(
      authorshipLoader({ request: new Request("https://carrel.test/"), params: { project: SLUG }, context: await contextFor("reader@test.invalid") } as never),
    )) as Response;
    expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(await response.text()).toContain("# Authorship record: Book test-book");
  });
});

describe("home and new books", () => {
  it("lists a book as a book, and offers New book to the Owner only", async () => {
    const home = (await homeLoader({ request: new Request("https://carrel.test/"), params: {}, context: await contextFor("reader@test.invalid") } as never)) as Awaited<
      ReturnType<typeof homeLoader>
    >;
    expect(home.projects).toMatchObject([{ slug: SLUG, kind: "book", role: "reader" }]);
    expect(home.isOwner).toBe(false);
    expect(((await settle(newBookLoader({ request: new Request("https://carrel.test/"), params: {}, context: await contextFor("editor@test.invalid") } as never))) as Response).status).toBe(404);
  });
});
