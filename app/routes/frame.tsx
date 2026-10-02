// The layout every page sits in: Capsomer's shell with Carrel's name, its projects and the views the
// viewer may open. It reads who is signed in from the gate's context, so a person with no projects
// still gets Home, and only the Owner is offered the Owner's views.

import { isRouteErrorResponse, Outlet, useRouteError, useRouteLoaderData } from "react-router";
import { Empty } from "capsomer/react/empty";

import { Frame, type FrameData } from "~/components/frame";
import { getEnv, getViewer } from "~/lib/context";
import { visibleProjects } from "~/lib/people.server";

import type { Route } from "./+types/frame";

export async function loader({ context }: Route.LoaderArgs): Promise<FrameData> {
  const viewer = getViewer(context);
  const projects = await visibleProjects(getEnv(context).DB, viewer);
  return {
    name: viewer.name || viewer.email,
    isOwner: viewer.isOwner,
    projects: projects.map((p) => ({ slug: p.slug, name: p.name, kind: p.kind })),
  };
}

export default function Layout({ loaderData }: Route.ComponentProps) {
  return (
    <Frame data={loaderData}>
      <Outlet />
    </Frame>
  );
}

// A page that fails keeps the frame, so the way back is still in reach.
export function ErrorBoundary() {
  const error = useRouteError();
  const data = useRouteLoaderData<typeof loader>("routes/frame") ?? null;
  const status = isRouteErrorResponse(error) ? error.status : null;
  const title = status === 404 ? "Not found" : status === 403 ? "You may not open this" : "Something went wrong";
  const detail =
    status === 404
      ? "There is nothing at this address, or it is not shared with you."
      : status === 403
        ? "Your role on this project does not allow it."
        : "Nothing you wrote is lost. Try again, or go back to Home.";
  return (
    <Frame data={data}>
      <div className="app-page">
        <Empty kind="failed" title={status ? `${status}: ${title}` : title} action={<a className="cap-btn" href="/">Go to Home</a>}>
          {detail}
        </Empty>
      </div>
    </Frame>
  );
}
