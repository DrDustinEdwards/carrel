// A book's Progress tab: today's writing against the person's own goal, the streak, the pace the
// deadline asks for and the last seven days (Capsomer's writing progress). The goal is each
// person's own; the project target and deadline are keys on the title page (book.md).

import { Link } from "capsomer/react/link";
import { WritingProgress } from "capsomer/react/writing-progress";

import { BookHead } from "~/components/book-head";
import { RouterForm } from "~/components/router-form";

import { bookHead, listFiles, requireBookProject } from "~/lib/books.server";
import { getEnv, getViewer, getZone } from "~/lib/context";
import { can } from "~/lib/roles";
import { progressEntries, readGoal, saveGoal } from "~/lib/writing.server";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/book.progress";

export function meta({ loaderData: data }: Route.MetaArgs) {
  return [{ title: data ? `Progress · ${data.head.name} · Carrel` : "Carrel" }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireBookProject(env.DB, viewer, params.project, "read");
  const [files, goal, entries, head] = await Promise.all([
    listFiles(env.DB, project),
    readGoal(env.DB, project, viewer),
    progressEntries(env.DB, project, viewer),
    bookHead(env, project),
  ]);
  const bookMeta = files.find((f) => f.path === "book.md")?.meta;
  const bookEntry = bookMeta?.kind === "book" ? bookMeta.entry : null;
  return {
    head,
    canEdit: can(project.role, "edit"),
    wordsNow: files.filter((f) => f.kind === "scene").reduce((n, f) => n + f.words, 0),
    progress: {
      entries,
      goal,
      projectTarget: bookEntry?.target ?? null,
      deadline: bookEntry?.deadline ?? "",
      zone: getZone(context),
    },
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const project = await requireBookProject(env.DB, viewer, params.project, "read");
  const form = await readForm(request);
  if (String(form.get("intent") ?? "") !== "goal")
    throw new Response("Bad request", { status: 400 });
  const saved = await saveGoal(env.DB, project, viewer, {
    mode: String(form.get("mode") ?? ""),
    dailyTarget: String(form.get("dailyTarget") ?? ""),
    writingDays: form.getAll("writingDays").map(String),
    allowNegative: form.get("allowNegative") === "1",
  });
  return { goal: saved.ok ? { saved: true, error: null } : { saved: false, error: saved.error } };
}

/** Where the project target and deadline are set: the title page's header. */
function TitlePageNote({ to }: { to: string }) {
  return (
    <>
      The deadline and the project target are target: and deadline: in the{" "}
      <Link to={to}>title page</Link>.
    </>
  );
}

export default function BookProgress({ loaderData, actionData }: Route.ComponentProps) {
  const { head, canEdit, wordsNow, progress } = loaderData;
  return (
    <div className="app-page">
      <BookHead book={head} section="progress" />
      <div className="app-narrow">
        <WritingProgress
          {...progress}
          wordsNow={wordsNow}
          canEdit={canEdit}
          Form={RouterForm}
          goalNote={<TitlePageNote to={`/b/${head.slug}/f/book.md`} />}
          source="Typed words in Carrel's authorship record"
          error={actionData?.goal.error ?? null}
          saved={actionData?.goal.saved ?? false}
        />
      </div>
    </div>
  );
}
