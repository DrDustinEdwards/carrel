// Each site's own Markdown for the things Carrel's editor inserts, shared by the server and the
// browser (the editor runs in both). One place per site, so the editor writes what the site renders.

/** How the site places an image with its alt text (stage 3), in the site's own dialect. */
const FIGURES: Record<string, (url: string, alt: string) => string> = {
  // The site's figure directive, as its own editor inserts it (dustinedwards-info@f84b978,
  // app/components/admin/use-image-upload.ts).
  dustinedwards: (url, alt) => [`:::figure{src="${url}" alt="${alt.trim().replace(/"/g, "&quot;")}"}`, ":::"].join("\n"),
};

/** Plain Markdown for a site with no figure syntax of its own. */
const plain = (url: string, alt: string) => `![${alt.trim().replace(/[[\]]/g, "")}](${url})`;

export function figureMarkup(site: string, url: string, alt: string): string {
  return (FIGURES[site] ?? plain)(url, alt);
}
