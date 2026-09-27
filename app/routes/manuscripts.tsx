// Manuscripts (design section 5, "for finding research writing"): the Drive folder Dustin shares with
// the service account, listed from Carrel's metadata index and searched through Drive's own full-text
// search. Open goes to Google Docs; Carrel never edits a manuscript and never holds its text.

import { Form, Link, useNavigation } from "react-router";

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
  if (q && !setup) {
    try {
      files = await searchManuscripts(env, viewer, q);
    } catch (e) {
      error = e instanceof GoogleNotConnected ? e.detail : `Drive did not answer the search: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { q, files, setup, error };
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
  const { q, files, setup, error } = loaderData;
  const refreshing = useNavigation().state === "submitting";
  return (
    <main className="shell shell-wide">
      <header className="shell-header">
        <p className="crumbs">
          <Link to="/">Carrel</Link>
        </p>
        <h1>Manuscripts</h1>
        <p className="muted">The shared Drive folder, read-only. Open goes to Google Docs; search runs in Drive, so the text stays there.</p>
      </header>
      {setup ? (
        <p className="notice" role="status">
          Not set up yet: {setup}
        </p>
      ) : null}
      <div className="toolbar-row">
        <Form method="get" role="search" aria-label="Search manuscripts" className="filters">
          <label className="field">
            <span>Search the text</span>
            <input type="search" name="q" defaultValue={q} placeholder="Words in a manuscript" />
          </label>
          <button type="submit" className="btn">
            Search
          </button>
          {q ? (
            <Link to="." className="btn-ghost">
              Clear
            </Link>
          ) : null}
        </Form>
        {!setup ? (
          <Form method="post">
            <button type="submit" className="btn-ghost" disabled={refreshing}>
              {refreshing ? "Refreshing" : "Refresh from Drive"}
            </button>
          </Form>
        ) : null}
      </div>
      {error || actionData?.error ? (
        <p className="alarm" role="alert">
          {error ?? actionData?.error}
        </p>
      ) : actionData?.refreshed ? (
        <p className="muted" role="status">
          {actionData.refreshed.files} files in {actionData.refreshed.folders} folders, {actionData.refreshed.removed} gone
          {actionData.refreshed.more ? "; more folders on the next refresh" : ""}.
        </p>
      ) : null}
      {files.length === 0 ? (
        <p className="muted">{q ? "No manuscript matches." : "No manuscripts in the index yet."}</p>
      ) : (
        <table className="items">
          <caption className="sr-only">Manuscripts</caption>
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">People</th>
              <th scope="col">Changed</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.fileId}>
                <td>
                  <a href={f.webViewLink} target="_blank" rel="noreferrer">
                    {f.name}
                  </a>
                  <span className="muted item-id">
                    {KIND[f.mimeType] ?? f.mimeType}
                    {f.folder ? ` · ${f.folder}` : ""}
                  </span>
                </td>
                <td>{f.people.join(", ")}</td>
                <td className="muted">{f.modifiedTime?.slice(0, 10) ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
