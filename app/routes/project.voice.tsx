// A site project's voice pack (voice.server.ts): what an AI session reads before it drafts a post here,
// and what its drafts are checked against. The measures and excerpts come from the published posts; the
// guide and the two word lists are the Owner's. Below them, the words the author keeps cutting from AI
// drafts, offered for the list: the author adds one or sets it aside, and nothing is added on its own.

import { Form, useNavigation } from "react-router";
import { Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { Time } from "capsomer/react/time";

import { ProjectTabs } from "~/components/project-tabs";

import { getEnv, getViewer } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteEntry } from "~/lib/sites.server";
import { briefOf, buildVoicePack, CUT_SUGGEST_AT, cutSuggestions, decideCut, listFrom, PACK_POSTS, readVoicePack, saveVoiceGuide } from "~/lib/voice.server";

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
    suggestions: await cutSuggestions(env.DB, project, pack),
    limits: { posts: PACK_POSTS, cutAt: CUT_SUGGEST_AT },
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
    return { done: pack.profile ? `Rebuilt from ${pack.posts} published posts.` : `Read ${pack.posts} published posts: not enough text yet to measure (about 900 words).` };
  }
  const project = await requireSiteProject(env.DB, viewer, params.project, "manage");
  if (intent === "save") {
    await saveVoiceGuide(env.DB, project, {
      guide: String(form.get("guide") ?? ""),
      phrases: listFrom(String(form.get("phrases") ?? "")),
      allow: listFrom(String(form.get("allow") ?? "")),
    });
    return { done: "Saved the guide and lists." };
  }
  if (intent === "add" || intent === "set-aside") {
    const phrase = String(form.get("phrase") ?? "").trim();
    if (!phrase) throw new Response("Bad request", { status: 400 });
    await decideCut(env.DB, project, phrase, intent);
    return { done: intent === "add" ? `Added "${phrase}" to the list.` : `Set "${phrase}" aside.` };
  }
  throw new Response("Bad request", { status: 400 });
}

export default function ProjectVoice({ loaderData, actionData }: Route.ComponentProps) {
  const { project, canManage, brief, suggestions, limits } = loaderData;
  const busy = useNavigation().state !== "idle";

  return (
    <div className="app-page">
      <PageHead
        title={project.name}
        lead={`What an AI session reads before it drafts a post for ${project.site}, and what its drafts are checked against. Drafts are written from your own posts, and you still edit every one.`}
      />

      <ProjectTabs slug={project.slug} current="voice" mentions={project.mentions} />

      {actionData?.done ? <Banner tone="ok">{actionData.done}</Banner> : null}

      <Panel
        title="From your published posts"
        src={brief.builtAt ? `${brief.posts} posts` : "Not built yet"}
        actions={
          <Form method="post">
            <Button type="submit" name="intent" value="rebuild" size="sm" pending={busy}>
              Rebuild
            </Button>
          </Form>
        }
      >
        {brief.builtAt ? (
          <p>
            Read from the newest {limits.posts} published posts, <Time at={brief.builtAt} />. Rebuild after publishing a few more.
          </p>
        ) : (
          <p>Built from the newest {limits.posts} published posts the first time a session asks for it, or now with Rebuild.</p>
        )}
        {brief.measures.length > 0 ? (
          <ul>
            {brief.measures.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : brief.builtAt ? (
          <p>Not enough published text to measure yet: about 900 words are needed.</p>
        ) : null}
        {brief.excerpts.length > 0 ? (
          <details>
            <summary>The {brief.excerpts.length} excerpts a session writes from</summary>
            {brief.excerpts.map((excerpt, i) => (
              <blockquote key={i} className="app-voice-excerpt">
                {excerpt}
              </blockquote>
            ))}
          </details>
        ) : null}
      </Panel>

      <Panel title="Your guide and lists" src={canManage ? "Yours to edit" : "The Owner edits these"}>
        <Form method="post" className="app-fm" aria-label="Voice guide">
          <Field label="Guide" help="Anything a session should know about how you write here: who reads it, what you never say, how you open and close.">
            <textarea className="cap-input" name="guide" rows={6} defaultValue={brief.guide} readOnly={!canManage} />
          </Field>
          <Field label="Words and phrases to flag" help="One per line, on top of the shared list of stock AI phrasing.">
            <textarea className="cap-input" name="phrases" rows={5} defaultValue={brief.phrases.join("\n")} readOnly={!canManage} />
          </Field>
          <Field label="Words to allow" help="One per line: words you use yourself that the shared list would flag.">
            <textarea className="cap-input" name="allow" rows={3} defaultValue={brief.allow.join("\n")} readOnly={!canManage} />
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

      <Panel title="Words you keep cutting" count={suggestions.length} src={`Cut from AI drafts of ${limits.cutAt} or more posts, and kept in none`} flush>
        {suggestions.length === 0 ? (
          <Empty kind="nothing-yet" flush title="Nothing yet">
            When you publish a post an AI session drafted, Carrel notes the words you cut. One you cut from {limits.cutAt} posts shows up here.
          </Empty>
        ) : (
          <RowList label="Words you keep cutting">
            {suggestions.map((s) => (
              <Row
                key={s.phrase}
                title={s.phrase}
                detail={`Cut from ${s.posts} posts`}
                meta={<Time at={s.lastCutAt} />}
                actions={
                  canManage ? (
                    <Form method="post" className="app-actions">
                      <input type="hidden" name="phrase" value={s.phrase} />
                      <Button type="submit" name="intent" value="add" size="sm">
                        Add to list<span className="cap-sr-only">: {s.phrase}</span>
                      </Button>
                      <Button type="submit" name="intent" value="set-aside" size="sm" variant="quiet">
                        Set aside<span className="cap-sr-only">: {s.phrase}</span>
                      </Button>
                    </Form>
                  ) : undefined
                }
              />
            ))}
          </RowList>
        )}
      </Panel>
    </div>
  );
}
