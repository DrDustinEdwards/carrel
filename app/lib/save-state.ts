/** What the site holds, in words that do not read as live when it is not: a draft on the site is not published. */
export function siteState(status: "draft" | "scheduled" | "published" | null, everPublished: boolean): string {
  if (status === "published") return "Matches the live post";
  if (status === "scheduled") return "Matches the site, scheduled to publish";
  return everPublished ? "Matches the site's draft. It is not live." : "Saved as a draft on the site. Not published yet.";
}
