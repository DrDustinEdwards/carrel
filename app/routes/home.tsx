// Home: the work queue. What waits on the person (Blocking first, then Waiting for you), each with one
// main action; then where to continue writing and what was typed today. No lists of projects or tools,
// because the menu already has them. The needs that D1 knows are in the page; the mention counts are asked
// of each site and arrive after, so a slow site never holds Home.

import { Suspense } from "react";
import { Await } from "react-router";
import { Link } from "capsomer/react/link";
import { Banner } from "capsomer/react/banner";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { Pill } from "capsomer/react/status";
import { TabsNav } from "capsomer/react/tabs";
import { Time } from "capsomer/react/time";

import { getEnv, getViewer } from "~/lib/context";
import {
  continueWriting,
  mentionNeeds,
  needsYou,
  typedToday,
  type Need,
  type NeedGroup,
} from "~/lib/desk.server";
import { visibleProjects } from "~/lib/people.server";

import type { Route } from "./+types/home";

export function meta() {
  return [{ title: "Home · Carrel" }];
}

const FILTERS: { id: "all" | NeedGroup; label: string }[] = [
  { id: "all", label: "All" },
  { id: "ai", label: "AI drafts" },
  { id: "due", label: "Due now" },
  { id: "flags", label: "Flags" },
  { id: "mentions", label: "Mentions" },
  { id: "approvals", label: "Approvals" },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const url = new URL(request.url);
  const visible = await visibleProjects(env.DB, viewer);
  const [needs, resume, typed] = await Promise.all([
    needsYou(env.DB, viewer, visible),
    continueWriting(env.DB, viewer, visible),
    typedToday(env.DB, viewer, visible),
  ]);
  const show = FILTERS.find((f) => f.id === url.searchParams.get("show"))?.id ?? "all";
  return {
    name: viewer.name || viewer.email,
    isOwner: viewer.isOwner,
    hasProjects: visible.length > 0,
    show,
    needs,
    // Streamed: shown when the sites have answered.
    mentions: mentionNeeds(env, viewer, visible).catch(() => [] as Need[]),
    resume,
    typed,
    googleMessage: url.searchParams.get("google"),
  };
}

const URGENCY = {
  blocking: { title: "Blocking", tone: "crit" as const },
  waiting: { title: "Waiting for you", tone: "info" as const },
};

function NeedRow({ need }: { need: Need }) {
  const link = ({ href, children }: { href: string; children: React.ReactNode }) => (
    <Link to={href}>{children}</Link>
  );
  return (
    <Row
      title={need.title}
      detail={need.detail}
      meta={need.at ? <Time at={need.at} /> : undefined}
      renderLink={link}
      actions={
        <Link to={need.action.href} className="cap-btn" data-variant="primary">
          {need.action.label}
        </Link>
      }
    />
  );
}

function Needs({ needs, show }: { needs: Need[]; show: string }) {
  const rows = needs.filter((n) => show === "all" || n.group === show);
  if (rows.length === 0)
    return (
      <Empty kind="all-clear" flush title="Nothing needs you">
        {show === "all" ? "Everything waiting on you is done." : "Nothing here. Try All."}
      </Empty>
    );
  return (
    <>
      {(["blocking", "waiting"] as const).map((u) => {
        const group = rows.filter((n) => n.urgency === u);
        if (group.length === 0) return null;
        return (
          <section key={u} aria-label={URGENCY[u].title}>
            <h3 className="app-need-head">
              <Pill tone={URGENCY[u].tone === "crit" ? "crit" : undefined} variant="secondary">
                {URGENCY[u].title}
              </Pill>
              <span className="app-need-count">{group.length}</span>
            </h3>
            <RowList label={URGENCY[u].title}>
              {group.map((n) => (
                <NeedRow key={n.id} need={n} />
              ))}
            </RowList>
          </section>
        );
      })}
    </>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { isOwner, hasProjects, show, needs, mentions, resume, typed, googleMessage } = loaderData;
  const link = ({ href, children }: { href: string; children: React.ReactNode }) => (
    <Link to={href}>{children}</Link>
  );
  return (
    <div className="app-page">
      <PageHead
        title="Home"
        lead="What waits on you, and where you left off."
        actions={
          hasProjects ? (
            <>
              <Link to="/writing" className="cap-btn">
                Writing
              </Link>
              {isOwner ? (
                <Link to="/books/new" className="cap-btn" data-variant="primary">
                  New book
                </Link>
              ) : null}
            </>
          ) : null
        }
      />
      {googleMessage ? <Banner tone="info">{googleMessage}</Banner> : null}

      {!hasProjects ? (
        <Empty kind="nothing-yet" title="No projects yet">
          A project appears here once it is shared with you.
        </Empty>
      ) : (
        <>
          <Panel title="Needs you">
            <TabsNav aria-label="Filter what needs you" variant="line">
              {FILTERS.filter((f) => f.id !== "approvals" || isOwner).map((f) => (
                <Link
                  key={f.id}
                  to={f.id === "all" ? "/" : `/?show=${f.id}`}
                  className="cap-tab"
                  aria-current={f.id === show ? "page" : undefined}
                >
                  {f.label}
                </Link>
              ))}
            </TabsNav>
            {/* The D1 needs show at once; the mentions join them when the sites answer. */}
            <Suspense fallback={<Needs needs={needs} show={show} />}>
              <Await resolve={mentions}>
                {(m) => <Needs needs={[...needs, ...m]} show={show} />}
              </Await>
            </Suspense>
          </Panel>

          <div className="app-split" data-even>
            <Panel title="Continue writing" flush>
              {resume.length === 0 ? (
                <Empty kind="nothing-yet" flush title="No drafts in progress">
                  Start from Writing or Books.
                </Empty>
              ) : (
                <RowList label="Continue writing">
                  {resume.map((r) => (
                    <Row
                      key={r.href}
                      title={r.title}
                      href={r.href}
                      renderLink={link}
                      detail={r.projectName}
                      meta={<Time at={r.at} />}
                    />
                  ))}
                </RowList>
              )}
            </Panel>
            <Panel title="Typed in the last day" flush>
              {typed.length === 0 ? (
                <Empty kind="nothing-yet" flush title="Nothing typed yet">
                  Words you type in the editor count here.
                </Empty>
              ) : (
                <RowList label="Typed in the last day">
                  {typed.map((t) => (
                    <Row
                      key={t.href}
                      title={t.name}
                      href={t.href}
                      renderLink={link}
                      meta={`${t.words.toLocaleString("en-US")} words`}
                    />
                  ))}
                </RowList>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
