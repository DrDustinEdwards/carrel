// A new book is a project whose folder in the novels repository is named here. Nothing is written to
// Git until the first file is saved; the folder appears then.

import { Form, Link, redirect } from "react-router";

import { createBook } from "~/lib/books.server";
import { getEnv, getViewer } from "~/lib/context";

import type { Route } from "./+types/book.new";

export function meta() {
  return [{ title: "New book · Carrel" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  if (!getViewer(context).isOwner) throw new Response("Not found", { status: 404 });
  return null;
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const result = await createBook(getEnv(context).DB, getViewer(context), {
    name: String(form.get("name") ?? ""),
    folder: String(form.get("folder") ?? "").trim(),
  });
  return result.ok ? redirect(`/b/${result.slug}`) : { error: result.error };
}

export default function NewBook({ actionData }: Route.ComponentProps) {
  return (
    <main className="shell">
      <header className="shell-header">
        <p className="crumbs">
          <Link to="/">Carrel</Link>
        </p>
        <h1>New book</h1>
      </header>
      <Form method="post" className="stack">
        <label className="field">
          <span>Name</span>
          <input name="name" required maxLength={120} autoComplete="off" />
        </label>
        <label className="field">
          <span>Folder in the novels repository</span>
          <input name="folder" required pattern="[a-z0-9]+(-[a-z0-9]+)*" autoComplete="off" aria-describedby="folder-help" />
        </label>
        <p id="folder-help" className="muted">
          Lower-case letters, digits and single hyphens, such as paluxy-portal. An existing folder is picked up at the first refresh.
        </p>
        {actionData?.error ? (
          <p className="alarm" role="alert">
            {actionData.error}
          </p>
        ) : null}
        <button type="submit" className="btn">
          Create the book
        </button>
      </Form>
    </main>
  );
}
