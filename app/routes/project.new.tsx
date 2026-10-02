// A new post starts as a Carrel draft under a slug the site does not hold yet. Nothing reaches the
// site until the first Save, which sends it with expectedVersion null: the site refuses it if the
// slug was taken in the meantime.

import { Form, redirect, useNavigation } from "react-router";
import { Button } from "capsomer/react/button";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";

import { PageHead } from "~/components/page-head";

import { autosave, readDoc } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { requireSiteProject } from "~/lib/projects.server";
import { siteEntry } from "~/lib/sites.server";

import type { Route } from "./+types/project.new";

/** Stricter than the contract's id: lower case, digits and single hyphens, as the site's slugs are. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function meta() {
  return [{ title: "New post · Carrel" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireSiteProject(env.DB, getViewer(context), params.project, "edit");
  return { project: { slug: project.slug, name: project.name } };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "edit");
  const slug = String((await request.formData()).get("slug") ?? "").trim();
  if (!SLUG.test(slug) || slug.length > 120) {
    return { error: "Use lower-case letters, digits and single hyphens, such as my-new-post." };
  }
  if (await readDoc(env, project, slug)) {
    return { error: `The site already has a post at ${slug}. Open it from the list instead.` };
  }
  const today = new Date().toISOString().slice(0, 10);
  await autosave(env.DB, project, viewer, slug, { source: siteEntry(project.site).newSource(slug, today), baseVersion: null });
  return redirect(`/p/${project.slug}/e/${slug}`);
}

export default function NewPost({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return (
    <div className="app-page" data-narrow>
      <PageHead
        crumbs={[{ label: loaderData.project.name, href: `/p/${loaderData.project.slug}` }, { label: "New post" }]}
        title="New post"
        lead="A new post starts as a draft in Carrel, under the address you give it."
      />
      <Panel title="Address">
        <Form method="post" className="app-form">
          <Field label="Slug, the post's address on the site" required help="Lower-case letters, digits and single hyphens, such as my-new-post. It becomes /blog/<slug>. It stays a draft in Carrel until you save it to the site." error={actionData?.error} announce>
            <input className="cap-input" name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" autoComplete="off" spellCheck={false} data-error-pattern-mismatch="Use lower-case letters, digits and single hyphens, such as my-new-post." />
          </Field>
          <div className="app-actions">
            <Button type="submit" variant="primary" pending={busy}>
              Start writing
            </Button>
          </div>
        </Form>
      </Panel>
    </div>
  );
}
