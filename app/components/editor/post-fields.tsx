// The post fields (site-api v0.17.0, v0.22.0): one box for each field the site renders, as its meta
// lists them in capabilities.postFields, read and written through site-api's postFieldsOf and
// setPostFields, so every other key of the frontmatter is left as it was. A site that lists none shows
// none (germomics lists only the excerpt). The authors are an ordered list, the primary first. The
// feature image is picked from the media library with its alt text, which a publish needs unless the
// image is marked decorative (missingAltFields, shown on its box and in the publish gate).

import { useState, type ChangeEvent } from "react";
import { isImeEnter } from "capsomer/behavior/shortcuts";
import { Button } from "capsomer/react/button";
import { Check, Field } from "capsomer/react/field";
import { useTyped, type TypedBox } from "capsomer/react/frontmatter-fields";
import { SortableList } from "capsomer/react/sortable-list";

import { joinSource, splitSource } from "@drdustinedwards/site-helpers/frontmatter";
import {
  postFieldsOf,
  setPostFields,
  type PostField,
  type PostValues,
} from "@dustinedwards/site-api/frontmatter";
import { ImageField } from "capsomer/react/media-picker";
import { featureImageFault } from "~/lib/seo-checks";
import { absoluteUrl } from "@drdustinedwards/site-helpers/head";
import "capsomer/drop-zone.css";
import "capsomer/media.css";
import "capsomer/sortable-list.css";
import "capsomer/media-library.css";

const PICK_WORDS = {
  label: "Choose from library",
  title: "Choose the feature image",
  lead: "Pick an image already on the site, then describe it. The description is the feature image's alt text.",
};

type Props = {
  source: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  listed: readonly PostField[];
  origin: string | null;
  /** Carrel's media endpoint for the picker; null on a site without a library, where the address is typed. */
  media: { endpoint: string } | null;
};

/** A box's props: its typing kept, and each change written through `write`. */
export function typedProps(box: TypedBox, locked: boolean, write: (text: string) => void) {
  return {
    className: "cap-input",
    value: box.value,
    readOnly: locked,
    onBlur: box.done,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      box.keep(event.target.value);
      write(event.target.value);
    },
  };
}

export function PostFields({ source, onChange, readOnly, listed, origin, media }: Props) {
  const parts = splitSource(source);
  const front = parts.front;
  const values = postFieldsOf(front);
  const excerpt = useTyped(values.excerpt);
  const series = useTyped(values.series);
  const image = useTyped(values.featureImage);
  const alt = useTyped(values.featureImageAlt);
  const [adding, setAdding] = useState("");
  if (front === null || listed.length === 0) return null;

  const has = (field: PostField) => listed.includes(field);
  const locked = readOnly || !onChange;
  const write = (next: Partial<PostValues>) =>
    onChange?.(joinSource({ ...parts, front: setPostFields(front, next) }));
  const typed = (box: TypedBox, field: "excerpt" | "series" | "featureImage" | "featureImageAlt") =>
    typedProps(box, locked, (text) => write({ [field]: text }));
  const authors = values.authors;
  const add = () => {
    const name = adding.trim();
    if (!name || authors.includes(name)) return;
    write({ authors: [...authors, name] });
    setAdding("");
  };
  const fault = featureImageFault(front, listed);
  const imageSrc =
    values.featureImage && origin ? absoluteUrl(origin, values.featureImage) : values.featureImage;

  return (
    <fieldset className="cap-fm" id="post-fields">
      <legend className="cap-fm-legend">Post fields</legend>
      <div className="cap-fields cap-fm-grid">
        {has("excerpt") ? (
          <div className="cap-fm-field" data-wide="">
            <Field
              label="Excerpt"
              help="The short text the site's lists and feeds show for this post."
            >
              <textarea {...typed(excerpt, "excerpt")} rows={3} />
            </Field>
          </div>
        ) : null}
        {has("authors") ? (
          <div className="cap-fm-field" data-wide="">
            <span className="cap-field-label" id="post-authors">
              Authors
            </span>
            <p className="cap-field-help">
              Everyone credited, in order. The first is the primary author.
            </p>
            {authors.length === 0 ? (
              <p className="cap-muted">No author named: the site credits its own default.</p>
            ) : locked ? (
              <ol className="app-links" aria-labelledby="post-authors">
                {authors.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ol>
            ) : (
              <SortableList
                items={authors}
                getId={(name) => name}
                getLabel={(name) => name}
                aria-labelledby="post-authors"
                onReorder={(order) => write({ authors: order })}
                renderItem={(name) => (
                  <span className="app-author-row">
                    <span className="cap-sortable-label">{name}</span>
                    <Button
                      size="sm"
                      variant="quiet"
                      aria-label={`Remove ${name}`}
                      onClick={() => write({ authors: authors.filter((a) => a !== name) })}
                    >
                      Remove
                    </Button>
                  </span>
                )}
              />
            )}
            {!locked ? (
              <div className="app-authors-add">
                <Field label="Add an author">
                  <input
                    className="cap-input"
                    type="text"
                    value={adding}
                    onChange={(event) => setAdding(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !isImeEnter(event.nativeEvent)) {
                        event.preventDefault();
                        add();
                      }
                    }}
                  />
                </Field>
                <Button size="sm" onClick={add}>
                  Add
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        {has("series") ? (
          <div className="cap-fm-field">
            <Field label="Series" help="The series this post belongs to. Empty: none.">
              <input {...typed(series, "series")} type="text" />
            </Field>
          </div>
        ) : null}
        {has("seriesPart") ? (
          <div className="cap-fm-field">
            <Field label="Part" help="Its place in the series: 1, 2, 3.">
              <input
                className="cap-input"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={values.seriesPart ?? ""}
                readOnly={locked}
                onChange={(event) => {
                  const part = Number(event.target.value);
                  write({ seriesPart: Number.isInteger(part) && part > 0 ? part : null });
                }}
              />
            </Field>
          </div>
        ) : null}
        {has("featureImage") ? (
          <div className="cap-fm-field" data-wide="">
            <ImageField
              label="Feature image"
              value={values.featureImage}
              src={imageSrc}
              alt={values.featureImageAlt}
              none="No feature image"
              picker={media ? { ...media, words: PICK_WORDS } : undefined}
              locked={locked}
              onPick={(pick) =>
                write({
                  featureImage: pick.url,
                  featureImageAlt: pick.alt,
                  featureImageDecorative: false,
                })
              }
              onRemove={() =>
                write({ featureImage: "", featureImageAlt: "", featureImageDecorative: false })
              }
            >
              {media ? null : (
                <Field label="Image address" help="A path on the site, or a full https:// address.">
                  <input {...typed(image, "featureImage")} type="text" />
                </Field>
              )}
              {values.featureImage ? (
                <>
                  <Field
                    label="Alt text"
                    help="What the image shows, for someone who cannot see it. Required unless it is only decoration."
                    error={fault ? `${fault}.` : undefined}
                  >
                    <input {...typed(alt, "featureImageAlt")} type="text" />
                  </Field>
                  <Check
                    label="Only decoration (no alt text)"
                    checked={values.featureImageDecorative}
                    disabled={locked}
                    onChange={(event) => write({ featureImageDecorative: event.target.checked })}
                  />
                </>
              ) : null}
            </ImageField>
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}
