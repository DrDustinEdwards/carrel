// An episode's transcript, fixed in Carrel and put live through site-api v0.36.0 (PUT /content/:id/transcript). The
// transcript is machine-made and mishears names and terms ("Wheel's disease" for Weil's disease); a session saves a
// corrected whole transcript as a draft beside the site's, never over it, and it goes live only when someone who may
// publish the episode publishes it: Dustin from Desk, or his own AI session through carrel_publish_item on his
// instruction (ai.server.ts, aiPublishTranscript). Roles are checked here, as content.server.ts checks them for posts.
//
// A transcript has its own version (transcriptVersion); the item's version does not move when it changes, so the post
// drafts saved beside it stay good. A draft is published only from the transcriptVersion it was written from, and
// every publish keeps the transcript it replaced as a draft of its own, so a publish can be put back.

import { SiteApiError } from "@dustinedwards/site-api/client";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { transcriptChanges, transcriptDrafts } from "~/db/schema";
import { mayPublishItem, readDoc, type ProjectRole } from "~/lib/content.server";
import type { Viewer } from "~/lib/people.server";
import type { SiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteClient } from "~/lib/sites.server";
import {
  applyTranscriptEdits,
  transcriptChanges as changesOf,
  transcriptRefusal,
} from "~/lib/transcript";

/** A transcript save or publish refused, said in words for the person or the session. */
export class TranscriptRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptRefusal";
  }
}

function forbid(): never {
  throw new Response("Forbidden", { status: 403 });
}

/** The client a draft that keeps a replaced transcript is credited to. */
const KEPT_CLIENT = "Carrel";

/** The site's episode with its transcript and that transcript's version, or a refusal naming why it cannot be fixed. */
async function episodeOf(env: Env, project: SiteProject, itemId: string, fetcher?: typeof fetch) {
  const client = siteClient(env, project.site, fetcher);
  if ((await client.meta()).capabilities.contentTranscript !== true)
    throw new TranscriptRefusal(
      "This site's transcripts are read only: it does not take a transcript through the site API yet.",
    );
  const doc = await readDoc(env, project, itemId, fetcher);
  if (!doc) throw new TranscriptRefusal(`There is no post ${itemId} on the site.`);
  if (doc.transcript === undefined)
    throw new TranscriptRefusal(`${itemId} has no transcript on the site to fix.`);
  return { client, doc, transcript: doc.transcript, version: doc.transcriptVersion ?? null };
}

/**
 * Saves a corrected transcript beside the site's: the whole WebVTT, or the site's transcript with `edits` applied (each
 * `find` replaced everywhere it occurs). Refused for a reviewer, for anyone who may not edit, and for text that is not
 * WebVTT. Answers what it changes, cue by cue.
 */
export async function saveTranscriptDraft(
  env: Env,
  project: SiteProject,
  author: { viewer: Viewer; client: string },
  itemId: string,
  input: { transcript?: string; edits?: { find: string; replace: string }[]; note?: string },
  fetcher?: typeof fetch,
) {
  if (author.viewer.isReviewer)
    throw new TranscriptRefusal(
      "A reviewer flags; it does not write text. Use carrel_add_finding.",
    );
  if (!can(project.role, "edit"))
    throw new TranscriptRefusal("You may not write drafts on this project.");
  if ((input.transcript === undefined) === (input.edits === undefined))
    throw new TranscriptRefusal(
      "Send either the whole transcript or edits to the site's, not both.",
    );
  const site = await episodeOf(env, project, itemId, fetcher);
  let transcript: string;
  let replaced: number[] | undefined;
  if (input.edits) {
    const edited = applyTranscriptEdits(site.transcript, input.edits);
    if (!edited.ok) throw new TranscriptRefusal(edited.why);
    transcript = edited.transcript;
    replaced = edited.replaced;
  } else transcript = input.transcript!.replace(/\r\n/g, "\n");
  const refusal = transcriptRefusal(transcript);
  if (refusal) throw new TranscriptRefusal(refusal);
  if (transcript === site.transcript.replace(/\r\n/g, "\n"))
    throw new TranscriptRefusal(
      "The draft is the site's transcript as it stands: nothing to save.",
    );
  const [row] = await drizzle(env.DB)
    .insert(transcriptDrafts)
    .values({
      projectId: project.id,
      itemId,
      personId: author.viewer.id,
      client: author.client,
      transcript,
      baseTranscriptVersion: site.version,
      note: (input.note ?? "").trim().slice(0, 500),
    })
    .returning({ id: transcriptDrafts.id });
  return {
    id: row!.id,
    baseTranscriptVersion: site.version,
    ...(replaced ? { replaced } : {}),
    changes: changesOf(site.transcript, transcript),
  };
}

export type TranscriptDraftSummary = {
  id: number;
  client: string;
  note: string;
  createdAt: string;
  baseTranscriptVersion: string | null;
};

