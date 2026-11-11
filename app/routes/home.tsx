// Home: the work queue. What waits on the person (Blocking first, then Waiting for you), each with one
// main action and Later; then where to continue writing and what was typed today. No lists of projects or
// tools, because the menu already has them. The needs that D1 knows are in the page; the mention counts are
// asked of each site and arrive after, so a slow site never holds Home.
//
// Later sets a row aside until 8 am tomorrow in the person's time zone, or sooner when the need changes
// (desk.server.ts laterUntil, markLater). The row leaves at once, focus moves to the next row, and the message
// offers Undo; the Later tab lists what is set aside, with Bring back. On a row, j and k move (row-list's own
// keys) and l sets it aside: single keys that act only while focus is on a row (WCAG 2.1.4).

import { Suspense, useEffect, useId, useSyncExternalStore } from "react";
import { Await, useFetcher, useSubmit } from "react-router";
import { Link, ButtonLink } from "capsomer/react/link";
import { useMessage } from "capsomer/react/message";
import { Banner } from "capsomer/react/banner";
import { Empty } from "capsomer/react/empty";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { Pill } from "capsomer/react/status";
import { TabsNav } from "capsomer/react/tabs";
import { Time } from "capsomer/react/time";

import { getEnv, getViewer, getZone } from "~/lib/context";
import {
  bringBack,
  continueWriting,
  laterUntil,
  mentionNeeds,
  needsYou,
  setLater,
  typedToday,
  type Need,
  type NeedGroup,
} from "~/lib/desk.server";
import { readForm } from "~/lib/form.server";
import { useBrowserZone } from "~/lib/hydrated";
import { visibleProjects } from "~/lib/people.server";

import type { Route } from "./+types/home";

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

const URGENCY = {
  blocking: { title: "Blocking", tone: "crit" as const },
  waiting: { title: "Waiting for you", tone: "info" as const },
};

/** The row that holds keyboard focus on Home's list, if any. */
function focusedNeedRow(): HTMLElement | null {
  return document.activeElement?.closest<HTMLElement>(".app-need-row") ?? null;
}

/**
 * Moves focus off a row that is about to leave: to the next row's title, else the previous one's, else the
 * current filter tab, so a keyboard user keeps their place.
 */
function focusNeighbor(row: HTMLElement) {
  const list = row.closest("[data-cap='row-list']");
  const rows = list ? Array.from(list.querySelectorAll<HTMLElement>(".app-need-row")) : [];
  const at = rows.indexOf(row);
  const next = rows[at + 1] ?? rows[at - 1];
  const target =
    next?.querySelector<HTMLElement>(".cap-row-title :is(a, button)") ??
    row.closest(".cap-panel")?.querySelector<HTMLElement>("[aria-current='page']");
  target?.focus();
}

function NeedRow({
  need,
  zone,
  noteId,
  onBack,
}: {
  need: Need;
  zone: string;
  noteId: string;
  onBack: (need: Need) => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const { say } = useMessage();
  const link = ({ href, children }: { href: string; children: React.ReactNode }) => (
    <Link to={href}>{children}</Link>
  );
  // The row leaves the list as soon as it is sent; it is back if the server refused it.
  if (fetcher.state !== "idle") return null;
  const aside = need.later !== undefined;
  return (
    <Row
      className="app-need-row"
      title={need.title}
      href={need.action.href}
      detail={need.detail}
      meta={
        aside ? (
          <span>
            Back <Time at={need.later!} />
          </span>
        ) : need.at ? (
          <Time at={need.at} />
        ) : undefined
      }
      renderLink={link}
      actions={
        <>
          <fetcher.Form
            method="post"
            onSubmit={(e) => {
              const row = e.currentTarget.closest<HTMLElement>(".app-need-row");
              if (row) focusNeighbor(row);
              if (aside) say(`Back on Home: ${need.title}`);
              else
                say(`Set for later, until tomorrow morning: ${need.title}`, {
                  undo: () => onBack(need),
                  undone: `Back on Home: ${need.title}`,
                });
            }}
          >
            <input type="hidden" name="intent" value={aside ? "back" : "later"} />
            <input type="hidden" name="need" value={need.id} />
            <input type="hidden" name="title" value={need.title} />
            <input type="hidden" name="zone" value={zone} />
            <button
              type="submit"
              className="cap-btn"
              data-variant="quiet"
              data-later=""
              aria-describedby={aside ? undefined : noteId}
            >
              {aside ? "Bring back" : "Later"}
            </button>
          </fetcher.Form>
          <ButtonLink to={need.action.href} variant="primary">
            {need.action.label}
          </ButtonLink>
        </>
      }
    />
  );
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

function Needs({ needs, show, zone }: { needs: Need[]; show: Show; zone: string }) {
  const noteId = useId();
  const submit = useSubmit();
  const searchKey = useSearchKey();
  // l on a row sets it aside (Bring back in the Later tab); only while focus is on a row, so the key is the
  // row's own and typing elsewhere never fires it (WCAG 2.1.4). It also obeys the network's switch for single
  // keys (data-cap-single-keys on <html>), as row-list's j and k do.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "l" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (document.documentElement.dataset.capSingleKeys === "off") return;
      const button = focusedNeedRow()?.querySelector<HTMLButtonElement>("[data-later]");
      if (!button) return;
      e.preventDefault();
      button.click();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const onBack = (need: Need) => {
    void submit({ intent: "back", need: need.id }, { method: "post", navigate: false });
  };
  const rows = needs.filter((n) =>
    show === "later"
      ? n.later !== undefined
      : n.later === undefined && (show === "all" || n.group === show),
  );
  if (rows.length === 0)
    return show === "later" ? (
      <Empty kind="all-clear" flush title="Nothing set aside">
        Later on a row hides it until tomorrow morning.
      </Empty>
    ) : (
      <Empty kind="all-clear" flush title="Nothing needs you">
        {show === "all" ? "Everything waiting on you is done." : "Nothing here. Try All."}
      </Empty>
    );
  // One list, so j and k move through Blocking and Waiting alike; the urgency headings sit between the rows.
  return (
    <>
      <RowList label={show === "later" ? "Set aside for later" : "Needs you"}>
        {(["blocking", "waiting"] as const).map((u) => {
          const group = rows.filter((n) => n.urgency === u);
          if (group.length === 0) return null;
          return [
            <li key={u} className="app-need-group">
              <h3 className="app-need-head">
                <Pill tone={URGENCY[u].tone === "crit" ? "crit" : undefined} variant="secondary">
                  {URGENCY[u].title}
                </Pill>
                <span className="app-need-count">{group.length}</span>
              </h3>
            </li>,
            ...group.map((n) => (
              <NeedRow key={n.id} need={n} zone={zone} noteId={noteId} onBack={onBack} />
            )),
          ];
        })}
      </RowList>
      <p className="app-need-keys">
        <span className="app-need-key">
          <kbd>j</kbd> <kbd>k</kbd> move
        </span>
        <span className="app-need-key">
          <kbd>Enter</kbd> open
        </span>
        <span className="app-need-key">
          <kbd>l</kbd> {show === "later" ? "bring back" : "later"}
        </span>
        <span className="app-need-key">
          <kbd>{searchKey}</kbd> <kbd>K</kbd> search
        </span>
        <span id={noteId}>
          {show === "later"
            ? "These come back on their own at 8 am, or sooner if they change."
            : "Later hides a row until 8 am tomorrow, or sooner if it changes."}
        </span>
      </p>
    </>
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
