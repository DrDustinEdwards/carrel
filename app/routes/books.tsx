// Books: the books the viewer may open, each with its size and a way back in. A book's own pages (the
// manuscript, progress, bible) open from here; a new book is the Owner's.

import { Link } from "capsomer/react/link";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Pill } from "capsomer/react/status";
import { drizzle } from "drizzle-orm/d1";
import { count, inArray, sql } from "drizzle-orm";

import { bookFiles } from "~/db/schema";
import { getEnv, getViewer } from "~/lib/context";
import { visibleProjects } from "~/lib/people.server";
import { ROLE_LABEL } from "~/lib/roles";

import type { Route } from "./+types/books";

export function meta() {
  return [{ title: "Books · Carrel" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const books = (await visibleProjects(env.DB, viewer)).filter((p) => p.kind === "book");
  const sizes =
    books.length === 0
      ? []
      : await drizzle(env.DB)
          .select({
            projectId: bookFiles.projectId,
            files: count(),
            words: sql<number>`coalesce(sum(${bookFiles.words}), 0)`,
          })
          .from(bookFiles)
          .where(
            inArray(
              bookFiles.projectId,
              books.map((b) => b.id),
            ),
          )
          .groupBy(bookFiles.projectId)
          .all();
  const size = new Map(sizes.map((s) => [s.projectId, s]));
  return {
    isOwner: viewer.isOwner,
    books: books.map((b) => ({
      slug: b.slug,
      name: b.name,
      role: ROLE_LABEL[b.role],
      files: size.get(b.id)?.files ?? 0,
      words: size.get(b.id)?.words ?? 0,
    })),
  };
}

export default function Books({ loaderData }: Route.ComponentProps) {
  const { books, isOwner } = loaderData;
  return (
    <div className="app-page">
      <PageHead
        title="Books"
        lead="Manuscripts kept in the writing repository."
        actions={
          isOwner ? (
            <Link to="/books/new" className="cap-btn" data-variant="primary">
              New book
            </Link>
          ) : null
        }
      />
      {books.length === 0 ? (
        <Empty kind="nothing-yet" title="No books yet">
          A book appears here once it is made or shared with you.
        </Empty>
      ) : (
        <div className="cap-table-wrap" role="region" aria-label="Books" tabIndex={0}>
          <table className="cap-table">
            <thead>
              <tr>
                <th scope="col">Book</th>
                <th scope="col" data-drop="1">
                  Your role
                </th>
                <th scope="col" data-num>
                  Words
                </th>
                <th scope="col" data-drop="2" data-num>
                  Files
                </th>
                <th scope="col">
                  <span className="cap-sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {books.map((b) => (
                <tr key={b.slug}>
                  <th scope="row">
                    <Link className="cap-table-open" to={`/b/${b.slug}`}>
                      {b.name}
                    </Link>
                  </th>
                  <td data-drop="1">
                    <Pill variant="outline">{b.role}</Pill>
                  </td>
                  <td data-num>{b.words.toLocaleString("en-US")}</td>
                  <td data-drop="2" data-num>
                    {b.files}
                  </td>
                  <td>
                    <Link to={`/b/${b.slug}`} className="cap-btn">
                      Continue
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