/** The transcript drafts a person's own sessions saved for this item, newest first. Private to the person, as drafts are. */
export async function listTranscriptDrafts(
  db: D1Database,
  project: ProjectRole,
  viewer: Viewer,
  itemId: string,
): Promise<TranscriptDraftSummary[]> {
  if (!can(project.role, "read")) forbid();
  return drizzle(db)
    .select({
      id: transcriptDrafts.id,
      client: transcriptDrafts.client,
      note: transcriptDrafts.note,
      createdAt: transcriptDrafts.createdAt,
      baseTranscriptVersion: transcriptDrafts.baseTranscriptVersion,
    })
    .from(transcriptDrafts)
    .where(
      and(
        eq(transcriptDrafts.projectId, project.id),
        eq(transcriptDrafts.itemId, itemId),
        eq(transcriptDrafts.personId, viewer.id),
      ),
    )
    .orderBy(desc(transcriptDrafts.createdAt), desc(transcriptDrafts.id))
    .all();
}

export async function readTranscriptDraft(
  db: D1Database,
  project: ProjectRole,
  viewer: Viewer,
  itemId: string,
  id: number,
) {
  if (!can(project.role, "read")) forbid();
  const row = await drizzle(db)
    .select()
    .from(transcriptDrafts)
    .where(
      and(
        eq(transcriptDrafts.id, id),
        eq(transcriptDrafts.projectId, project.id),
        eq(transcriptDrafts.itemId, itemId),
        eq(transcriptDrafts.personId, viewer.id),
      ),
    )
    .get();
  if (!row) throw new Response("Not found", { status: 404 });
  return row;
}

/** A transcript draft against the site's transcript now, for the page that shows it and the session that asks. */
export async function compareTranscriptDraft(
  env: Env,
  project: SiteProject,
  draft: { transcript: string; baseTranscriptVersion: string | null },
  itemId: string,
  fetcher?: typeof fetch,
) {
  const site = await episodeOf(env, project, itemId, fetcher);
  return {
    current: site.version === draft.baseTranscriptVersion,
    changes: changesOf(site.transcript, draft.transcript),
  };
}

export type TranscriptPublished = {
  changeId: string;
  version: string;
  transcriptVersion: string;
  /** The draft that keeps the transcript this publish replaced, to put it back. */
  keptDraftId: number;
};

/**
 * Puts one of this person's transcript drafts live. Refused unless they may publish this episode, unless the draft was
 * written from the transcript the site holds now, and, when `expectedVersion` is given, unless the item is still at that
 * version. Records the change and keeps the replaced transcript as a draft of its own.
 */
export async function publishTranscriptDraft(
  env: Env,
  project: SiteProject,
  viewer: Viewer,
  itemId: string,
  draftId: number,
  opts: { expectedVersion?: string; client?: string; fetcher?: typeof fetch } = {},
): Promise<TranscriptPublished> {
  if (!(await mayPublishItem(env.DB, project, viewer, itemId))) forbid();
  const draft = await readTranscriptDraft(env.DB, project, viewer, itemId, draftId).catch(
    () => null,
  );
  if (!draft)
    throw new TranscriptRefusal(`There is no transcript draft ${draftId} of ${itemId} of yours.`);
  const site = await episodeOf(env, project, itemId, opts.fetcher);
  if (opts.expectedVersion !== undefined && site.doc.version !== opts.expectedVersion)
    throw new TranscriptRefusal(
      `${itemId} is at version ${site.doc.version} on the site, not ${opts.expectedVersion}. Read it again first.`,
    );
  const stale = `Transcript draft ${draftId} was written from another transcript than the one the site holds now. Save a new draft from the current transcript.`;
  if (draft.baseTranscriptVersion !== site.version) throw new TranscriptRefusal(stale);

  const changeId = crypto.randomUUID();
  let written;
  try {
    written = await site.client.setTranscript(itemId, {
      transcript: draft.transcript,
      expectedTranscriptVersion: site.version,
      changeId,
      actor: { name: viewer.name },
    });
  } catch (error) {
    if (error instanceof SiteApiError && error.body?.error === "version-conflict")
      throw new TranscriptRefusal(stale);
    if (
      error instanceof SiteApiError &&
      error.body &&
      ["refused", "invalid"].includes(error.body.error)
    )
      throw new TranscriptRefusal(error.body.message);
    throw error;
  }

  const d = drizzle(env.DB);
  await d.insert(transcriptChanges).values({
    id: changeId,
    projectId: project.id,
    itemId,
    personId: viewer.id,
    client: opts.client ?? null,
    draftId,
    versionBefore: site.version,
    versionAfter: written.transcriptVersion,
  });
  const [kept] = await d
    .insert(transcriptDrafts)
    .values({
      projectId: project.id,
      itemId,
      personId: viewer.id,
      client: KEPT_CLIENT,
      transcript: site.transcript,
      baseTranscriptVersion: written.transcriptVersion,
      note: `The transcript before draft ${draftId} went live. Publish this to put it back.`,
    })
    .returning({ id: transcriptDrafts.id });
  return {
    changeId,
    version: written.version,
    transcriptVersion: written.transcriptVersion,
    keptDraftId: kept!.id,
  };
}
