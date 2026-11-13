// Manuscripts (design section 5, "for finding research writing"): the Drive folder Dustin shares with
// the service account, listed from Carrel's metadata index and searched through Drive's own full-text
// search. Open goes to Google Docs; Carrel never holds a manuscript's text. AIs change a Doc only through the Docs
// tools (docs.server.ts), and here Dustin sets each Doc's lock against them and how he hears of a direct write.

import { useState } from "react";
import { Form, useFetcher, useNavigation } from "react-router";
import { Table } from "capsomer/react/table";
import { ButtonLink } from "capsomer/react/link";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { Segmented, type SegmentedOption } from "capsomer/react/segmented";
import { Status } from "capsomer/react/status";
import { Time } from "capsomer/react/time";
import { PageHead } from "capsomer/react/page-head";

import { getEnv, getViewer } from "~/lib/context";
import { readForm } from "~/lib/form.server";
import {
  readDocLocks,
  readDocsEmail,
  saveDocsEmail,
  setDocLock,
  type DocsEmail,
} from "~/lib/google/docs.server";
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
  const [locks, docsEmail] = await Promise.all([
    readDocLocks(env.DB, viewer),
    readDocsEmail(env.DB),
  ]);
  return {
    q,
    files,
    setup,
    error,
    titlesOnly,
    google,
    locks,
    docsEmail,
    message: url.searchParams.get("google"),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  if (!viewer.isOwner) throw new Response("Not found", { status: 404 });
  const form = await readForm(request);
  const intent = String(form.get("intent") ?? "refresh");
  if (intent === "lock") {
    await setDocLock(
      env.DB,
      viewer,
      String(form.get("file") ?? ""),
      String(form.get("lock") ?? ""),
    );
    return { refreshed: null, error: null, saved: "Lock saved." };
  }
  if (intent === "docs-email") {
    await saveDocsEmail(env.DB, viewer, String(form.get("docs-email") ?? ""));
    return { refreshed: null, error: null, saved: "Email setting saved." };
  }
  try {
    return { refreshed: await refreshManuscripts(env), error: null };
  } catch (e) {
    return {
      refreshed: null,
      error: e instanceof GoogleNotConnected ? e.detail : errorMessage(e),
    };
  }
}

const LOCKS: SegmentedOption<string>[] = [
  { value: "open", label: "Open" },
  { value: "suggest-only", label: "Suggest only" },
  { value: "no-ai", label: "No AI", tone: "warn" },
];

const EMAIL: SegmentedOption<DocsEmail>[] = [
  { value: "each", label: "Each write" },
  { value: "daily", label: "Daily summary" },
  { value: "off", label: "Off" },
];

/** One setting as a row of choices that saves on change (and with Save when script is off). */
function ChoiceForm<V extends string>(props: {
  intent: string;
  name: string;
  legend: string;
  options: SegmentedOption<V>[];
  saved: V;
  hidden?: Record<string, string>;
}) {
  const fetcher = useFetcher();
  const [value, setValue] = useState<V>(props.saved);
  return (
    <fetcher.Form method="post" className="cap-cluster" data-gap="2">
      <input type="hidden" name="intent" value={props.intent} />
      {Object.entries(props.hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Segmented
        legend={props.legend}
        hideLegend
        size="sm"
        name={props.name}
        options={props.options}
        value={value}
        onChange={(next) => {
          setValue(next);
          void fetcher.submit(
            { intent: props.intent, ...props.hidden, [props.name]: next },
            { method: "post" },
          );
        }}
      />
      <noscript>
        <Button type="submit" size="sm">
          Save
        </Button>
      </noscript>
    </fetcher.Form>
  );
}

const KIND: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "application/pdf": "PDF",
  "application/vnd.google-apps.spreadsheet": "Sheet",
};

export default function Manuscripts({ loaderData, actionData }: Route.ComponentProps) {
  const { q, files, setup, error, titlesOnly, google, locks, docsEmail, message } = loaderData;
  const navigation = useNavigation();
  const refreshing =
    navigation.state === "submitting" && navigation.formData?.get("intent") === null;
  return (
    <div className="app-page">
      <PageHead
        title="Manuscripts"
        lead="The shared Drive folder. Open goes to Google Docs; search runs in Drive, so the text stays there. An AI changes a Doc only through Carrel, under the lock you set here."
        actions={
          <>
            <ButtonLink to="/manuscripts/activity">Docs activity</ButtonLink>
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
          <Row
            title="Direct writes by AI"
            detail="Suggestions send no email. A direct write is one an AI makes in a Doc only when you ask it to."
            actions={
              <ChoiceForm
                intent="docs-email"
                name="docs-email"
                legend="Email on a direct write"
                options={EMAIL}
                saved={docsEmail}
              />
            }
          />
        </RowList>
      </Panel>
      {actionData && "saved" in actionData && actionData.saved ? (
        <Banner tone="ok">{actionData.saved}</Banner>
      ) : null}
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
                <th scope="col">AI</th>
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
                  <td>
                    {f.mimeType === "application/vnd.google-apps.document" ? (
                      <ChoiceForm
                        intent="lock"
                        name="lock"
                        legend={`AI lock for ${f.name}`}
                        options={LOCKS}
                        saved={locks[f.fileId] ?? "open"}
                        hidden={{ file: f.fileId }}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
