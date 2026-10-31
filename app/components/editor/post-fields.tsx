// The post fields box (A2, A4, A6): one box for each post field the site renders, as its meta lists them
// in capabilities.postFields, read and written through site-api's postFieldsOf and setPostFields, so every
// other key of the frontmatter is left as it was. The authors are an ordered list, the primary first. The
// feature image is picked from the media library with its alt text, which a publish needs. Where the site
// takes a publish date (contentPublishedAt), the date is a box here and goes with the publish as
// publishedAt, not into the frontmatter.

import { useState, type ChangeEvent } from "react";
import { Button } from "capsomer/react/button";
import { Check, Field } from "capsomer/react/field";

import { joinSource, postFieldsOf, readKey, setBlock, setPostFields, setRawKey, splitSource, type PostValues } from "@dustinedwards/site-api/frontmatter";
import { LibraryInsert } from "~/components/media/library-insert";

/**
 * The feature image keys (site-api v0.19.0). TODO site-api 0.19: they are in POST_FIELDS, read and written
 * by postFieldsOf and setPostFields; use those and drop featureOf and setFeature.
 */
const FEATURE = ["featureImage", "featureImageAlt", "featureImageDecorative"] as const;
type Feature = { featureImage: string; featureImageAlt: string; featureImageDecorative: boolean };

function featureOf(front: string | null): Feature {
  return { featureImage: readKey(front, "featureImage"), featureImageAlt: readKey(front, "featureImageAlt"), featureImageDecorative: readKey(front, "featureImageDecorative") === "true" };
}

function setFeature(front: string, values: Partial<Feature>): string {
  let out = front;
  for (const key of FEATURE) {
    const value = values[key];
    if (value === undefined) continue;
    if (typeof value === "boolean") out = value ? setRawKey(out, key, "true") : setBlock(out, key, []);
    else out = value.trim() ? setRawKey(out, key, JSON.stringify(value.trim())) : setBlock(out, key, []);
  }
  return out;
}

/** A feature image with no alt text, unless marked decorative: the site refuses its publish, and so does the gate. */
export function featureFault(front: string | null, listed: readonly string[]): string | null {
  if (!listed.includes("featureImage")) return null;
  const f = featureOf(front);
  return f.featureImage && !f.featureImageAlt.trim() && !f.featureImageDecorative ? "The feature image has no alt text" : null;
}

const PICK_WORDS = {
  label: "Choose from library",
  title: "Choose the feature image",
  lead: "Pick an image already on the site, then describe it. The description is the feature image's alt text.",
};

type Props = {
  source: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  /** The post fields the site renders (its meta's postFields). */
  listed: readonly string[];
  origin: string | null;
  media: { endpoint: string } | null;
  /** Where the site takes a publish date: the date in the box, as a datetime-local value, and its setter. */
  date: { value: string; set: (value: string) => void; live: boolean } | null;
};

