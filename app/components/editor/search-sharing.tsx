// The search and sharing checks on a post, with the search result and the link card it will make
// (app/lib/seo-checks.ts), in the editor and on an AI draft's page. The checks flag; the writer decides.
// The previews are Capsomer's share preview, given the text already cut.

import { Empty } from "capsomer/react/empty";
import { Panel } from "capsomer/react/panel";
import { RowList } from "capsomer/react/row-list";
import { FlagRow } from "~/components/editor/flags-panel";
import { OgCardPreview, SerpPreview } from "capsomer/react/share-preview";
import { Status } from "capsomer/react/status";

import type { SeoCheck } from "~/lib/seo-checks";

export function SearchSharingPanel({ check }: { check: SeoCheck }) {
  const { findings, preview } = check;
  const host = preview.host ?? "the site";
  const address = preview.url ? preview.url.replace(/^https?:\/\//, "") : host;
  return (
    <Panel title="Search and sharing" id="seo" count={findings.length}>
      <div className="cap-stack" data-gap="6">
        {findings.length === 0 ? (
          <Empty kind="all-clear" flush title="Nothing flagged" />
        ) : (
          <RowList label="Search and sharing checks" gap="xs">
            {findings.map((f, i) => (
              <FlagRow
                key={i}
                flag={f}
                status={<Status tone="warn">Flag</Status>}
                meta={f.line ? `line ${f.line}` : undefined}
              />
            ))}
          </RowList>
        )}
        <div className="app-share-previews">
          <SerpPreview
            url={address.replace(/\//g, " › ")}
            title={preview.search.title || "No title"}
            description={preview.search.description || "No description"}
          />
          <OgCardPreview
            image={
              preview.card.image ? (
                <img
                  src={preview.card.image}
                  alt="This post's sharing card"
                  width={1200}
                  height={630}
                />
              ) : (
                <span className="app-share-noimage">No card image</span>
              )
            }
            host={host}
            title={preview.card.title || "No title"}
            description={preview.card.description}
          />
          <dl className="app-facts">
            <dt>Canonical URL</dt>
            <dd className="cap-mono">{preview.url ?? "Not yet"}</dd>
            <dt>Image URL</dt>
            <dd className="cap-mono">{preview.card.image ?? "None"}</dd>
          </dl>
        </div>
      </div>
    </Panel>
  );
}
