// The world the screen harness shows: three people, a site with posts and media, two books, a shared
// Drive folder and a social queue, all made through the app's own functions against the test fakes.
// Test-only; nothing here is deployed and nothing reaches the network.


import { addFinding, saveAiDraft } from "~/lib/ai.server";
import { createBook, refreshBook, requireBookProject } from "~/lib/books.server";
import { autosave, writeToSite } from "~/lib/content.server";
import { refreshIndex } from "~/lib/index.server";
import { finishAuth, startAuth } from "~/lib/google/oauth.server";
import { refreshManuscripts } from "~/lib/google/drive.server";
import { uploadMedia } from "~/lib/media.server";
import { findViewer } from "~/lib/people.server";
import { requireSiteProject } from "~/lib/projects.server";
import { clearTokenCache, novelsRepo } from "~/lib/novels/repo.server";
import { createAccount, draftSocialPost, recordPublication, setSwitches } from "~/lib/social/queue.server";

import { BASELINE } from "../fixtures/voice";
import { CODE, fakeGoogle, serviceAccountKey } from "../google";
import { fakeNovels, githubStyleKey } from "../novels";
import { fakeSite, SITE_KEY, SITE_ORIGIN } from "../site";

export const HARNESS_OWNER = "dustin@harness.invalid";
export const HARNESS_EDITOR = "rosa@harness.invalid";
export const HARNESS_READER = "sam@harness.invalid";

const SITE_SLUG = "dustinedwards-info";
const BOOK = "paluxy-portal";

// Colours for the picture files the fake site serves; the harness script answers these requests.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

const migrations = import.meta.glob("../../drizzle/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

async function migrate(db: D1Database) {
  for (const path of Object.keys(migrations).sort()) {
    const statements = migrations[path]!
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) await db.prepare(statement).run();
  }
}

function post(title: string, slug: string, description: string, date: string, tags: string[], body: string, draft = true) {
  return ["---", `title: "${title}"`, `slug: ${slug}`, `description: "${description}"`, `date: ${date}`, `tags: [${tags.join(", ")}]`, `draft: ${draft}`, "---", "", body, ""].join("\n");
}

const HEADER = (pov: string, date: string, place: string, present: string[], goal: string, conflict: string, outcome: string) =>
  `---\npov: ${pov}\ndate: ${date}\nlocation: ${place}\ncharacters: [${present.join(", ")}]\ngoal: ${goal}\nconflict: ${conflict}\noutcome: ${outcome}\n---\n\n`;

const SCENE_ONE = HEADER("Nell", "2024-04-12", "Harlan place", ["Nell", "Wade"], "get her truck towed", "the lock on the gate", "Wade lets her in") + BASELINE[0]!;
const SCENE_TWO = HEADER("Nell", "2024-04-12 19:00", "Harlan place", ["Nell", "Wade"], "learn why he bought the place", "he will not say", "she stays for supper") + BASELINE[1]!;
const SCENE_THREE =
  HEADER("Wade", "2024-04-13", "Low-water crossing", ["Wade"], "move the truck before the river rises", "the phone rang and he answered", "the truck is out") +
  "Suddenly the river was loud. Wade stood on the bank with the chain in his hands and the phone rang, the way it never did out past the ridge. He let it ring.\n\nHe hooked the chain and walked the truck backward, one slow yard at a time.\n";

async function viewer(db: D1Database, email: string) {
  const v = await findViewer(db, email);
  if (!v) throw new Error(`the harness has no ${email}`);
  return v;
}

export type World = { env: Env };
let ready: Promise<World> | null = null;

export function harness(base: Env): Promise<World> {
  ready ??= build(base);
  return ready;
}

