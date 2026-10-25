// A site project's voice pack (voice.server.ts): what an AI session reads before it drafts a post here,
// and what its drafts are scanned against. The excerpts come from the author's own writing the Owner
// pastes here, or from the published posts while there is none; the guide is the Owner's. No word lists
// and no measured averages: the excerpts are the example.

import { Form, useNavigation } from "react-router";
import { Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Field } from "capsomer/react/field";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Time } from "capsomer/react/time";

import { ProjectTabs } from "~/components/project-tabs";

import { getEnv, getViewer } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteEntry } from "~/lib/sites.server";
import { briefOf, buildVoicePack, PACK_POSTS, readVoicePack, saveVoiceGuide } from "~/lib/voice.server";

import type { Route } from "./+types/project.voice";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Voice · ${data.project.name} · Carrel` : "Carrel" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireSiteProject(env.DB, getViewer(context), params.project, "read");
  const pack = await readVoicePack(env.DB, project);
  return {
    project: { slug: project.slug, name: project.name, site: siteEntry(project.site).name, mentions: can(project.role, "read_mentions") },
    canManage: can(project.role, "manage"),
    brief: briefOf(pack),
    own: pack.own,
    limits: { posts: PACK_POSTS },
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "rebuild") {
    const project = await requireSiteProject(env.DB, viewer, params.project, "read");
    const pack = await buildVoicePack(env, project);
    const read = pack.from === "own" ? `${pack.pieces} pieces of your own writing` : `${pack.pieces} published posts`;
    return {
      done: pack.excerpts.length ? `Rebuilt from ${read}: ${pack.excerpts.length} excerpts.` : `Read ${read}: none had enough prose for an excerpt yet.`,
    };
  }
  const project = await requireSiteProject(env.DB, viewer, params.project, "manage");
  if (intent === "save") {
    await saveVoiceGuide(env.DB, project, { guide: String(form.get("guide") ?? ""), own: String(form.get("own") ?? "") });
    return { done: "Saved." };
  }
  throw new Response("Bad request", { status: 400 });
}

export default function ProjectVoice({ loaderData, actionData }: Route.ComponentProps) {
  const { project, canManage, brief, own, limits } = loaderData;
  const fromOwn = brief.from === "own";
  const busy = useNavigation().state !== "idle";

  return (
    <div className="app-page">
      <PageHead
        title={project.name}
        lead={`What an AI session reads before it drafts a post for ${project.site}, and what its drafts are scanned against. Drafts are written from your own writing, and you still edit every one.`}
      />

      <ProjectTabs slug={project.slug} current="voice" mentions={project.mentions} />

      {actionData?.done ? <Banner tone="ok">{actionData.done}</Banner> : null}

      <Panel
        title={fromOwn ? "From your own writing" : "From your published posts"}
        src={!brief.builtAt ? "Not built yet" : fromOwn ? `${brief.pieces} pieces` : `${brief.pieces} posts`}
        actions={
          <Form method="post">
            <Button type="submit" name="intent" value="rebuild" size="sm" pending={busy}>
              Rebuild
            </Button>
          </Form>
        }
      >
        {fromOwn ? (
          <p>Chosen from the own writing below. Your published posts are not read while there is any.</p>
        ) : brief.builtAt ? (
          <p>
            Read from the newest {limits.posts} published posts, <Time at={brief.builtAt} />. Rebuild after publishing a few more.
          </p>
        ) : (
          <p>Built from the newest {limits.posts} published posts the first time a session asks for it, or now with Rebuild.</p>
        )}
        {brief.builtAt && brief.excerpts.length === 0 ? <p>{fromOwn ? "No piece" : "No post"} had enough prose for an excerpt yet.</p> : null}
        {brief.excerpts.length > 0 ? (
          <details>
            <summary>The {brief.excerpts.length} excerpts a session writes from, and its drafts are scanned against</summary>
            {brief.excerpts.map((excerpt, i) => (
              <blockquote key={i} className="app-voice-excerpt">
                {excerpt}
              </blockquote>
            ))}
          </details>
        ) : null}
      </Panel>

      <Panel title="Your guide and writing" src={canManage ? "Yours to edit" : "The Owner edits it"}>
        <Form method="post" className="app-fm" aria-label="Voice guide and own writing">
          <Field label="Guide" help="Anything a session should know about how you write here: who reads it, what you never say, how you open and close.">
            <textarea className="cap-input" name="guide" rows={6} defaultValue={brief.guide} readOnly={!canManage} />
          </Field>
          <Field
            label="Your own writing"
            help="Things you wrote yourself, with no AI help: papers, letters, old posts. Put a line holding only --- between pieces. While there is any, the excerpts come from it and not from the published posts."
          >
            <textarea className="cap-input" name="own" rows={12} defaultValue={own} readOnly={!canManage} />
          </Field>
          {canManage ? (
            <div className="app-actions">
              <Button type="submit" name="intent" value="save" variant="primary" pending={busy}>
                Save
              </Button>
            </div>
          ) : null}
        </Form>
      </Panel>

    </div>
  );
}
