// A site's own pages, as Capsomer's link tabs: its posts, then its settings (Legal, Voice, the 404
// report, and Share and the connection). Media has its own place in the menu, and mentions and flags
// are filters on Home, so neither is a tab here.

import { Link } from "capsomer/react/link";
import { TabsNav } from "capsomer/react/tabs";

const SECTIONS = [
  { id: "posts", label: "Posts", path: "" },
  { id: "legal", label: "Legal", path: "/legal" },
  { id: "voice", label: "Voice", path: "/voice" },
  { id: "not-found", label: "404s", path: "/not-found" },
  { id: "settings", label: "Share and connection", path: "/settings" },
] as const;

export function ProjectTabs({
  slug,
  current,
}: {
  slug: string;
  current: (typeof SECTIONS)[number]["id"];
}) {
  return (
    <TabsNav aria-label="Pages of this site" variant="line">
      {SECTIONS.map((s) => (
        <Link
          key={s.id}
          to={`/p/${slug}${s.path}`}
          className="cap-tab"
          aria-current={s.id === current ? "page" : undefined}
        >
          {s.label}
        </Link>
      ))}
    </TabsNav>
  );
}