export function PostFields({ source, onChange, readOnly, listed, origin, media, date }: Props) {
  const parts = splitSource(source);
  const front = parts.front;
  const [adding, setAdding] = useState("");
  if (front === null || (listed.length === 0 && !date)) return null;
  const values = postFieldsOf(front);
  const feature = featureOf(front);
  const has = (field: string) => listed.includes(field);
  const locked = readOnly || !onChange;
  const write = (next: Partial<PostValues>) => onChange?.(joinSource({ ...parts, front: setPostFields(front, next) }));
  const writeFeature = (next: Partial<Feature>) => onChange?.(joinSource({ ...parts, front: setFeature(front, next) }));
  const text = (field: "excerpt" | "series") => ({
    className: "cap-input",
    value: values[field],
    readOnly: locked,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => write({ [field]: event.target.value }),
  });
  const authors = values.authors;
  const move = (from: number, to: number) => {
    const next = [...authors];
    const [name] = next.splice(from, 1);
    next.splice(to, 0, name!);
    write({ authors: next });
  };
  const add = () => {
    const name = adding.trim();
    if (!name || authors.includes(name)) return;
    write({ authors: [...authors, name] });
    setAdding("");
  };
  const imageSrc = feature.featureImage && origin && feature.featureImage.startsWith("/") ? `${origin.replace(/\/+$/, "")}${feature.featureImage}` : feature.featureImage;
  const fault = featureFault(front, listed);

  return (
    <fieldset className="app-fm" id="post-fields">
      <legend>Post fields</legend>
      {has("excerpt") ? (
        <div className="app-fm-field" data-wide="">
          <Field label="Excerpt" help="The short text lists and feeds show for this post.">
            <textarea {...text("excerpt")} rows={3} />
          </Field>
        </div>
      ) : null}
      {has("authors") ? (
        <div className="app-fm-field" data-wide="">
          <span className="cap-field-label" id="post-authors-label">
            Authors
          </span>
          <p className="cap-field-help">Everyone credited, in order. The first is the primary author.</p>
          {authors.length > 0 ? (
            <ol className="app-authors" aria-labelledby="post-authors-label">
              {authors.map((name, i) => (
                <li key={name}>
                  <span>{name}</span>
                  {!locked ? (
                    <span className="app-actions">
                      <Button size="sm" variant="quiet" disabledReason={i === 0 ? "Already first" : undefined} onClick={() => move(i, i - 1)} aria-label={`Move ${name} up`}>
                        Up
                      </Button>
                      <Button size="sm" variant="quiet" disabledReason={i === authors.length - 1 ? "Already last" : undefined} onClick={() => move(i, i + 1)} aria-label={`Move ${name} down`}>
                        Down
                      </Button>
                      <Button size="sm" variant="quiet" onClick={() => write({ authors: authors.filter((a) => a !== name) })} aria-label={`Remove ${name}`}>
                        Remove
                      </Button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="cap-muted">No author named: the site credits its own default.</p>
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
                    if (event.key === "Enter") {
                      event.preventDefault();
                      add();
                    }
                  }}
                />
              </Field>
              <Button size="sm" onClick={add} disabledReason={adding.trim() ? undefined : "Type a name first"}>
                Add
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {has("series") ? (
        <div className="app-fm-field">
          <Field label="Series" help="The series this post belongs to. Empty: none.">
            <input {...text("series")} type="text" />
          </Field>
        </div>
      ) : null}
      {has("seriesPart") ? (
        <div className="app-fm-field">
          <Field label="Part" help="Its place in the series: 1, 2, 3.">
            <input
              className="cap-input"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={values.seriesPart ?? ""}
              readOnly={locked}
              onChange={(event) => write({ seriesPart: event.target.value ? Number(event.target.value) : null })}
            />
          </Field>
        </div>
      ) : null}
      {has("featureImage") ? (
        <div className="app-fm-field app-share-image" data-wide="">
          <span className="cap-field-label">Feature image</span>
          <div className="app-share-image-row">
            <div className="app-share-image-thumb">
              {imageSrc ? <img src={imageSrc} alt={feature.featureImageAlt} /> : <span className="cap-muted">No feature image</span>}
            </div>
            <div className="app-stack" data-tight="">
              {feature.featureImage ? <p className="app-share-image-url cap-mono">{feature.featureImage}</p> : null}
              {!locked ? (
                <div className="app-actions">
                  {media ? (
                    <LibraryInsert media={media} words={{ ...PICK_WORDS, label: feature.featureImage ? "Choose another" : PICK_WORDS.label }} variant="default" onPick={(pick) => writeFeature({ featureImage: pick.url, featureImageAlt: pick.alt })} />
                  ) : null}
                  {feature.featureImage ? (
                    <Button variant="quiet" size="sm" onClick={() => writeFeature({ featureImage: "", featureImageAlt: "", featureImageDecorative: false })}>
                      Remove
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {has("featureImageAlt") && feature.featureImage ? (
                <>
                  <Field label="Alt text" help="What the image shows, for someone who cannot see it. Required unless it is only decoration." error={fault ? `${fault}.` : undefined}>
                    <input className="cap-input" type="text" value={feature.featureImageAlt} readOnly={locked} onChange={(event) => writeFeature({ featureImageAlt: event.target.value })} />
                  </Field>
                  <Check label="Only decoration (no alt text)" checked={feature.featureImageDecorative} disabled={locked} onChange={(event) => writeFeature({ featureImageDecorative: event.target.checked })} />
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {date ? (
        <div className="app-fm-field">
          <Field label="Publish date" help={date.live ? "The date the post is published under. A change goes to the site with its next publish." : "The date it goes out under, when you publish. Empty: the moment you publish. Not in the future: that is a schedule."}>
            <input className="cap-input" type="datetime-local" value={date.value} readOnly={locked} onChange={(event) => date.set(event.target.value)} />
          </Field>
        </div>
      ) : null}
    </fieldset>
  );
}
