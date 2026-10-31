/** What the site holds, in words that do not read as live when it is not: a draft on the site is not published. */
export function siteState(status: "draft" | "scheduled" | "published" | null, everPublished: boolean): string {
  if (status === "published") return "Matches what is live on the site";
  if (status === "scheduled") return "Matches the site, scheduled to publish";
  return everPublished ? "Matches the site's draft. It is not live." : "Saved as a draft on the site. Not published yet.";
}

/** What a list or the editor says of an item with changes in Carrel nobody has saved to the site (A5): a live one says so first, since the public sees the older text. */
export function unsavedNote(status: string | null): string {
  return status === "published" ? "Live, with unsaved changes" : status === "scheduled" ? "Scheduled, with unsaved changes" : "Unsaved changes in Carrel";
}
