// Home: the work queue. What waits on the person (Blocking first, then Waiting for you), each with one
// main action and Later; then where to continue writing and what was typed today. No lists of projects or
// tools, because the menu already has them. The needs that D1 knows are in the page; the mention counts are
// asked of each site and arrive after, so a slow site never holds Home.
//
// The queue is Capsomer's NeedsList (attention-list): Later sets a row aside until 8 am tomorrow in the
// person's time zone (capsomer/behavior/time laterUntil), or sooner when the need changes (desk.server.ts
// setLater); the row leaves at once, focus moves to the next row, and the message offers Undo; the Later tab
// lists what is set aside, with Bring back. j, k and l are the list's own keys.

import { Suspense, useSyncExternalStore } from "react";
import { Await, useSubmit } from "react-router";
import { NeedsList, type NeedLinkProps } from "capsomer/react/attention-list";
import { laterUntil } from "capsomer/behavior/time";
import { useRouterRowForm } from "capsomer/react/router";
import { Link, ButtonLink } from "capsomer/react/link";
import { Banner } from "capsomer/react/banner";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { TabsNav } from "capsomer/react/tabs";
import { Time } from "capsomer/react/time";

import { getEnv, getViewer, getZone } from "~/lib/context";
import {
  bringBack,
  continueWriting,
  mentionNeeds,
  needsYou,
  setLater,
  typedToday,
  type Need,
  type NeedGroup,
} from "~/lib/desk.server";
import { readForm } from "~/lib/form.server";
import { useBrowserZone } from "capsomer/react/hooks";
import { visibleProjects } from "~/lib/people.server";

import type { Route } from "./+types/home";
import "capsomer/attention-list.css";

export function meta() {
  return [{ title: "Home · Carrel" }];
}

type Show = "all" | NeedGroup | "later";

const FILTERS: { id: Show; label: string }[] = [
  { id: "all", label: "All" },
  { id: "ai", label: "AI drafts" },
  { id: "due", label: "Due now" },
  { id: "flags", label: "Flags" },
  { id: "mentions", label: "Mentions" },
  { id: "approvals", label: "Approvals" },
  { id: "later", label: "Later" },
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
    zone: getZone(context),
    googleMessage: url.searchParams.get("google"),
  };
}

/** Later and Bring back. The zone is the browser's, sent with the form; Cloudflare's guess when script is off. */
export async function action({ request, context }: Route.ActionArgs) {
  const form = await readForm(request);
  const need = String(form.get("need") ?? "");
  switch (form.get("intent")) {
    case "later":
      await setLater(
        getEnv(context).DB,
        getViewer(context),
        { id: need, title: String(form.get("title") ?? "") },
        laterUntil(new Date(), String(form.get("zone") ?? "") || getZone(context)),
      );
      return { ok: true };
    case "back":
      await bringBack(getEnv(context).DB, getViewer(context), need);
      return { ok: true };
    default:
      throw new Response("Unknown action.", { status: 400 });
  }
}

const noSubscribe = () => () => {};

/** The key that opens search: ⌘ on a Mac once hydrated, Ctrl until then and elsewhere. */
function useSearchKey(): string {
  return useSyncExternalStore(
    noSubscribe,
    () => (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"),
    () => "Ctrl",
  );
}

const needLink = ({ href, children, ...rest }: NeedLinkProps) => (
  <Link to={href} {...rest}>
    {children}
  </Link>
);

function Needs({ needs, show, zone }: { needs: Need[]; show: Show; zone: string }) {
  const submit = useSubmit();
  const searchKey = useSearchKey();
  return (
    <NeedsList
      needs={needs}
      show={show}
      zone={zone}
      renderLink={needLink}
      useRowForm={useRouterRowForm}
      searchKey={searchKey}
      onBack={(need) =>
        void submit({ intent: "back", need: need.id }, { method: "post", navigate: false })
      }
    />
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { isOwner, hasProjects, show, needs, mentions, resume, typed, googleMessage } = loaderData;
  const zone = useBrowserZone(loaderData.zone);
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
              <ButtonLink to="/writing">Writing</ButtonLink>
              {isOwner ? (
                <ButtonLink to="/books/new" variant="primary">
                  New book
                </ButtonLink>
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
            <Suspense fallback={<Needs needs={needs} show={show} zone={zone} />}>
              <Await resolve={mentions}>
                {(m) => <Needs needs={[...needs, ...m]} show={show} zone={zone} />}
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
