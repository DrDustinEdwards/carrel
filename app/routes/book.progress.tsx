// A book's Progress tab: today's writing against the person's own goal, the streak, the pace the
// deadline asks for and the last seven days (Capsomer's WritingProgress). The goal is each
// person's own; the project target and deadline are keys on the title page (book.md).

import { BookHead } from "~/components/book-head";
// Names the writing-progress types in the loader's inferred type, so its declaration can refer to them (TS2742).
import type {} from "capsomer/behavior/writing-progress";
import { Form } from "react-router";
import { Link } from "capsomer/react/link";
import { WritingProgress } from "capsomer/react/writing-progress";

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

export default function BookProgress({ loaderData, actionData }: Route.ComponentProps) {
  const { head, canEdit, wordsNow, progress } = loaderData;
  return (
    <div className="cap-admin-page">
      <BookHead book={head} section="progress" />
      <div className="app-narrow">
        <WritingProgress
          {...progress}
          wordsNow={wordsNow}
          canEdit={canEdit}
          Form={Form}
          goalNote={
            <>
              The deadline and the project target are target: and deadline: in the{" "}
              <Link to={`/b/${head.slug}/f/book.md`}>title page</Link>.
            </>
          }
          error={actionData?.goal.error ?? null}
          saved={actionData?.goal.saved ?? false}
        />
      </div>
    </div>
  );
}
