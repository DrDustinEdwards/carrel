// Manuscripts (design section 5, "for finding research writing"): the Drive folder Dustin shares with
// the service account, listed from Carrel's metadata index and searched through Drive's own full-text
// search. Open goes to Google Docs; Carrel never edits a manuscript and never holds its text.

import { Form, Link, useNavigation } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Time } from "capsomer/react/time";

import { PageHead } from "~/components/page-head";

import { getEnv, getViewer } from "~/lib/context";
import { listManuscripts, manuscriptsFolder, refreshManuscripts, searchManuscripts } from "~/lib/google/drive.server";
import { GoogleNotConnected, saConnection } from "~/lib/google/service-account.server";

import type { Route } from "./+types/manuscripts";

export function meta() {
  return [{ title: "Manuscripts · Carrel" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  if (!viewer.isOwner) throw new Response("Not found", { status: 404 });
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  const sa = saConnection(env);
  const setup = sa.state !== "connected" ? sa.detail : manuscriptsFolder(env) ? null : "GOOGLE_MANUSCRIPTS_FOLDER_ID is not set to the shared folder's id.";
  let error: string | null = null;
  let files = await listManuscripts(env.DB, viewer);
  let titlesOnly = false;
  if (q && !setup) {
    try {
      const result = await searchManuscripts(env, viewer, q);
      files = result.files;
      titlesOnly = result.searched === "titles";
    } catch (e) {
      error = e instanceof GoogleNotConnected ? e.detail : `Drive did not answer the search: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { q, files, setup, error, titlesOnly };
}

export async function action({ context }: Route.ActionArgs) {
  const env = getEnv(context);
  if (!getViewer(context).isOwner) throw new Response("Not found", { status: 404 });
  try {
    return { refreshed: await refreshManuscripts(env), error: null };
  } catch (e) {
    return { refreshed: null, error: e instanceof GoogleNotConnected ? e.detail : e instanceof Error ? e.message : String(e) };
  }
}

const KIND: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "application/pdf": "PDF",
  "application/vnd.google-apps.spreadsheet": "Sheet",
};

export default function Manuscripts({ loaderData, actionData }: Route.ComponentProps) {
  const { q, files, setup, error, titlesOnly } = loaderData;
  const refreshing = useNavigation().state === "submitting";
  return (
    <div className="app-page">
      <PageHead
        title="Manuscripts"
        lead="The shared Drive folder, read-only. Open goes to Google Docs; search runs in Drive, so the text stays there."
        actions={
          !setup ? (
            <Form method="post">
              <Button type="submit" pending={refreshing}>
                {refreshing ? "Refreshing" : "Refresh from Drive"}
              </Button>
            </Form>
          ) : null
        }
      />

      {setup ? (
        <Banner tone="warn" title="Not set up yet">
          {setup}
        </Banner>
      ) : null}
      {error || actionData?.error ? (
        <Alert tone="crit">{error ?? actionData?.error}</Alert>
      ) : actionData?.refreshed ? (
        <Banner tone="ok">
          {actionData.refreshed.files} files in {actionData.refreshed.folders} folders, {actionData.refreshed.removed} gone
          {actionData.refreshed.more ? "; more folders on the next refresh" : ""}.
        </Banner>
      ) : null}
      {titlesOnly ? <Banner tone="info">Drive would not search the text with the service account's metadata-only access, so these are title matches.</Banner> : null}

      <Panel title="Manuscripts" count={files.length} src="Carrel's index of the Drive folder" flush>
        <div className="cap-panel-pad">
          <Form method="get" role="search" aria-label="Search manuscripts" className="app-filters">
            <Field label="Search the text">
              <input className="cap-input" type="search" name="q" defaultValue={q} placeholder="Words in a manuscript" />
            </Field>
            <div className="app-actions">
              <Button type="submit" variant="primary">
                Search
              </Button>
              {q ? (
                <Link to="." className="cap-btn">
                  Clear
                </Link>
              ) : null}
            </div>
          </Form>
        </div>
        {files.length === 0 ? (
          <Empty kind={q ? "no-match" : "nothing-yet"} flush title={q ? "No manuscript matches" : "No manuscripts in the index yet"} action={q ? <Link to="." className="cap-btn">Clear the search</Link> : undefined}>
            {q ? "Try other words, or fewer of them." : "Refresh from Drive to read the shared folder."}
          </Empty>
        ) : (
          <div className="cap-table-wrap" role="region" aria-labelledby="manuscripts-caption" tabIndex={0}>
            <table className="cap-table">
              <caption id="manuscripts-caption" className="cap-sr-only">
                Manuscripts
              </caption>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col" data-drop="1">People</th>
                  <th scope="col">Changed</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.fileId}>
                    <th scope="row">
                      <a className="cap-table-open" href={f.webViewLink} target="_blank" rel="noreferrer">
                        {f.name}
                        <span className="cap-sr-only"> (opens in a new tab)</span>
                      </a>
                      <span className="cap-table-aside">
                        {KIND[f.mimeType] ?? f.mimeType}
                        {f.folder ? ` · ${f.folder}` : ""}
                      </span>
                    </th>
                    <td data-drop="1">{f.people.join(", ")}</td>
                    <td>{f.modifiedTime ? <Time at={f.modifiedTime} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
