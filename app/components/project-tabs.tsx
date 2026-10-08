// The sections of a site project, as Capsomer's link tabs: each is a page of its own, so each is a link.

import { Link } from "react-router";
import { TabsNav } from "capsomer/react/tabs";

const SECTIONS = [
  { id: "posts", label: "Posts", path: "" },
  { id: "media", label: "Media", path: "/media" },
  { id: "legal", label: "Legal", path: "/legal" },
  { id: "mentions", label: "Mentions", path: "/mentions" },
  { id: "flags", label: "Flags", path: "/flags" },
] as const;

/** `mentions` says whether this person may see the Mentions tab: the queue is the Owner's alone (roles.ts). */
export function ProjectTabs({ slug, current, mentions = false }: { slug: string; current: (typeof SECTIONS)[number]["id"]; mentions?: boolean }) {
  return (
    <TabsNav aria-label={`Sections of this project`} variant="line">
      {SECTIONS.filter((s) => s.id !== "mentions" || mentions).map((s) => (
        <Link key={s.id} to={`/p/${slug}${s.path}`} className="cap-tab" aria-current={s.id === current ? "page" : undefined}>
          {s.label}
        </Link>
      ))}
    </TabsNav>
  );
}
