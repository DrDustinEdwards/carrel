import { Link } from "react-router";

import { getEnv, getViewer } from "~/lib/context";
import { visibleProjects } from "~/lib/people.server";

import type { Route } from "./+types/home";

export async function loader({ context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const projects = await visibleProjects(getEnv(context).DB, viewer);
  return { name: viewer.name || viewer.email, isOwner: viewer.isOwner, projects };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { name, isOwner, projects } = loaderData;
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
                <Link to={`/p/${p.slug}`}>{p.name}</Link> <span className="muted">({p.role})</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
