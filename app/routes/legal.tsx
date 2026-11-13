// The Legal tab: a site's privacy and terms pages, and the shared sections they are written from.
// A legal page is an ordinary page on the site, edited in the normal editor; this tab lists them and
// keeps the text every site says alike. Nothing here is a second editor for a page.

import { Form, useNavigate, useNavigation } from "react-router";
import { Table } from "capsomer/react/table";
import { ConfirmModal } from "capsomer/react/confirm-dialog";
import { Link } from "capsomer/react/link";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Pill } from "capsomer/react/status";
import { PageHead } from "capsomer/react/page-head";

import { ProjectTabs } from "~/components/project-tabs";

import { readDoc } from "~/lib/content.server";
import { getEnv, getViewer } from "~/lib/context";
import { readKey, splitSource } from "@drdustinedwards/site-helpers/frontmatter";
import { BANNER_WORD } from "~/lib/frontmatter";
import { LEGAL_TYPES, legalItemId, sectionsUsed, type LegalType } from "~/lib/legal";
import { deleteSection, listSections, saveSection, sectionsCurrent } from "~/lib/legal.server";
import { requireSiteProject } from "~/lib/projects.server";
import { can } from "~/lib/roles";
import { siteEntry, SiteNotConnected } from "~/lib/sites.server";
import { confirmationSatisfied } from "@dustinedwards/site-runtime/confirm";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/legal";
import "capsomer/card.css";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Legal · ${data.project.name} · Carrel` : "Carrel" }];
}

const NAMES: Record<LegalType, string> = { privacy: "Privacy", terms: "Terms" };

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const project = await requireSiteProject(env.DB, getViewer(context), params.project, "read");
  const sections = await listSections(env.DB);
  let siteError: string | null = null;
  const pages = await Promise.all(
    LEGAL_TYPES.map(async (type) => {
      const id = legalItemId(type);
      try {
        const doc = await readDoc(env, project, id);
        if (!doc) return { type, id, setUp: false as const };
        const front = splitSource(doc.source).front;
        return {
          type,
          id,
          setUp: true as const,
          title: doc.title || NAMES[type],
          status: doc.status,
          lastUpdated: readKey(front, "last_updated"),
          draftBanner: readKey(front, "banner") === BANNER_WORD,
          version: doc.version,
          shared: sectionsUsed(splitSource(doc.source).body),
          behind: !(await sectionsCurrent(env.DB, doc.source)),
        };
      } catch (error) {
        siteError = error instanceof SiteNotConnected ? error.detail : "The site did not answer.";
        return { type, id, setUp: false as const };
      }
    }),
  );
  return {
    project: {
      slug: project.slug,
      name: project.name,
      site: siteEntry(project.site).name,
    },
    canManage: can(project.role, "manage"),
    siteError,
    pages,
    sections,
  };
}

/** The word typed to remove a shared section: nothing keeps an earlier copy of it. */
const REMOVE_WORD = "remove";

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireSiteProject(env.DB, viewer, params.project, "read");
  const form = await readForm(request);
  const intent = String(form.get("intent") ?? "");
  const key = String(form.get("key") ?? "");
  if (intent === "delete-section") {
    // A removed section has no earlier version to bring back, so the action asks, and asks for a typed word.
    if (!confirmationSatisfied(form, REMOVE_WORD)) {
      const tried = form.get("confirmed") === "1";
      return {
        saved: null,
        error: null,
        deleted: null,
        confirm: { key, refused: tried },
      };
    }
    await deleteSection(env.DB, project, key);
    return { saved: null, error: null, deleted: key, confirm: null };
  }
  if (intent !== "save-section") throw new Response("Bad request", { status: 400 });
  const result = await saveSection(env.DB, project, viewer, {
    key,
    title: String(form.get("title") ?? ""),
    body: String(form.get("body") ?? ""),
  });
  return result.ok
    ? { saved: key, error: null, deleted: null, confirm: null }
    : { saved: null, error: result.message, deleted: null, confirm: null };
}

export default function Legal({ loaderData, actionData }: Route.ComponentProps) {
  const { project, canManage, siteError, pages, sections } = loaderData;
  const navigation = useNavigation();
  const navigate = useNavigate();
  const saving = navigation.state !== "idle" ? String(navigation.formData?.get("key") ?? "") : null;

  return (
    <div className="app-page">
      <PageHead
        title={project.name}
        lead={`The privacy and terms pages on ${project.site}, and the text every site shares.`}
      />
      <ProjectTabs slug={project.slug} current="legal" />

      {siteError ? (
        <Banner tone="warn" title="The site's legal pages could not be read">
          {siteError}
        </Banner>
      ) : null}
      {actionData?.error ? <Alert tone="crit">{actionData.error}</Alert> : null}
      {actionData?.saved ? (
        <Banner tone="ok">
          Saved "{actionData.saved}". A page picks up the new wording when it is next saved to the
          site, and its date changes when the Owner publishes it.
        </Banner>
      ) : null}
      {actionData?.confirm ? (
        <ConfirmModal
          title={`Remove the shared section "${actionData.confirm.key}"?`}
          lead="This cannot be undone: nothing keeps an earlier copy of it."
          body={["A page that still names it is refused at publish until the marker is removed."]}
          typeToConfirm={REMOVE_WORD}
          action_label="Remove section"
          cancelHref={`/p/${encodeURIComponent(project.slug)}/legal`}
          onCancel={() => void navigate(`/p/${encodeURIComponent(project.slug)}/legal`)}
          error={
            actionData.confirm.refused
              ? "Not done. Nothing was changed. Type the word to confirm."
              : undefined
          }
          renderForm={(props) => <Form {...props} />}
        >
          <input type="hidden" name="intent" value="delete-section" />
          <input type="hidden" name="key" value={actionData.confirm.key} />
          <input type="hidden" name="confirmed" value="1" />
        </ConfirmModal>
      ) : null}
      {actionData?.deleted ? (
        <Banner tone="ok">
          Removed "{actionData.deleted}". A page that still names it is refused at publish until the
          marker is removed.
        </Banner>
      ) : null}

      <Panel title="Pages" count={pages.length} src={`${project.site}'s content`} flush>
        <Table caption={<>Legal pages on {project.site}</>} captionHidden>
          <thead>
            <tr>
              <th scope="col">Page</th>
              <th scope="col">Status</th>
              <th scope="col">Last updated</th>
              <th scope="col">Shared text</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((page) =>
              page.setUp ? (
                <tr key={page.id}>
                  <th scope="row">
                    <Link
                      className="cap-table-open"
                      to={`/p/${project.slug}/e/${encodeURIComponent(page.id)}`}
                    >
                      {page.title}
                    </Link>
                    <span className="cap-table-aside">{page.id}</span>
                  </th>
                  <td>
                    {page.status === "published" ? (
                      <Pill tone="ok">Published</Pill>
                    ) : (
                      <Pill variant="secondary">Draft</Pill>
                    )}
                    {page.draftBanner ? <Pill tone="warn">{BANNER_WORD} banner on</Pill> : null}
                  </td>
                  <td>{page.lastUpdated || "Not set"}</td>
                  <td>
                    {page.shared.length === 0 ? "None" : page.shared.join(", ")}
                    {page.behind ? <Pill tone="warn">Shared text has changed</Pill> : null}
                  </td>
                </tr>
              ) : (
                <tr key={page.id}>
                  <th scope="row">{NAMES[page.type]}</th>
                  <td colSpan={3}>Not set up on this site</td>
                </tr>
              ),
            )}
          </tbody>
        </Table>
      </Panel>

      <Panel title="Shared sections" count={sections.length} src="Carrel, used by every site">
        <p>
          Write a part once and every site's page can carry it. Put <code>{"{{site_name}}"}</code>,{" "}
          <code>{"{{operator_name}}"}</code>, <code>{"{{contact}}"}</code>,{" "}
          <code>{"{{jurisdiction}}"}</code> or <code>{"{{data_held}}"}</code> in the text and each
          page fills in its own.
        </p>
        {sections.length === 0 ? (
          <Empty kind="nothing-yet" title="No shared sections yet">
            The parts every site says alike go here.
          </Empty>
        ) : null}
        {sections.map((section) => (
          <Form
            method="post"
            key={section.key}
            className="cap-card"
            aria-label={`Shared section ${section.key}`}
          >
            <input type="hidden" name="key" value={section.key} />
            <Field label={`${section.key}: title`}>
              <input
                className="cap-input"
                name="title"
                defaultValue={section.title}
                readOnly={!canManage}
              />
            </Field>
            <Field label="Text">
              <textarea
                className="cap-input"
                name="body"
                rows={5}
                defaultValue={section.body}
                readOnly={!canManage}
              />
            </Field>
            {canManage ? (
              <div className="cap-cluster" data-gap="3">
                <Button
                  type="submit"
                  name="intent"
                  value="save-section"
                  pending={saving === section.key}
                >
                  Save section
                </Button>
                <Button type="submit" name="intent" value="delete-section" variant="danger">
                  Remove
                </Button>
              </div>
            ) : null}
          </Form>
        ))}
        {canManage ? (
          <Form method="post" className="cap-card" aria-label="Add a shared section">
            <Field label="Name" help="Lowercase words joined by hyphens, like cloudflare-hosting.">
              <input className="cap-input" name="key" />
            </Field>
            <Field label="Title">
              <input className="cap-input" name="title" />
            </Field>
            <Field label="Text">
              <textarea className="cap-input" name="body" rows={5} />
            </Field>
            <div className="cap-cluster" data-gap="3">
              <Button type="submit" name="intent" value="save-section" variant="primary">
                Add section
              </Button>
            </div>
          </Form>
        ) : (
          <p>Only the Owner changes shared text.</p>
        )}
      </Panel>
    </div>
  );
}
