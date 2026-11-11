// Carrel inside Capsomer's shell: the family letterhead (where you are and View site in its second row), app
// strip, menu, top bar and phone tab bar, as Capsomer's own site. Only the contents differ: Carrel's projects and its Owner-only views. The strip,
// the logo and the tab title come from Capsomer's FAMILY_APPS (app="carrel"); the theme is the header's
// button (Capsomer 0.9.0).

import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import type { Command } from "capsomer/react/command-menu";
import { Link } from "capsomer/react/link";
import { MessageProvider } from "capsomer/react/message";
import {
  AdminShell,
  currentEntryId,
  type AdminEntry,
  type LinkProps,
} from "capsomer/react/admin-shell";

// The search palette loads once the page is idle, or at once when the search button is pressed first, so
// its code is not on every page's first load (devkit-route-weight). It binds Ctrl or Cmd K and / itself.
// Not Capsomer's useCommandHost (0.100.0): it is exported from the same module as CommandMenu, so a
// static import of the hook puts the whole menu on every page's first load (about 6.4 KB gzip).
const CommandMenu = lazy(() =>
  import("capsomer/react/command-menu").then((m) => ({ default: m.CommandMenu })),
);

type FrameProject = { slug: string; name: string; kind: "site" | "book" | null };

export type FrameData = {
  name: string;
  isOwner: boolean;
  projects: FrameProject[];
  /** What waits on this person (the header's inbox and Home's badge). */
  needs: number;
};

