// The search and sharing checks on a post, with the search result and the link card it will make
// (app/lib/seo-checks.ts), in the editor and on an AI draft's page. The checks flag; the writer decides.
// The previews are Capsomer's share preview, given the text already cut.

import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { OgCardPreview, SerpPreview } from "capsomer/react/share-preview";
import { Status } from "capsomer/react/status";

import type { SeoCheck } from "~/lib/seo-checks";

export function SearchSharingPanel({ check }: { check: SeoCheck }) {
  const { findings, preview } = check;
  const host = preview.host ?? "the site";
  const address = preview.url ? preview.url.replace(/^https?:\/\//, "") : host;
  return (
    <Panel title="Search and sharing" id="seo" count={findings.length} src="As a search result and a shared link">
      <div className="app-stack">
        {findings.length === 0 ? (
          <Empty kind="all-clear" flush title="Nothing flagged">
            The title and description fit a search result, every image has alt text, and the post has a card image.
          </Empty>
        ) : (
          <ul className="app-flags" aria-label="Search and sharing checks">
            {findings.map((f, i) => (
              <li key={i}>
                <Status tone="warn">{f.line ? `Line ${f.line}` : "Flag"}</Status>
                <span>
                  {f.message}
                  {f.excerpt ? (
                    <>
                      {" "}
                      <q className="cap-muted">{f.excerpt}</q>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="app-share-previews">
          <SerpPreview
            url={address.replace(/\//g, " › ")}
            title={preview.search.title || "No title"}
            description={preview.search.description || "No description"}
            note={preview.url ? undefined : "The address is the site's to give when it publishes the post."}
          />
          <OgCardPreview
            image={
              preview.card.image ? (
                <img src={preview.card.image} alt="This post's card image" width={1200} height={630} />
              ) : (
                <span className="app-share-noimage">No card image</span>
              )
            }
            host={host}
            title={preview.card.title || "No title"}
            description={preview.card.description}
            note={preview.card.image ? undefined : "With no card image of its own, the post shares with the site's default image, or with none."}
          />
          <dl className="app-facts">
            <dt>Canonical URL</dt>
            <dd className="cap-mono">{preview.url ?? "Not yet: set when the site publishes it"}</dd>
            <dt>Image URL</dt>
            <dd className="cap-mono">{preview.card.image ?? "None"}</dd>
          </dl>
        </div>
      </div>
    </Panel>
  );
}