async function build(base: Env): Promise<World> {
  const db = base.DB;
  await migrate(db);

  const [site, gh, saKey, appKey] = [fakeSite(), fakeNovels(), await serviceAccountKey(), await githubStyleKey()];
  const google = fakeGoogle({
    publicJwk: saKey.publicJwk,
    files: [
      { id: "folderRoot1", name: "Manuscripts", mimeType: "application/vnd.google-apps.folder", parent: "root" },
      { id: "m1", name: "Germomics, the book: working draft", mimeType: "application/vnd.google-apps.document", parent: "folderRoot1", content: "Phage lambda and the lysis decision.", modifiedTime: "2026-09-28T14:02:00Z" },
      { id: "m2", name: "Paluxy Portal, chapters 1 to 4", mimeType: "application/vnd.google-apps.document", parent: "folderRoot1", content: "The truck quit a mile past the crossing.", modifiedTime: "2026-09-21T09:30:00Z" },
      { id: "m3", name: "Grant narrative, 2027 cycle", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", parent: "folderRoot1", content: "Aims and approach.", modifiedTime: "2026-08-30T17:45:00Z" },
      { id: "m4", name: "Reviewer response, round two", mimeType: "application/pdf", parent: "folderRoot1", content: "Dear reviewers.", modifiedTime: "2026-07-14T11:10:00Z" },
    ],
  });

  // One fetch for everything the app reaches: the fake site, the fake GitHub, the fake Google.
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url.startsWith(SITE_ORIGIN)) return site.fetch(input, init);
    if (url.startsWith("https://api.github.com")) return gh.fetch(input, init);
    if (/^https:\/\/(oauth2|www)\.googleapis\.com|^https:\/\/searchconsole\.googleapis\.com/.test(url)) return google.fetch(input, init);
    return real(input, init);
  }) as typeof fetch;

  const env = {
    ...base,
    SITE_DUSTINEDWARDS_KEY: SITE_KEY,
    NOVELS_APP_ID: "123",
    NOVELS_APP_PRIVATE_KEY: appKey.pkcs1Pem,
    GOOGLE_SA_KEY: saKey.json,
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    GOOGLE_TOKEN_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    GOOGLE_MANUSCRIPTS_FOLDER_ID: "folderRoot1",
  } as Env;
  clearTokenCache();

  // People and projects.
  const person = async (email: string, name: string, owner = 0) =>
    (await db.prepare("INSERT INTO people (email, name, is_owner) VALUES (?, ?, ?) RETURNING id").bind(email, name, owner).first<{ id: number }>())!.id;
  const dustin = await person(HARNESS_OWNER, "Dustin Edwards", 1);
  const rosa = await person(HARNESS_EDITOR, "Rosa Park");
  const sam = await person(HARNESS_READER, "Sam Lee");
  // Migration 0002 already holds dustinedwards.info; a database wiped for a fresh seed does not.
  const siteId =
    (await db.prepare("SELECT id FROM projects WHERE site = 'dustinedwards'").first<{ id: number }>())?.id ??
    (await db.prepare("INSERT INTO projects (slug, name, site) VALUES (?, ?, ?) RETURNING id").bind(SITE_SLUG, "dustinedwards.info", "dustinedwards").first<{ id: number }>())!.id;
  const share = (project: number, personId: number, role: string) => db.prepare("INSERT INTO project_members (project_id, person_id, role) VALUES (?, ?, ?)").bind(project, personId, role).run();
  await share(siteId, rosa, "editor");
  await share(siteId, sam, "reader");
  const owner = await viewer(db, HARNESS_OWNER);
  const rosaV = await viewer(db, HARNESS_EDITOR);
  void dustin;
  void sam;

  // Media, then posts (one uses a picture), then the index.
  const sitePr = await requireSiteProject(db, owner, SITE_SLUG, "publish");
  const media: string[] = [];
  for (const [name, alt] of [
    ["foxhound-dashboard.png", "The Foxhound dashboard with three sites reporting healthy"],
    ["lambda-switch.png", "A diagram of the CI and Cro switch in phage lambda"],
    ["harlan-gate.png", ""],
    ["river-up.png", "The river at the low-water crossing, in flood"],
    ["field-notebook.png", "An open field notebook with a pressed leaf"],
    ["release-banner.png", ""],
  ] as const) {
    const out = await uploadMedia(env, sitePr, { viewer: owner }, { name, type: "image/png", size: PNG.byteLength, bytes: async () => PNG.slice().buffer }, alt);
    if (out.ok) media.push(out.item.url);
  }

  const posts: Array<{ slug: string; source: string; publish: boolean }> = [
    {
      slug: "foxhound-waits",
      publish: true,
      source: post("Why Foxhound waits before it pages you", "foxhound-waits", "A watcher that pages on the first failed check is a watcher you stop trusting.", "2026-09-18", ["foxhound", "monitoring"], "Three failed checks in a row is a pattern; one is weather. Foxhound waits for the pattern.\n\nThe cost of a false page is not the minute it takes to dismiss. It is the next real page you half ignore."),
    },
    {
      slug: "phage-lambda-switch",
      publish: true,
      source: post("How a temperate phage decides", "phage-lambda-switch", "CI, Cro and the switch that chooses between killing a cell and sleeping in it.", "2026-09-02", ["phage", "genetics"], `A temperate phage such as lambda does not always kill the cell it enters.\n\n:::figure{src="${media[1] ?? "/media/lambda-switch.png"}" alt="A diagram of the CI and Cro switch in phage lambda"}\n:::\n\nIn *Escherichia coli* the outcome turns on two proteins, each of which shuts off the gene for the other.`),
    },
    {
      slug: "autumn-release-notes",
      publish: true,
      source: post("Notes on the autumn release", "autumn-release-notes", "What changed in September, and what did not.", "2026-09-25", ["release"], "The release is small on purpose. Most of the work was deleting things that no longer earned their place."),
    },
    {
      slug: "counting-what-the-build-skips",
      publish: false,
      source: post("Counting what the build skips", "counting-what-the-build-skips", "", "2026-10-01", ["build"], "A build that skips silently is a build you cannot reason about.\n\nThis draft is about making the skipped count visible."),
    },
    {
      slug: "what-a-carrel-is-for",
      publish: false,
      source: post("What a carrel is for", "what-a-carrel-is-for", "A quiet desk in a loud library, and the habit it builds.", "2026-10-02", ["writing"], "A carrel is a small enclosed desk at the edge of a library. People go there to finish things."),
    },
  ];
  for (const p of posts) {
    const saved = await site.adapter.content.saveDraft(p.slug, { source: p.source, expectedVersion: null, changeId: `seed-${p.slug}` });
    if (p.publish) await writeToSite(env, sitePr, owner, p.slug, { action: "publish", expectedVersion: saved.version }, site.fetch);
  }
  const sched = await site.adapter.content.saveDraft("bacterial-genetics-primer", {
    source: post("A primer on bacterial genetics", "bacterial-genetics-primer", "Plasmids, transposons and the vocabulary a reader needs first.", "2026-10-09", ["genetics", "primer"], "Before phage, a few words about what a bacterium carries."),
    expectedVersion: null,
    changeId: "seed-primer",
  });
  await writeToSite(env, sitePr, owner, "bacterial-genetics-primer", { action: "schedule", expectedVersion: saved(sched), publishAt: "2026-10-09T13:00:00.000Z" }, site.fetch);
  await refreshIndex(env, { id: siteId, site: "dustinedwards" });

  // Dustin's own working copy of one draft, so the editor shows a draft saved in Carrel.
  const draftDoc = await site.adapter.content.get("what-a-carrel-is-for");
  await autosave(db, sitePr, owner, "what-a-carrel-is-for", {
    source: `${draftDoc!.source.trimEnd()}\n\nThe habit is simple: one door, one desk, one thing to finish.\n`,
    baseVersion: draftDoc!.version,
  });

  // Flags and AI drafts on the site.
  const claude = { viewer: owner, client: "Claude Code" };
  await addFinding(db, sitePr, claude, "counting-what-the-build-skips", { message: "The second paragraph claims the build skips nothing, which the first paragraph contradicts", excerpt: "A build that skips silently is a build you cannot reason about." });
  await addFinding(db, sitePr, claude, "counting-what-the-build-skips", { message: "No source for the skipped-count figure", excerpt: null });
  await addFinding(db, sitePr, { viewer: owner, client: "Grok Build" }, "foxhound-waits", { message: "Three in a row is not defined before it is used", excerpt: "Three failed checks in a row is a pattern" });
  await saveAiDraft(env, sitePr, claude, "counting-what-the-build-skips", { source: post("Counting what the build skips", "counting-what-the-build-skips", "", "2026-10-01", ["build"], "An alternative opening, written beside yours.\n\nThe build logs every skip with a reason, and the count is the first line of the summary."), note: "A tighter opening, for you to take or leave." }, site.fetch);
  void rosaV;

  // Books, indexed from the fake novels repository.
  gh.files.clear();
  const put = async (path: string, source: string) => {
    await gh.commitElsewhere(path, source);
  };
  await put(`${BOOK}/book.md`, "---\ntitle: The Paluxy Portal\nauthor: Dustin Edwards\nlanguage: en\n---\n");
  await put(`${BOOK}/bible/characters/nell.md`, "---\nname: Nell Okafor\naliases: [Nell]\nborn: 1986-05-02\n---\nA surveyor who grew up two ranches over. Notices what is missing from a room.\n");
  await put(`${BOOK}/bible/characters/wade.md`, "---\nname: Wade Pruitt\naliases: [Wade]\nborn: 1996-02-11\n---\nBought the Harlan place from the bank in February. Keeps his own counsel.\n");
  await put(`${BOOK}/bible/places/harlan-place.md`, "---\nname: Harlan place\n---\nA ranch house back in the live oaks, porch sagging at the east corner.\n");
  await put(`${BOOK}/bible/places/low-water-crossing.md`, "---\nname: Low-water crossing\n---\nWhere the county road dips through the creek. It floods in April.\n");
  await put(`${BOOK}/bible/rules/no-phones.md`, "---\nname: No phones past the ridge\nforbidden: [phone rang]\n---\nThere is no signal past the ridge, and the story never pretends otherwise.\n");
  await put(`${BOOK}/chapters/01-arrival/01-the-gate.md`, SCENE_ONE);
  await put(`${BOOK}/chapters/01-arrival/02-supper.md`, SCENE_TWO);
  await put(`${BOOK}/chapters/02-the-crossing/01-the-chain.md`, SCENE_THREE);
  await put(`${BOOK}/outline/plan.md`, "# Plan\n\nThree acts. The river is the clock.\n");
  await put("shared/checks/ai-habits.md", "---\nwords: [suddenly]\n---\n");
  await put("shared/voice/dustin.md", BASELINE.join("\n\n"));
  await createBook(db, owner, { name: "The Paluxy Portal", folder: BOOK });
  await createBook(db, owner, { name: "Salt Roads", folder: "salt-roads" });
  const bookPr = await requireBookProject(db, owner, BOOK, "read");
  await refreshBook(db, novelsRepo(env, gh.fetch), bookPr);
  const rosaBook = (await db.prepare("SELECT id FROM projects WHERE slug = ?").bind(BOOK).first<{ id: number }>())!.id;
  await share(rosaBook, rosa, "editor");
  await autosave(db, bookPr, owner, "chapters/02-the-crossing/02-the-bank.md", { source: HEADER("Wade", "2024-04-13", "Low-water crossing", ["Wade"], "get the truck out", "the current", "he waits") + "The water had dropped a hand's width by noon.\n", baseVersion: null });

  // Manuscripts, Google, social.
  await refreshManuscripts(env, google.fetch);
  const start = new URL(await startAuth(env, owner, "https://carrel.test"));
  await finishAuth(env, owner, new URLSearchParams({ code: CODE, state: start.searchParams.get("state") ?? "" }), "https://carrel.test", google.fetch);

  await createAccount(db, owner, { key: "germomics-bluesky", name: "Germomics", platform: "bluesky", kind: "brand", handle: "germomics.bsky.social", projectId: siteId });
  await createAccount(db, owner, { key: "dustin-bluesky", name: "Dustin Edwards", platform: "bluesky", kind: "personal", handle: "dustinedwards.bsky.social", projectId: siteId });
  const accounts = await db.prepare("SELECT id, key FROM social_accounts").all<{ id: number; key: string }>();
  for (const a of accounts.results) await setSwitches(db, owner, a.id, { enabled: true, dailyCap: 2 });
  for (const slug of ["foxhound-waits", "autumn-release-notes"]) {
    await recordPublication(db, siteId, { id: slug, title: slug === "foxhound-waits" ? "Why Foxhound waits before it pages you" : "Notes on the autumn release", url: `${SITE_ORIGIN}/blog/${slug}`, summary: "" });
  }
  await draftSocialPost(db, { accountKey: "germomics-bluesky", projectId: siteId, itemId: "foxhound-waits", text: "New on dustinedwards.info: why a watcher should wait for a pattern before it pages you. https://dustinedwards.info/blog/foxhound-waits", createdBy: "Claude Code" });
  await db.prepare("UPDATE social_posts SET status = 'awaiting' WHERE status = 'drafted'").run();
  const event = await db.prepare("SELECT id, account_id FROM social_events ORDER BY id LIMIT 1").first<{ id: number; account_id: number }>();
  if (event) {
    await db
      .prepare("INSERT INTO social_posts (account_id, event_id, text, source, status, lint, created_by) VALUES (?, ?, ?, 'routine', 'held', ?, 'Claude Code')")
      .bind(event.account_id, event.id, "Foxhound waits. Here is why, in three sentences and one chart that will change how you think about alerts.", JSON.stringify(["Uses an AI habit: \"chart that will change\"", "Over 120 characters before the link"]))
      .run();
  }
  return { env };
}

function saved(result: { version: string }): string {
  return result.version;
}
