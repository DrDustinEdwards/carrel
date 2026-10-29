// The media library for one site: Capsomer's MediaLibrary over the content kit, the same screen and
// the same intents as each site's own admin. Browse, search, tags, the site's lenses and filters,
// upload and import from a web address, the inspector (alt text, tags, caption, credit and license,
// focal point, crop, turns, shrink, history and replace, and the model's suggestions when the person
// asks for them), Trash with Undo, delete for good after the kit asks, and, with script, live updates
// of what others changed. Every action is a form post, so it all works with no script; with script
// the posts go through the media endpoint and answer in place.
//
// Each write is optional per site (the site's meta says which), and the screen shows only what the
// site offers and the person's role allows (lib/media.server.ts).

import { Form, useRevalidator, type FormProps } from "react-router";
import { Banner } from "capsomer/react/banner";
import { MediaLibrary, type FormComponent, type KitMediaChanges } from "capsomer/react/media-library";
import { mediaDataOfKit, readMediaView } from "capsomer/behavior/media-library";
import type { MediaRecord } from "capsomer/behavior/media";
import { PageHead } from "capsomer/react/page-head";
import { loadMedia, readMediaQuery, type IntentResult } from "@dustinedwards/site-api/admin";

import { ProjectTabs } from "~/components/project-tabs";
import { getEnv, getViewer } from "~/lib/context";
import { mediaSource, runIntent, unreachable, useHref } from "~/lib/media.server";
import { requireSiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteEntry } from "~/lib/sites.server";

import type { Route } from "./+types/media";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Media · ${data.project.name} · Carrel` : "Carrel" }];
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  const search = new URL(request.url).searchParams;
  const head = { slug: project.slug, name: project.name, site: siteEntry(project.site).name, mentions: can(project.role, "read_mentions") };
  try {
    const kit = await loadMedia(mediaSource(env, project, viewer), readMediaQuery(search));
    if (!kit.offers.media) return { project: head, data: null, unavailable: "This site has no media library yet." };
    const pick = search.get("pick") ?? "";
    const data = mediaDataOfKit(kit, { usedHref: (use) => useHref(project.slug, use), view: { ...readMediaView(search), ...(pick ? { pick } : {}) } });
    return { project: head, data, unavailable: null };
  } catch (error) {
    const message = unreachable(error);
    if (message === null) throw error;
    return { project: head, data: null, unavailable: message };
  }
}

export async function action({ params, request, context }: Route.ActionArgs): Promise<IntentResult> {
  return runIntent(getEnv(context), getViewer(context), params.project, await request.formData());
}

// Moving between views (search, a tag, a file to open) is the router's GET, so it stays in the app;
// a post is a plain form, which the library sends through `submit` with script and the browser sends
// to this route's action without.
const LibraryForm: FormComponent = ({ method, action, ...props }) =>
  (method ?? "get").toLowerCase() === "get" ? <Form {...(props as Omit<FormProps, "method" | "action">)} action={typeof action === "string" ? action : undefined} method="get" /> : <form {...props} action={action} method={method} />;

export default function MediaPage({ loaderData, actionData }: Route.ComponentProps) {
  const { project, data, unavailable } = loaderData;
  const revalidator = useRevalidator();
  const base = `/p/${encodeURIComponent(project.slug)}/media`;
  // With script each intent posts to the media endpoint, and the page reads the files again after it.
  const submit = async (form: FormData): Promise<IntentResult> => {
    const response = await fetch(`${base}/api`, { method: "POST", body: form, headers: { accept: "application/json" } });
    const body = (await response.json().catch(() => null)) as IntentResult | { error?: string } | null;
    if (body && "ok" in body) {
      if (!body.confirm) void revalidator.revalidate();
      return body;
    }
    return { ok: false, message: (body && "error" in body && body.error) || `The server answered ${response.status}.` };
  };
  const search = async (q: string, signal: AbortSignal): Promise<MediaRecord[]> => {
    const response = await fetch(`${base}/api?q=${encodeURIComponent(q)}`, { signal, headers: { accept: "application/json" } });
    const body = (await response.json().catch(() => null)) as { rows?: MediaRecord[] } | null;
    return body?.rows ?? [];
  };
  // Live updates, where the site offers them: what others changed since the cursor, asked of the
  // media endpoint. A failed answer throws, and the library asks again later.
  const changes = async (cursor: string, signal: AbortSignal): Promise<KitMediaChanges | { reload: true }> => {
    const response = await fetch(`${base}/api?changes=${encodeURIComponent(cursor)}`, { signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`The server answered ${response.status}.`);
    return (await response.json()) as KitMediaChanges | { reload: true };
  };
  return (
    <div className="app-page">
      <PageHead title={project.name} lead={`The files on ${project.site}, kept and served by the site. Carrel only shows them here.`} />
      <ProjectTabs slug={project.slug} current="media" mentions={project.mentions} />
      {unavailable || !data ? (
        <Banner tone="warn">{unavailable}</Banner>
      ) : (
        <MediaLibrary data={data} action={base} Form={LibraryForm} submit={submit} result={actionData ?? null} inspector="form" search={search} bytesHref={(id) => `${base}/api?bytes=${encodeURIComponent(id)}`} changes={changes} />
      )}
    </div>
  );
}
