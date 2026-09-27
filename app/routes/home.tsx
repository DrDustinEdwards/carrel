import { Link } from "react-router";

import { getEnv, getViewer } from "~/lib/context";
import { isConnected, oauthConnection } from "~/lib/google/oauth.server";
import { visibleProjects } from "~/lib/people.server";

import type { Route } from "./+types/home";

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const projects = await visibleProjects(env.DB, viewer);
  // Google is the Owner's: the manuscripts and his drive.file grant.
  const google = viewer.isOwner
    ? { configured: (await oauthConnection(env)).state === "configured", connected: await isConnected(env.DB, viewer) }
    : null;
  return { name: viewer.name || viewer.email, isOwner: viewer.isOwner, projects, google, googleMessage: new URL(request.url).searchParams.get("google") };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { name, isOwner, projects, google, googleMessage } = loaderData;
  return (
    <main className="shell">
      <header className="shell-header">
        <h1>Carrel</h1>
        <p className="muted">
          {name}
          {isOwner ? ", Owner" : ""}
        </p>
      </header>
      <section aria-labelledby="projects-heading">
        <h2 id="projects-heading">Projects</h2>
        {projects.length === 0 ? (
          <p className="muted">No projects yet.</p>
        ) : (
          <ul className="project-list">
            {projects.map((p) => (
              <li key={p.id}>
                {p.kind ? <Link to={`/${p.kind === "book" ? "b" : "p"}/${p.slug}`}>{p.name}</Link> : p.name}{" "}
                <span className="muted">
                  ({p.kind === "book" ? "book, " : p.kind === "site" ? "site, " : ""}
                  {p.role})
                </span>
              </li>
            ))}
          </ul>
        )}
        {isOwner ? (
          <p>
            <Link to="/books/new" className="btn-ghost">
              New book
            </Link>
          </p>
        ) : null}
      </section>
      {isOwner ? (
        <section aria-labelledby="google-heading">
          <h2 id="google-heading">Google</h2>
          {googleMessage ? (
            <p className="notice" role="status">
              {googleMessage}
            </p>
          ) : null}
          <p>
            <Link to="/manuscripts">Manuscripts</Link> <span className="muted">(the shared Drive folder, read-only)</span>
          </p>
          {google?.configured ? (
            <p>
              {google.connected ? "Send to Docs is connected (drive.file only). " : null}
              <a href="/auth/google/start" className="btn-ghost">
                {google.connected ? "Connect again" : "Connect Google for Send to Docs"}
              </a>
            </p>
          ) : (
            <p className="muted">Send to Docs is not set up yet.</p>
          )}
        </section>
      ) : null}
    </main>
  );
}
