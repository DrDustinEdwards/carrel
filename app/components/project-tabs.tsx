// The sections of a site project, as Capsomer's link tabs: each is a page of its own, so each is a link.

import { Link } from "react-router";
import { TabsNav } from "capsomer/react/tabs";

const SECTIONS = [
  { id: "posts", label: "Posts", path: "" },
  { id: "media", label: "Media", path: "/media" },
  { id: "flags", label: "Flags", path: "/flags" },
] as const;

export function ProjectTabs({ slug, current }: { slug: string; current: (typeof SECTIONS)[number]["id"] }) {
  return (
    <TabsNav aria-label={`Sections of this project`} variant="line">
      {SECTIONS.map((s) => (
        <Link key={s.id} to={`/p/${slug}${s.path}`} className="cap-tab" aria-current={s.id === current ? "page" : undefined}>
          {s.label}
        </Link>
      ))}
    </TabsNav>
  );
}
