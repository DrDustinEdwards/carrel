// Carrel inside Capsomer's shell: the same rail, top bar and phone tab bar as Capsomer's own site.
// Only the contents differ: Carrel's name and mark, its projects and its Owner-only views.

import { useMemo, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { MessageProvider } from "capsomer/react/message";
import { AdminShell, type AdminApp, type AdminEntry, type LinkProps } from "capsomer/react/admin-shell";
import { ThemeSwitch } from "capsomer/react/theme-switch";

export type FrameProject = { slug: string; name: string; kind: "site" | "book" | null };

export type FrameData = {
  name: string;
  isOwner: boolean;
  projects: FrameProject[];
};

function Icon({ d, stroke }: { d: string; stroke?: boolean }) {
  return (
    <svg className="cap-admin-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={d} fill={stroke ? "none" : "currentColor"} stroke={stroke ? "currentColor" : "none"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ICONS = {
  home: <Icon d="M2.5 7.5 8 3l5.5 4.5V13h-3.5V9.5H6V13H2.5z" stroke />,
  site: <Icon d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2 8h12M8 2c2 1.8 2 10.2 0 12M8 2c-2 1.8-2 10.2 0 12" stroke />,
  book: <Icon d="M2.5 3.5c2-.8 4-.6 5.5.6 1.5-1.2 3.5-1.4 5.5-.6v9c-2-.8-4-.6-5.5.6-1.5-1.2-3.5-1.4-5.5-.6z M8 4.1v9" stroke />,
  manuscripts: <Icon d="M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 8.5h4M6 11h4" stroke />,
  social: <Icon d="M2.5 9.5V6.5l8-3.5v10l-8-3.5zM5 10.5l.8 3h2" stroke />,
};

const BRAND_MARK = (
  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
    <path fill="var(--accent)" d="M2.5 4.2C5.2 3 8 3.3 10 5c2-1.7 4.8-2 7.5-.8v11.6C14.8 14.6 12 14.9 10 16.6 8 14.9 5.2 14.6 2.5 15.8z" />
    <path stroke="var(--surface)" strokeWidth="1.5" fill="none" d="M10 5.5v10.5" />
  </svg>
);

// The strip's apps. Carrel is the one we are in; the others are the family's other admin areas.
const APPS: AdminApp[] = [
  { id: "carrel", label: "Carrel", href: "/", logo: BRAND_MARK, current: true },
  { id: "portal", label: "Capsid Portal", href: "https://portal.dustinedwards.info/", mono: "P" },
  { id: "info", label: "dustinedwards.info", href: "https://dustinedwards.info/admin", mono: "D" },
];

const initialsOf = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

function RouterLink({ href, children, ...rest }: LinkProps) {
  return (
    <Link to={href} {...rest}>
      {children}
    </Link>
  );
}

const projectHref = (p: FrameProject) => (p.kind === "book" ? `/b/${p.slug}` : `/p/${p.slug}`);

export function Frame({ data, children }: { data: FrameData | null; children: ReactNode }) {
  const { pathname } = useLocation();
  const owner = data?.isOwner ?? false;

  const { nav, tabs, more } = useMemo(() => {
    const at = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
    const home: AdminEntry = { id: "home", label: "Home", href: "/", icon: ICONS.home, current: pathname === "/" };
    const projects = (data?.projects ?? [])
      .filter((p) => p.kind !== null)
      .map<AdminEntry>((p) => ({
        id: `${p.kind}-${p.slug}`,
        label: p.name,
        href: projectHref(p),
        icon: p.kind === "book" ? ICONS.book : ICONS.site,
        current: at(projectHref(p)),
        group: p.kind === "book" ? "Books" : "Sites",
      }));
    // Sites before books, as the groups read down the rail.
    const sites = projects.filter((e) => e.group === "Sites");
    const books = projects.filter((e) => e.group === "Books");
    const library: AdminEntry[] = owner
      ? [
          { id: "manuscripts", label: "Manuscripts", href: "/manuscripts", icon: ICONS.manuscripts, current: at("/manuscripts"), group: "Owner" },
          { id: "social", label: "Social", href: "/social", icon: ICONS.social, current: at("/social"), group: "Owner" },
        ]
      : [];
    return {
      nav: [home, ...sites, ...books, ...library],
      // The phone's bar holds the views everyone reaches first; every project is under More.
      tabs: [home, ...library.map((e) => ({ ...e, group: undefined }))],
      more: [...sites, ...books].map((e) => ({ ...e, group: undefined })),
    };
  }, [data, owner, pathname]);

  return (
    <AdminShell
      title="Carrel"
      mark={BRAND_MARK}
      apps={APPS}
      nav={nav}
      tabs={tabs}
      more={more}
      renderLink={RouterLink}
      account={{
        name: data?.name ?? "Signed out",
        initials: initialsOf(data?.name ?? ""),
        role: owner ? "Owner" : undefined,
        appLinks: owner ? [{ label: "Settings", href: "/people", current: pathname === "/people" }] : undefined,
        onSignOut: data ? () => location.assign("/cdn-cgi/access/logout") : undefined,
      }}
      actions={<ThemeSwitch />}
      prefKey="carrel-rail"
    >
      <MessageProvider>
        {children}
        {/* Capsomer's publish gate only says its results when it finds [data-cap="message"] in the page, and
            the React message region carries no such attribute, so the gate would stay silent here. This empty
            marker is what it looks for; the region itself is the provider's. */}
        <span hidden data-cap="message" />
      </MessageProvider>
    </AdminShell>
  );
}
