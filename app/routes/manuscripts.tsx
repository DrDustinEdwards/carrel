// Manuscripts (design section 5, "for finding research writing"): the Drive folder Dustin shares with
// the service account, listed from Carrel's metadata index and searched through Drive's own full-text
// search. Open goes to Google Docs; Carrel never edits a manuscript and never holds its text.

import { Form, useNavigation } from "react-router";
import { Table } from "capsomer/react/table";
import { ButtonLink } from "capsomer/react/link";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { Status } from "capsomer/react/status";
import { Time } from "capsomer/react/time";
import { PageHead } from "capsomer/react/page-head";

import { getEnv, getViewer } from "~/lib/context";
import {
  listManuscripts,
  manuscriptsFolder,
  refreshManuscripts,
  searchManuscripts,
} from "~/lib/google/drive.server";
import { isConnected, oauthConnection } from "~/lib/google/oauth.server";
import { GoogleNotConnected, saConnection } from "~/lib/google/service-account.server";

import type { Route } from "./+types/manuscripts";

import { errorMessage } from "@dustinedwards/site-runtime/log";
export function meta() {
  return [{ title: "Manuscripts · Carrel" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  if (!viewer.isOwner) throw new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const sa = saConnection(env);
  const setup =
    sa.state !== "connected"
      ? sa.detail
      : manuscriptsFolder(env)
        ? null
        : "GOOGLE_MANUSCRIPTS_FOLDER_ID is not set to the shared folder's id.";
  let error: string | null = null;
  let files = await listManuscripts(env.DB, viewer);
  let titlesOnly = false;
  if (q && !setup) {
    try {
      const result = await searchManuscripts(env, viewer, q);
      files = result.files;
      titlesOnly = result.searched === "titles";
    } catch (e) {
      error =
        e instanceof GoogleNotConnected
          ? e.detail
          : `Drive did not answer the search: ${errorMessage(e)}`;
    }
  }
  // Google is the Owner's: the manuscripts and his drive.file grant (Send to Docs and Import).
  const google = {
    configured: (await oauthConnection(env)).state === "configured",
    connected: await isConnected(env.DB, viewer),
  };
  return { q, files, setup, error, titlesOnly, google, message: url.searchParams.get("google") };
}

export async function action({ context }: Route.ActionArgs) {
  const env = getEnv(context);
  if (!getViewer(context).isOwner) throw new Response("Not found", { status: 404 });
  try {
    return { refreshed: await refreshManuscripts(env), error: null };
  } catch (e) {
    return {
      refreshed: null,
      error: e instanceof GoogleNotConnected ? e.detail : errorMessage(e),
    };
  }
}

const KIND: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "application/pdf": "PDF",
  "application/vnd.google-apps.spreadsheet": "Sheet",
};

export default function Manuscripts({ loaderData, actionData }: Route.ComponentProps) {
  const { q, files, setup, error, titlesOnly, google, message } = loaderData;
  const refreshing = useNavigation().state === "submitting";
  return (
    <div className="app-page">
      <PageHead
        title="Manuscripts"
        lead="The shared Drive folder, read-only. Open goes to Google Docs; search runs in Drive, so the text stays there."
        actions={
          <>
            <Link to="/manuscripts/activity" className="cap-btn">
              Docs activity
            </Link>
            {!setup ? (
              <Form method="post">
                <Button type="submit" pending={refreshing}>
                  {refreshing ? "Refreshing" : "Refresh from Drive"}
                </Button>
              </Form>
            ) : null}
          </>
        }
      />

      {message ? <Banner tone="info">{message}</Banner> : null}
      <Panel title="Google" flush>
        <RowList label="Google">
          <Row
            title="Send to Docs and Import"
            meta={
              !google.configured ? (
                <Status tone="nodata">Not set up</Status>
              ) : google.connected ? (
                <Status tone="ok">Connected</Status>
              ) : (
                <Status tone="nodata">Not connected</Status>
              )
            }
            detail={
              !google.configured
                ? "Send to Docs is not set up yet."
                : google.connected
                  ? "Connected with drive.file only."
                  : "Connect Google to send a post to Docs."
            }
            actions={
              google.configured ? (
                <ButtonLink href="/auth/google/start">
                  {google.connected ? "Connect again" : "Connect Google"}
                </ButtonLink>
              ) : undefined
            }
          />
        </RowList>
      </Panel>
      {setup ? (
        <Banner tone="warn" title="Not set up yet">
          {setup}
        </Banner>
      ) : null}
      {error || actionData?.error ? (
        <Alert tone="crit">{error ?? actionData?.error}</Alert>
      ) : actionData?.refreshed ? (
        <Banner tone="ok">
          {actionData.refreshed.files} files in {actionData.refreshed.folders} folders,{" "}
          {actionData.refreshed.removed} gone
          {actionData.refreshed.more ? "; more folders on the next refresh" : ""}.
        </Banner>
      ) : null}
      {titlesOnly ? (
        <Banner tone="info">
          Drive would not search the text with the service account's metadata-only access, so these
          are title matches.
        </Banner>
      ) : null}

      <Panel
        title="Manuscripts"
        count={files.length}
        src="Carrel's index of the Drive folder"
        flush
      >
        <div className="cap-panel-pad">
          <Form method="get" role="search" aria-label="Search manuscripts" className="app-filters">
            <Field label="Search the text">
              <input
                className="cap-input"
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Words in a manuscript"
              />
            </Field>
            <div className="cap-cluster" data-gap="3">
              <Button type="submit" variant="primary">
                Search
              </Button>
              {q ? <ButtonLink to=".">Clear</ButtonLink> : null}
            </div>
          </Form>
        </div>
        {files.length === 0 ? (
          <Empty
            kind={q ? "no-match" : "nothing-yet"}
            flush
            title={q ? "No manuscript matches" : "No manuscripts in the index yet"}
            action={q ? <ButtonLink to=".">Clear the search</ButtonLink> : undefined}
          >
            {q
              ? "Try other words, or fewer of them."
              : "Refresh from Drive to read the shared folder."}
          </Empty>
        ) : (
          <Table caption="Manuscripts" captionHidden>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col" data-drop="1">
                  People
                </th>
                <th scope="col">Changed</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.fileId}>
                  <th scope="row">
                    <a
                      className="cap-table-open"
                      href={f.webViewLink}
                      target="_blank"
                      rel="noreferrer"
                    >
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
          </Table>
        )}
      </Panel>
    </div>
  );
}
