// The post's search and sharing fields (site-api v0.17.0): one box for each field the site lists in
// capabilities.searchFields, read and written through site-api's searchFieldsOf and setSearchFields, so
// every other key of the frontmatter is left as it was. The search title and description measure their
// width as a Google result sets them (Capsomer's SerpWidthMeter, from Arial's advance widths, so the
// server render already shows the number); too wide only warns. The two faults that block a
// publish are seo-checks' searchFieldFaults, shown here on their boxes and in the publish gate.

import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Check, Field } from "capsomer/react/field";
import { SerpWidthMeter } from "capsomer/react/share-preview";

import { joinSource, readKey, splitSource } from "@drdustinedwards/site-helpers/frontmatter";
import {
  searchFieldsOf,
  setSearchFields,
  type SearchField,
  type SearchValues,
} from "@dustinedwards/site-api/frontmatter";
import { LibraryInsert } from "~/components/media/library-insert";
import { typedProps, useTyped } from "~/components/editor/typed-box";
import { searchFieldFaults, titleSuffixOf } from "~/lib/seo-checks";
import { absoluteUrl } from "@drdustinedwards/site-helpers/head";

const PICK_WORDS = {
  label: "Choose from library",
  title: "Choose the share image",
  lead: "Pick an image already on the site, then describe it. The description is the share image's alt text.",
};

type Props = {
  source: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  listed: readonly SearchField[];
  site: string;
  origin: string | null;
  /** Carrel's media endpoint for the picker; null on a site without a library, where the image is typed. */
  media: { endpoint: string } | null;
};

export function SearchFields({ source, onChange, readOnly, listed, site, origin, media }: Props) {
  const parts = splitSource(source);
  const front = parts.front;
  const title = useTyped(readKey(front, "searchTitle"));
  const description = useTyped(readKey(front, "description"));
  const alt = useTyped(readKey(front, "imageAlt"));
  const canonical = useTyped(readKey(front, "canonical"));
  const image = useTyped(readKey(front, "image"));
  if (front === null) return null;

  const values = searchFieldsOf(front);
  const has = (field: SearchField) => listed.includes(field);
  const locked = readOnly || !onChange;
  const write = (next: Partial<SearchValues>) =>
    onChange?.(joinSource({ ...parts, front: setSearchFields(front, next) }));
  const typed = (
    box: ReturnType<typeof useTyped>,
    field: "searchTitle" | "description" | "image" | "imageAlt" | "canonical",
  ) => typedProps(box, locked, (text) => write({ [field]: text }));
  const faults = searchFieldFaults(front, listed);
  const fault = (field: "imageAlt" | "canonical") => {
    const found = faults.find((f) => f.field === field);
    return found ? `${found.message}.` : undefined;
  };
  const postTitle = readKey(front, "title");
  const imageSrc = values.image && origin ? absoluteUrl(origin, values.image) : values.image;

  return (
    <fieldset className="cap-fm" id="search-fields">
      <legend className="cap-fm-legend">Search and sharing</legend>
      <div className="cap-fields cap-fm-grid">
        {has("searchTitle") ? (
          <div className="cap-fm-field" data-wide="">
            <Field
              label="Search title"
              help="The title a search result shows. Empty: the post's title."
            >
              <input {...typed(title, "searchTitle")} type="text" placeholder={postTitle} />
            </Field>
            <SerpWidthMeter
              label="Width in a search result"
              text={`${title.value.trim() || postTitle}${titleSuffixOf(site)}`}
            />
          </div>
        ) : null}
        {has("description") ? (
          <div className="cap-fm-field" data-wide="">
            <Field
              label="Description"
              help="The text under the title in a search result, and on a shared link."
            >
              <textarea {...typed(description, "description")} rows={3} />
            </Field>
            <SerpWidthMeter
              label="Width in a search result"
              text={description.value.trim()}
              part="description"
            />
          </div>
        ) : null}
        {has("image") ? (
          <div className="cap-fm-field app-share-image" data-wide="">
            <span className="cap-field-label">Share image</span>
            <div className="app-share-image-row">
              <div className="app-share-image-thumb">
                {imageSrc ? (
                  <img src={imageSrc} alt={values.imageAlt} />
                ) : (
                  <span className="cap-muted">No share image: the site's default is used</span>
                )}
              </div>
              <div className="cap-stack" data-gap="4">
                {media ? (
                  values.image ? (
                    <p className="app-share-image-url cap-mono">{values.image}</p>
                  ) : null
                ) : (
                  <Field
                    label="Image address"
                    help="A path on the site, or a full https:// address."
                  >
                    <input {...typed(image, "image")} type="text" />
                  </Field>
                )}
                {!locked ? (
                  <div className="cap-cluster" data-gap="3">
                    {media ? (
                      <LibraryInsert
                        media={media}
                        words={{
                          ...PICK_WORDS,
                          label: values.image ? "Choose another" : PICK_WORDS.label,
                        }}
                        variant="default"
                        onPick={(pick) => write({ image: pick.url, imageAlt: pick.alt })}
                      />
                    ) : null}
                    {values.image ? (
                      <Button
                        variant="quiet"
                        size="sm"
                        onClick={() => write({ image: "", imageAlt: "" })}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {has("imageAlt") ? (
                  <Field
                    label="Alt text"
                    help="What the image shows, for someone who cannot see it. Required with a share image."
                    error={fault("imageAlt")}
                  >
                    <input {...typed(alt, "imageAlt")} type="text" />
                  </Field>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        {has("canonical") ? (
          <div className="cap-fm-field" data-wide="">
            <Field
              label="Canonical address"
              help="Only for a post that first appeared elsewhere: the full https:// address of the original. Empty: the post's own address."
              error={fault("canonical")}
            >
              <input {...typed(canonical, "canonical")} type="url" inputMode="url" />
            </Field>
          </div>
        ) : null}
        {has("noindex") ? (
          <div className="cap-fm-field" data-wide="">
            <Check
              label="Hide from search engines (noindex)"
              checked={values.noindex}
              disabled={locked}
              onChange={(event) => write({ noindex: event.target.checked })}
            />
            {values.noindex ? (
              <Alert tone="warn">
                This post will leave search results: search engines are asked not to list it. People
                with the link can still read it.
              </Alert>
            ) : null}
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}
