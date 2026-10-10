// The world the screen harness shows: three people, a site with posts and media, two books, a shared
// Drive folder and a social queue, all made through the app's own functions against the test fakes.
// Test-only; nothing here is deployed and nothing reaches the network.


import { addFinding, saveAiDraft } from "~/lib/ai.server";
import { createBook, refreshBook, requireBookProject, saveBookAiDraft } from "~/lib/books.server";
import { autosave, writeToSite } from "~/lib/content.server";
import { refreshIndex } from "~/lib/index.server";
import { finishAuth, startAuth } from "~/lib/google/oauth.server";
import { refreshManuscripts } from "~/lib/google/drive.server";
import { setMediaTags, trashMedia, uploadMedia } from "~/lib/media.server";
import { findViewer } from "~/lib/people.server";
import { requireSiteProject } from "~/lib/projects.server";
import { clearTokenCache, novelsRepo } from "~/lib/novels/repo.server";
import { createAccount, draftSocialPost, recordPublication, setSwitches } from "~/lib/social/queue.server";

import { BASELINE } from "../fixtures/voice";
import { CODE, fakeGoogle, serviceAccountKey } from "../google";
import { fakeNovels, githubStyleKey } from "../novels";
import { fakeSite, kindedAdapter, SITE_KEY, SITE_ORIGIN } from "../site";

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

