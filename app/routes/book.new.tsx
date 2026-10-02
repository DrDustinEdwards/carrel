// A new book is a project whose folder in the novels repository is named here. Nothing is written to
// Git until the first file is saved; the folder appears then.

import { Form, redirect, useNavigation } from "react-router";
import { Button } from "capsomer/react/button";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";

import { PageHead } from "~/components/page-head";

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
  const busy = useNavigation().state !== "idle";
  return (
    <div className="app-page" data-narrow>
      <PageHead crumbs={[{ label: "Home", href: "/" }, { label: "New book" }]} title="New book" lead="A book is a folder in the novels repository. Nothing is written to Git until its first file is saved." />
      <Panel title="The book">
        <Form method="post" className="app-form">
          <Field label="Name" required>
            <input className="cap-input" name="name" required maxLength={120} autoComplete="off" />
          </Field>
          <Field
            label="Folder in the novels repository"
            required
            help="Lower-case letters, digits and single hyphens, such as paluxy-portal. An existing folder is picked up at the first refresh."
            error={actionData?.error}
            announce
          >
            <input className="cap-input" name="folder" required pattern="[a-z0-9]+(-[a-z0-9]+)*" autoComplete="off" spellCheck={false} data-error-pattern-mismatch="Use lower-case letters, digits and single hyphens, such as paluxy-portal." />
          </Field>
          <div className="app-actions">
            <Button type="submit" variant="primary" pending={busy}>
              Create the book
            </Button>
          </div>
        </Form>
      </Panel>
    </div>
  );
}