function Icon({ d, stroke }: { d: string; stroke?: boolean }) {
  return (
    <svg className="cap-admin-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d={d}
        fill={stroke ? "none" : "currentColor"}
        stroke={stroke ? "currentColor" : "none"}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const ICONS = {
  home: <Icon d="M2.5 7.5 8 3l5.5 4.5V13h-3.5V9.5H6V13H2.5z" stroke />,
  writing: <Icon d="M3 13h2l7-7-2-2-7 7zM9.5 4.5l2 2" stroke />,
  book: (
    <Icon
      d="M2.5 3.5c2-.8 4-.6 5.5.6 1.5-1.2 3.5-1.4 5.5-.6v9c-2-.8-4-.6-5.5.6-1.5-1.2-3.5-1.4-5.5-.6z M8 4.1v9"
      stroke
    />
  ),
  media: <Icon d="M2.5 3.5h11v9h-11zM2.5 11l3.5-3.5 3 3 2-2 2.5 2.5M10.5 6.2h.01" stroke />,
  manuscripts: <Icon d="M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 8.5h4M6 11h4" stroke />,
  social: <Icon d="M2.5 9.5V6.5l8-3.5v10l-8-3.5zM5 10.5l.8 3h2" stroke />,
  sites: (
    <Icon
      d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2 8h12M8 2c2 1.8 2 10.2 0 12M8 2c-2 1.8-2 10.2 0 12"
      stroke
    />
  ),
  ai: <Icon d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z" stroke />,
  people: (
    <Icon
      d="M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 13c.4-2.3 2.2-3.5 4.5-3.5s4.1 1.2 4.5 3.5M11 7a2 2 0 1 0 0-4M12 9.6c1.2.3 2.1 1.3 2.5 3.4"
      stroke
    />
  ),
};

const initialsOf = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

export function RouterLink({ href, children, ...rest }: LinkProps) {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

export function Frame({ data, children }: { data: FrameData | null; children: ReactNode }) {
  const { pathname } = useLocation();
  const owner = data?.isOwner ?? false;
  const [searching, setSearching] = useState(false);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (typeof requestIdleCallback !== "function") {
      const t = setTimeout(() => setOpened(true), 200);
      return () => clearTimeout(t);
    }
    const id = requestIdleCallback(() => setOpened(true), { timeout: 2000 });
    return () => cancelIdleCallback(id);
  }, []);
  const navigate = useNavigate();
  const needs = data?.needs ?? 0;

  // A fixed list, in the verbs of the work: it does not grow with each site or book (a site's or a
  // book's own pages are reached from Writing, Books and Sites, and from the header's search).
  const { nav, tabs } = useMemo(() => {
    const entry = (
      id: string,
      label: string,
      href: string,
      group: string,
      match?: (string | RegExp)[],
    ): AdminEntry => ({ id, label, href, icon: ICONS[id as keyof typeof ICONS], group, match });
    const home = {
      ...entry("home", "Home", "/", "Now"),
      count: needs || undefined,
      countNote: "need you",
      tone: needs ? ("need" as const) : undefined,
    };
    const writing = entry("writing", "Writing", "/writing", "Write", [
      "/writing",
      /^\/p\/[^/]+\/(e|new)(\/|$)/,
    ]);
    const books = entry("book", "Books", "/books", "Write", ["/books", "/b"]);
    const media = entry("media", "Media", "/media", "Library", ["/media", /^\/p\/[^/]+\/media/]);
    const ownerEntries: AdminEntry[] = owner
      ? [
          entry("manuscripts", "Manuscripts", "/manuscripts", "Library"),
          entry("social", "Social", "/social", "Publish"),
          entry("sites", "Sites", "/sites", "Publish", [
            "/sites",
            /^\/p\/[^/]+(\/(legal|voice|not-found|flags|mentions))?$/,
          ]),
          entry("ai", "AI engine", "/ai", "Owner"),
          entry("people", "People", "/people", "Owner"),
        ]
      : [];
    const order = ["Now", "Write", "Library", "Publish", "Owner"];
    // The page you are on: Capsomer's longest match over each entry's href or match. Marked here
    // rather than through the shell's `pathname`, which would also set the tab title.
    const current = currentEntryId(pathname, [home, writing, books, media, ...ownerEntries]);
    const list = [home, writing, books, media, ...ownerEntries]
      .map((e) => ({ ...e, current: e.id === current }))
      .sort((a, b) => order.indexOf(a.group ?? "") - order.indexOf(b.group ?? ""));
    const tab = (e: AdminEntry) => ({ ...list.find((x) => x.id === e.id)!, group: undefined });
    // The phone's bar: the four places everyone reaches first. The header's menu holds the whole list.
    return {
      nav: list,
      tabs: [home, writing, books, media].map(tab),
    };
  }, [needs, owner, pathname]);

  const commands = useMemo<Command[]>(() => {
    const go = (
      id: string,
      label: string,
      to: string,
      group: string,
      keywords: string[] = [],
    ): Command => ({
      id,
      label,
      group,
      keywords,
      run: () => void navigate(to),
    });
    const sites = (data?.projects ?? []).filter((p) => p.kind === "site");
    return [
      go("go-home", "Go to Home", "/", "Go to", ["needs you", "inbox"]),
      go("go-writing", "Go to Writing", "/writing", "Go to", ["posts", "pages", "articles"]),
      go("go-books", "Go to Books", "/books", "Go to", ["manuscript", "novel"]),
      go("go-media", "Go to Media", "/media", "Go to", ["images", "photos", "files"]),
      ...(owner
        ? [
            go("go-sites", "Go to Sites", "/sites", "Go to", ["settings", "legal", "voice"]),
            go("go-social", "Go to Social", "/social", "Go to"),
            go("go-manuscripts", "Go to Manuscripts", "/manuscripts", "Go to", ["drive", "google"]),
            go("go-ai", "Go to AI engine", "/ai", "Go to", ["jobs", "drafts"]),
            go("go-people", "Go to People", "/people", "Go to", ["roles", "access"]),
            go("new-book", "New book", "/books/new", "Actions"),
          ]
        : []),
      ...sites.map((p) =>
        go(`new-${p.slug}`, `New post on ${p.name}`, `/p/${p.slug}/new`, "Actions", [
          "create",
          "write",
        ]),
      ),
    ];
  }, [data, navigate, owner]);

  const search = useCallback(
    async (query: string, signal: AbortSignal): Promise<Command[]> => {
      const response = await fetch(`/search?q=${encodeURIComponent(query)}`, { signal });
      if (!response.ok) return [];
      const found = (await response.json()) as {
        id: string;
        label: string;
        group: string;
        href: string;
        hint?: string;
      }[];
      return found.map((r) => ({
        id: r.id,
        label: r.label,
        group: r.group,
        hint: r.hint,
        run: () => void navigate(r.href),
      }));
    },
    [navigate],
  );

  return (
    <AdminShell
      app="carrel"
      letterhead
      viewSite="https://carrel.dustinedwards.info"
      nav={nav}
      tabs={tabs}
      renderLink={RouterLink}
      onSearch={
        data
          ? () => {
              setOpened(true);
              setSearching(true);
            }
          : undefined
      }
      inbox={data ? { count: needs, countNote: "need you", href: "/" } : undefined}
      account={{
        name: data?.name ?? "Signed out",
        initials: initialsOf(data?.name ?? ""),
        role: owner ? "Owner" : undefined,
        accessLogout: Boolean(data),
      }}
      prefKey="carrel-rail"
    >
      <MessageProvider>
        {children}
        {data && opened ? (
          <Suspense fallback={null}>
            <CommandMenu
              open={searching}
              onOpenChange={setSearching}
              commands={commands}
              search={search}
              label="Search Desk"
              placeholder="Search posts, books and actions"
            />
          </Suspense>
        ) : null}
        {/* Capsomer's publish gate only says its results when it finds [data-cap="message"] in the page, and
            the React message region carries no such attribute, so the gate would stay silent here. This empty
            marker is what it looks for; the region itself is the provider's. */}
        <span hidden data-cap="message" />
      </MessageProvider>
    </AdminShell>
  );
}