/** The writing-desk keys (job_50786e609b88) put at the top of a scene's header. */
const planned = (scene: string, status: string, summary: string, target: number) => scene.replace("---\n", `---\nstatus: ${status}\nsummary: ${summary}\ntarget: ${target}\n`);

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

  const [site, gh, saKey, appKey] = [fakeSite(kindedAdapter()), fakeNovels(), await serviceAccountKey(), await githubStyleKey()];
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
  const uploaded: Array<{ id: string; version: string; name: string }> = [];
  for (const [name, alt] of [
    ["foxhound-dashboard.png", "The Foxhound dashboard with three sites reporting healthy"],
    ["lambda-switch.png", "A diagram of the CI and Cro switch in phage lambda"],
    ["harlan-gate.png", ""],
    ["river-up.png", "The river at the low-water crossing, in flood"],
    ["field-notebook.png", "An open field notebook with a pressed leaf"],
    ["release-banner.png", ""],
  ] as const) {
    const out = await uploadMedia(env, sitePr, { viewer: owner }, { name, type: "image/png", size: PNG.byteLength, bytes: async () => PNG.slice().buffer }, alt);
    if (out.ok) {
      media.push(out.item.url);
      uploaded.push({ id: out.item.id, version: out.item.version ?? "", name });
    }
  }
  // Tags on two files and one in the trash, so the library, the tag filter and the Trash view all have something to show.
  const writer = { viewer: owner };
  for (const [name, tags] of [["foxhound-dashboard.png", ["foxhound", "screenshots"]], ["lambda-switch.png", ["phage", "diagrams"]]] as const) {
    const file = uploaded.find((u) => u.name === name);
    if (file) {
      const tagged = await setMediaTags(env, sitePr, writer, file.id, [...tags], file.version);
      if (tagged.ok) file.version = tagged.version;
    }
  }
  const banner = uploaded.find((u) => u.name === "release-banner.png");
  if (banner) await trashMedia(env, sitePr, writer, banner.id, banner.version);

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
  // One item of each other kind the real site reports, published, so the walk covers every kind.
  for (const [id, source] of [
    ["publication.10-1128-mra-00123-23", '---\ntitle: "Genome sequence of Gordonia phage Acorn15"\njournal: Microbiology Resource Announcements\nyear: 2023\n---\n'],
    ["document.llms", "# dustinedwards.info\n\n> Writing, research and software by Dustin Edwards.\n"],
    ["cv.appointments", "---\ntitle: Appointments\n---\n\n- Associate Professor of Biology\n"],
    ["dictionary.capsid", "---\ntitle: capsid\n---\nThe protein shell of a virus.\n"],
    ["roster.2017", "---\ntitle: 2017 cohort\nyear: 2017\nresearchers: [Megan Adams, Travis Miller]\n---\n"],
    ["phage.acorn15", "---\ntitle: Acorn15\nhost: Gordonia terrae\ncluster: DJ\n---\n"],
    ["procedure.coi-primers", "---\ntitle: \"COI primers: LCO1490 and HCO2198\"\n---\n\nThe PCR protocol for COI barcoding.\n"],
  ] as const) {
    const saved = await site.adapter.content.saveDraft(id, { source, expectedVersion: null, changeId: `seed-${id}` });
    await site.adapter.content.publish(id, { expectedVersion: saved.version, changeId: `seed-pub-${id}` });
  }
  const sched = await site.adapter.content.saveDraft("bacterial-genetics-primer", {
    source: post("A primer on bacterial genetics", "bacterial-genetics-primer", "Plasmids, transposons and the vocabulary a reader needs first.", "2026-10-09", ["genetics", "primer"], "Before phage, a few words about what a bacterium carries."),
    expectedVersion: null,
    changeId: "seed-primer",
  });
  await writeToSite(env, sitePr, owner, "bacterial-genetics-primer", { action: "schedule", expectedVersion: saved(sched), publishAt: "2026-10-09T13:00:00.000Z" }, site.fetch);
  // The webmention queue: a mix of states, with fake senders on the reserved .example domains. Two are
  // past the site's retention windows, so the Retention panel has something to offer to sweep.
  const day = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.parse("2026-10-06T12:00:00Z") - days * day);
  for (const m of [
    { sourceUrl: "https://fieldnotes.example/2026/10/lysis-and-lysogeny", targetId: "foxhound-waits", authorName: "Rosa Okafor", authorUrl: "https://fieldnotes.example", excerpt: "A clear account of why a page should wait before it wakes anyone, and what the wait costs.", receivedAt: ago(1) },
    { sourceUrl: "https://microbial-reading-group.example/notes/week-14", targetId: "how-the-index-refreshes", authorName: "Tomas Brandt", authorUrl: null, excerpt: "We read this in the group: the refresh order is the part that finally made the cron make sense.", receivedAt: ago(2) },
    { sourceUrl: "https://slowweb.example/links", targetId: "foxhound-waits", authorName: null, excerpt: "Links from this week: the Foxhound piece, a long read on plasmids, a short one on fonts.", receivedAt: ago(3) },
    { sourceUrl: "https://quiet-desk.example/carrels", targetId: "what-a-carrel-is-for", authorName: "Mina Hale", authorUrl: "https://quiet-desk.example", excerpt: "Agreeing with the part about the habit a small desk builds.", status: "approved" as const, receivedAt: ago(9) },
    { sourceUrl: "https://seo-links.example/best-casino", targetId: "foxhound-waits", authorName: "Top Picks Daily", excerpt: null, status: "rejected" as const, receivedAt: ago(20) },
    { sourceUrl: "https://seo-links.example/older", targetId: "how-the-index-refreshes", authorName: "Top Picks Daily", excerpt: null, status: "rejected" as const, receivedAt: ago(120) },
    { sourceUrl: "https://gone.example/post-that-vanished", targetId: "foxhound-waits", authorName: null, excerpt: null, status: "failed" as const, failureReason: "source-unreachable", receivedAt: ago(4) },
    { sourceUrl: "https://gone.example/a-second-vanished-post", targetId: "how-the-index-refreshes", authorName: null, excerpt: null, status: "failed" as const, failureReason: "no-link-to-target", receivedAt: ago(45) },
    { sourceUrl: "https://newsletter.example/issue-31", targetId: "what-a-carrel-is-for", status: "unverified" as const, receivedAt: ago(0) },
  ]) {
    site.adapter.receiveMention({ authorUrl: null, ...m });
  }
  // Legal pages: two shared sections, and a privacy page that carries one with the Draft banner on. The
  // terms page is left out, so the Legal tab shows both a page that is set up and one that is not.
  for (const [key, title, body] of [
    ["hosting", "Hosting", "{{site_name}} runs on Cloudflare. Questions about this page go to {{contact}}."],
    ["analytics", "Analytics", "Cloudflare Web Analytics counts visits without tracking cookies. Nothing here is sold or shared for advertising."],
  ] as const) {
    await db.prepare("INSERT INTO legal_sections (key, title, body, updated_by) VALUES (?, ?, ?, ?)").bind(key, title, body, dustin).run();
  }
  const privacySource = [
      "---",
      "path: /privacy",
      'title: "Privacy"',
      "legal_type: privacy",
      'site_name: "dustinedwards.info"',
      'operator_name: "Dustin Edwards"',
      'contact: "/contact"',
      'banner: "Draft"',
      "---",
      "",
      "This page says what the site collects and why.",
      "",
      "<!-- shared:hosting -->",
      "",
    ].join("\n");
  // Written the way the editor writes it, so the shared section is expanded and the date stamped.
  const privacy = await writeToSite(env, sitePr, owner, "page.privacy", { action: "save", source: privacySource, expectedVersion: null }, site.fetch);
  if (!privacy.ok) throw new Error(privacy.message);
  await writeToSite(env, sitePr, owner, "page.privacy", { action: "publish", expectedVersion: privacy.version, source: privacySource }, site.fetch);
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

  // One draft with a history, a working copy that has moved on from the site, and an AI draft beside it:
  // the screens that show revisions, diffs and draft compare. Added after the other AI draft, so its id is 2.
  const REFRESH = "how-the-index-refreshes";
  const refreshTitle = "How the index refreshes";
  let refreshVersion: string | null = null;
  for (const body of [
    "The index is a copy of the site's list. It is read again every fifteen minutes.",
    "The index is a copy of the site's list. It is read again every fifteen minutes, and after every save.\n\nA save writes the new title and text at once, so the list never lags behind the editor.",
    "The index is a copy of the site's list. It is read again every fifteen minutes, and after every save.\n\nA save writes the new title and text at once, so the list never lags behind the editor.\n\nThe site stays the authority. When the two disagree, the next refresh wins.",
  ]) {
    const saved = await writeToSite(env, sitePr, owner, REFRESH, { action: "save", source: post(refreshTitle, REFRESH, "A note on the cached list.", "2026-10-03", ["carrel", "index"], body), expectedVersion: refreshVersion }, site.fetch);
    if (!saved.ok) throw new Error(saved.message);
    refreshVersion = saved.version;
  }
  const refreshDoc = await site.adapter.content.get(REFRESH);
  await autosave(db, sitePr, owner, REFRESH, {
    source: refreshDoc!.source.replace("is read again every fifteen minutes,", "is read again every quarter hour,").trimEnd() + "\n\nA refresh that finds nothing new changes nothing.\n",
    baseVersion: refreshDoc!.version,
  });
  await saveAiDraft(env, sitePr, claude, REFRESH, { source: post(refreshTitle, REFRESH, "A note on the cached list.", "2026-10-03", ["carrel", "index"], "The index copies the site's list and reads it again every fifteen minutes and after each save.\n\nThe site is the authority: when the two disagree, the next refresh wins."), note: "A shorter version, for you to take or leave." }, site.fetch);
  await refreshIndex(env, { id: siteId, site: "dustinedwards" });
  // The site's lab registry rows, as the real site lists them: data kinds that must stay out of the Posts list.
  const registry: [string, string][] = [["equipment.heat-block", "equipment"], ["equipment.nanodrop", "equipment"], ["reagent.agar", "reagent"], ["primer.16s-fwd", "primer"], ["strain.k12", "strain"]];
  await env.DB.batch(
    registry.map(([id, kind]) =>
      env.DB
        .prepare("INSERT INTO site_items (project_id, item_id, kind, title, status, synced_at) VALUES (?, ?, ?, ?, 'published', '2026-10-03T00:00:00Z')")
        .bind(siteId, id, kind, id),
    ),
  );

  // Books, indexed from the fake writing repository.
  gh.files.clear();
  const put = async (path: string, source: string) => {
    await gh.commitElsewhere(path, source);
  };
  await put(`${BOOK}/book.md`, "---\ntitle: The Paluxy Portal\nauthor: Dustin Edwards\nlanguage: en\ntarget: 90000\ndeadline: 2027-06-30\n---\n");
  await put(`${BOOK}/bible/characters/nell.md`, "---\nname: Nell Okafor\naliases: [Nell]\nborn: 1986-05-02\n---\nA surveyor who grew up two ranches over. Notices what is missing from a room.\n");
  await put(`${BOOK}/bible/characters/wade.md`, "---\nname: Wade Pruitt\naliases: [Wade]\nborn: 1996-02-11\n---\nBought the Harlan place from the bank in February. Keeps his own counsel.\n");
  await put(`${BOOK}/bible/places/harlan-place.md`, "---\nname: Harlan place\n---\nA ranch house back in the live oaks, porch sagging at the east corner.\n");
  await put(`${BOOK}/bible/places/low-water-crossing.md`, "---\nname: Low-water crossing\n---\nWhere the county road dips through the creek. It floods in April.\n");
  await put(`${BOOK}/bible/rules/no-phones.md`, "---\nname: No phones past the ridge\nforbidden: [phone rang]\n---\nThere is no signal past the ridge, and the story never pretends otherwise.\n");
  // The gate has a history: a first pass committed elsewhere, then the revision (job_b4555715afcf).
  await put(`${BOOK}/chapters/01-arrival/01-the-gate.md`, planned(SCENE_ONE.split("\n\n").slice(0, 2).join("\n\n") + "\n", "First draft", "Nell is let in past the locked gate", 1500));
  await put(`${BOOK}/chapters/01-arrival/01-the-gate.md`, planned(SCENE_ONE, "Revised", "Nell is let in past the locked gate", 1500));
  await put(`${BOOK}/chapters/01-arrival/02-supper.md`, planned(SCENE_TWO, "First draft", "Supper, and what Wade will not say", 1500));
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
  // An AI draft beside the gate, never committed, for the history page's comparison.
  await saveBookAiDraft(db, bookPr, claude, "chapters/01-arrival/01-the-gate.md", {
    source: planned(SCENE_ONE, "Revised", "Nell is let in past the locked gate", 1500).replace(/\n\n([^\n]+)\n?$/, "\n\nThe gate gave on the third try, and Wade did not look up.\n"),
    note: "A shorter close, for you to take or leave.",
  });
  // Dustin's last few days of typed words, and his goal: 500 a day, every day.
  const ownerId = owner.id;
  const DAY_MS = 86_400_000;
  const saves: [number, number, number][] = [
    [4, 610, 40],
    [3, 540, 0],
    [2, 720, 90],
    [1, 505, 0],
    [0, 220, 15],
  ];
  for (const [ago, typed, removed] of saves) {
    await db
      .prepare("INSERT INTO authorship (id, project_id, path, person_id, client, words_added, words_removed, version_before, version_after, commit_sha, created_at, words_typed) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, 'harness', 'harness', ?, ?)")
      .bind(`harness-${ago}`, rosaBook, "chapters/01-arrival/02-supper.md", ownerId, typed, removed, new Date(Date.now() - ago * DAY_MS).toISOString(), typed)
      .run();
  }
  await db.prepare("INSERT INTO writing_goals (project_id, person_id, mode, daily_target, writing_days, allow_negative) VALUES (?, ?, 'daily', 500, '0123456', 0)").bind(rosaBook, ownerId).run();
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
