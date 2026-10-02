import type { ReactNode } from "react";
import { Link } from "react-router";
import { Banner } from "capsomer/react/banner";
import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { Pill, Status } from "capsomer/react/status";

import { PageHead } from "~/components/page-head";

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

const KIND = { site: "Site", book: "Book" } as const;
const ROLE = { owner: "Owner", editor: "Editor", reader: "Reader" } as const;

const SiteGlyph = (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2 8h12M8 2c2 1.8 2 10.2 0 12M8 2c-2 1.8-2 10.2 0 12" />
  </svg>
);
const BookGlyph = (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" d="M2.5 3.5c2-.8 4-.6 5.5.6 1.5-1.2 3.5-1.4 5.5-.6v9c-2-.8-4-.6-5.5.6-1.5-1.2-3.5-1.4-5.5-.6zM8 4.1v9" />
  </svg>
);

export default function Home({ loaderData }: Route.ComponentProps) {
  const { isOwner, projects, google, googleMessage } = loaderData;
  const link = ({ href, children }: { href: string; children: ReactNode }) => <Link to={href}>{children}</Link>;
  return (
    <div className="app-page">
      <PageHead
        title="Carrel"
        lead="Your sites and your books, in one place."
        actions={
          isOwner ? (
            <Link to="/books/new" className="cap-btn" data-variant="primary">
              New book
            </Link>
          ) : null
        }
      />

      {googleMessage ? <Banner tone="info">{googleMessage}</Banner> : null}

      <div className="app-split" data-aside={isOwner ? "" : undefined}>
        <Panel title="Projects" count={projects.length} flush>
          {projects.length === 0 ? (
            <Empty kind="nothing-yet" flush title="No projects yet">
              A project appears here once it is shared with you.
            </Empty>
          ) : (
            <RowList label="Projects">
              {projects.map((p) => (
                <Row
                  key={p.id}
                  title={p.name}
                  href={p.kind ? `/${p.kind === "book" ? "b" : "p"}/${p.slug}` : undefined}
                  renderLink={link}
                  media={p.kind === "book" ? BookGlyph : SiteGlyph}
                  mediaVariant="icon"
                  detail={p.kind ? KIND[p.kind] : "Not set up for writing yet"}
                  meta={<Pill variant="outline">{ROLE[p.role]}</Pill>}
                />
              ))}
            </RowList>
          )}
        </Panel>

        {isOwner ? (
          <Panel title="Owner tools" flush>
            <RowList label="Owner tools">
              <Row title="Manuscripts" href="/manuscripts" renderLink={link} detail="The shared Drive folder, read-only." />
              <Row title="Social" href="/social" renderLink={link} detail="Posts announcing what went live." />
              {google?.configured ? (
                <Row
                  title="Send to Docs"
                  status={google.connected ? <Status tone="ok">Connected</Status> : <Status tone="nodata">Not connected</Status>}
                  detail={google.connected ? "Connected with drive.file only." : "Connect Google to send a post to Docs."}
                  actions={
                    <a href="/auth/google/start" className="cap-btn">
                      {google.connected ? "Connect again" : "Connect Google"}
                    </a>
                  }
                />
              ) : (
                <Row title="Send to Docs" status={<Status tone="nodata">Not set up</Status>} detail="Send to Docs is not set up yet." />
              )}
            </RowList>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
