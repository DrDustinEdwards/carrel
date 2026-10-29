// The details of one file in the media library (routes/media.tsx): its facts, the alt text, caption
// and tags forms, where it is used, the focal point and crop and replace (each folded away until
// asked for, so the panel stays about as tall as the library beside it), and the trash and delete
// buttons together at the end. A panel on the page, not a modal dialog, so each edit is a form that
// posts and works without script.

import { useEffect, useState } from "react";
import { Form, Link, useNavigate } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Disclosure } from "capsomer/react/disclosure";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Status } from "capsomer/react/status";

import type { MediaDetail, MediaUploadLimits } from "@dustinedwards/site-api";
import type { MediaOffers } from "~/lib/media.server";

import { CropEditor } from "./crop-editor";
import { FocusPicker } from "./focus-picker";
import { CROPPABLE, cropType, dims, size, type MediaUse } from "./format";

/** What a replace says when it worked: the site's resized copies may lag until its cache clears. */
function replacedWords(sizesNeedPurge: boolean | undefined): string {
  return `Replaced. Every post that shows this file shows the new one.${sizesNeedPurge ? " Resized copies on the site may show the old picture until the site's cache clears." : ""}`;
}

/** The day a file was uploaded, in American style ("October 29, 2026"), the UTC day so the server and the browser agree. */
function UploadedDay({ at }: { at: string }) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return <>{at.slice(0, 10)}</>;
  const d = new Date(t);
  return <time dateTime={d.toISOString()}>{d.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" })}</time>;
}

/** The focal point in a few words, beside its section's name while it is folded. */
function focusWords(focus: string | null): string {
  const m = focus ? /^([\d.]+)x([\d.]+)$/.exec(focus) : null;
  return m ? `${Math.round(Number(m[1]) * 100)}% across, ${Math.round(Number(m[2]) * 100)}% down` : "none yet";
}

type Written =
  | { intent: string; ok: true; id: string; recorded: boolean; sizesNeedPurge?: boolean }
  | { intent: string; ok: false; id: string; message: string; conflict: boolean };

type Props = {
  detail: MediaDetail & { src: string; focus: string | null; caption: string };
  site: string;
  offers: MediaOffers;
  canUpload: boolean;
  canDelete: boolean;
  /** The Owner replaces a file's bytes (media.server.ts). */
  canReplace: boolean;
  limits: MediaUploadLimits | null;
  /** Carrel's media endpoint for this project, which the crop reads from and saves a new file to. */
  endpoint: string;
  /** Something changed on the site outside a form post (a crop); the page reloads its data. */
  onChanged: () => void;
  /** The last write's result, shown when it is this file's. */
  written: Written | null;
  /** A delete the site refused. */
  refused: { id: string; message: string; usedBy: MediaUse[] } | null;
  /** The file the server asks about before a delete, when script did not ask first. */
  serverAsks: string | null;
  busy: boolean;
  /** The intent being submitted, while one is. */
  pending: string | null;
  here: (over: Record<string, string>) => string;
  /** Script asks in a dialog before a delete; this opens it, returning focus to the button. */
  onAskDelete: (button: HTMLElement) => void;
};

export function MediaDetailPanel({ detail, site, offers, canUpload, canDelete, canReplace, limits, endpoint, onChanged, written, refused, serverAsks, busy, pending, here, onAskDelete }: Props) {
  const navigate = useNavigate();
  // A crop put in place of the file answers through its own fetcher, not the page's action.
  const [cropped, setCropped] = useState<Written | null>(null);
  useEffect(() => setCropped(null), [written]);
  const shown = cropped ?? written;
  // Where the panel sits above the library (a phone, a narrow window: app.css), a file opened from
  // the grid further down brings its details into view.
  useEffect(() => {
    if (!window.matchMedia("(max-width: 1099px)").matches) return;
    document.getElementById("detail-title")?.closest(".cap-panel")?.scrollIntoView({ block: "start" });
  }, [detail.id]);
  const name = detail.filename ?? detail.id;
  const writable = canUpload && Boolean(detail.version);
  const inTrash = Boolean(detail.trashedAt);
  const image = detail.contentType.startsWith("image/");
  const croppable = CROPPABLE.includes(cropType(detail.contentType));
  const replaceable = offers.replace && canReplace && Boolean(detail.version) && !inTrash;
  const showFocus = offers.focus && writable && !inTrash && image;
  const showCrop = croppable && !inTrash && (canUpload || replaceable);
  const showReplace = replaceable && limits !== null;
  return (
      <Panel title={name} level={2} headingId="detail-title" actions={<Link to={here({})} className="cap-btn" data-variant="quiet" data-size="sm" preventScrollReset>Close<span className="cap-sr-only"> the details</span></Link>}>
        <div className="app-detail">
          {detail.contentType.startsWith("image/") ? (
            <div className="cap-media-preview">
              <img src={detail.src} alt="" width={640} height={427} />
            </div>
          ) : null}
          {inTrash ? <Status tone="info">In the trash</Status> : null}
          <dl className="app-facts">
            <dt>Address on the site</dt>
            <dd>
              <code className="cap-mono">{detail.url}</code>
            </dd>
            <dt>Type</dt>
            <dd>{detail.contentType}</dd>
            <dt>Size</dt>
            <dd>
              {size(detail.bytes)}, {dims(detail.width, detail.height)}
            </dd>
            <dt>Uploaded</dt>
            <dd>{detail.uploadedAt ? <UploadedDay at={detail.uploadedAt} /> : "unknown"}</dd>
            {!(offers.alt && writable && !inTrash) ? (
              <>
                <dt>Alt text</dt>
                <dd>{detail.alt || <span className="cap-muted">none</span>}</dd>
              </>
            ) : null}
            {offers.caption && !(writable && !inTrash) ? (
              <>
                <dt>Caption</dt>
                <dd>{detail.caption || <span className="cap-muted">none</span>}</dd>
              </>
            ) : null}
            {offers.tags && !(writable && !inTrash) ? (
              <>
                <dt>Tags</dt>
                <dd>{detail.tags && detail.tags.length > 0 ? detail.tags.join(", ") : <span className="cap-muted">none</span>}</dd>
              </>
            ) : null}
          </dl>

          {shown && shown.id === detail.id ? (
            shown.ok ? (
              <Banner tone="ok">
                {shown.intent === "trash"
                  ? "Moved to the trash."
                  : shown.intent === "restore"
                    ? "Restored to the library."
                    : shown.intent === "replace"
                      ? replacedWords(shown.sizesNeedPurge)
                      : "Saved."}
                {shown.recorded ? "" : " The site has it, but Carrel could not save the authorship record."}
              </Banner>
            ) : (
              <Alert tone={shown.conflict ? "warn" : "crit"} title={shown.conflict ? "The file changed" : "Not saved"}>
                {shown.message}
              </Alert>
            )
          ) : null}

          {offers.alt && writable && !inTrash ? (
            <Form method="post" className="app-form" key={`alt:${detail.id}:${detail.version}`}>
              <input type="hidden" name="id" value={detail.id} />
              <input type="hidden" name="version" value={detail.version} />
              <Field label="Alt text" help="What the image shows, for someone who cannot see it. Leave it empty for a picture that is only decoration.">
                <textarea className="cap-input" name="alt" rows={3} defaultValue={detail.alt} maxLength={2000} />
              </Field>
              <div className="app-actions">
                <Button type="submit" name="intent" value="set-alt" pending={pending === "set-alt"}>
                  Save alt text
                </Button>
              </div>
            </Form>
          ) : null}

          {offers.caption && writable && !inTrash ? (
            <Form method="post" className="app-form" key={`caption:${detail.id}:${detail.version}`}>
              <input type="hidden" name="id" value={detail.id} />
              <input type="hidden" name="version" value={detail.version} />
              <Field label="Caption" help="The line a figure shows under the picture, for everyone. Alt text describes the picture; a caption says something about it.">
                <textarea className="cap-input" name="caption" rows={2} defaultValue={detail.caption} maxLength={2000} />
              </Field>
              <div className="app-actions">
                <Button type="submit" name="intent" value="set-caption" pending={pending === "set-caption"}>
                  Save caption
                </Button>
              </div>
            </Form>
          ) : null}

          {offers.tags && writable && !inTrash ? (
            <Form method="post" className="app-form" key={`tags:${detail.id}:${detail.version}`}>
              <input type="hidden" name="id" value={detail.id} />
              <input type="hidden" name="version" value={detail.version} />
              <Field label="Tags" help="Separate tags with commas. Lower case words joined by hyphens, up to 12.">
                <input className="cap-input" type="text" name="tags" defaultValue={(detail.tags ?? []).join(", ")} autoComplete="off" />
              </Field>
              <div className="app-actions">
                <Button type="submit" name="intent" value="set-tags" pending={pending === "set-tags"}>
                  Save tags
                </Button>
              </div>
            </Form>
          ) : null}
          {offers.tags && detail.tags && detail.tags.length > 0 ? (
            <p className="app-tag-links">
              <span className="cap-muted">Other files tagged</span>
              {detail.tags.map((t) => (
                <Link key={t} to={here({ tag: t, id: "" })}>
                  {t}
                </Link>
              ))}
            </p>
          ) : null}

          {/* The tools that change the picture itself, folded away: they are used now and then, and open they are each as tall as the rest of the panel. */}
          {showFocus || showCrop || showReplace ? (
            <div>
              {showFocus ? (
                <Disclosure summary={<>Focal point <span className="app-summary-note">{focusWords(detail.focus)}</span></>} defaultOpen={written?.intent === "set-focus" || pending === "set-focus"}>
                  <FocusPicker id={detail.id} version={detail.version!} src={detail.src} name={name} focus={detail.focus} pending={pending === "set-focus"} />
                </Disclosure>
              ) : null}
              {showCrop || showReplace ? (
                <Disclosure summary={showCrop && showReplace ? "Crop or replace the file" : showReplace ? "Replace the file" : "Crop"} defaultOpen={written?.intent === "replace" || pending === "replace"}>
                  {showCrop ? (
                    <div className="app-tool" data-inline="">
                      <CropEditor
                        id={detail.id}
                        version={detail.version ?? ""}
                        name={name}
                        endpoint={endpoint}
                        canReplace={replaceable}
                        onSaved={(newId, replaced) => {
                          if (newId) void navigate(here({ id: newId }), { preventScrollReset: true });
                          else {
                            if (replaced) setCropped({ intent: "replace", ok: true, id: detail.id, ...replaced });
                            onChanged();
                          }
                        }}
                      />
                      <p className="cap-muted app-note">Cut out part of the picture, as a new file{replaceable ? " or in place of this one" : ""}.</p>
                    </div>
                  ) : null}
                  {showReplace && limits ? (
                    <Form method="post" encType="multipart/form-data" className="app-form app-tool" key={`replace:${detail.id}:${detail.version}`}>
                      <input type="hidden" name="id" value={detail.id} />
                      <input type="hidden" name="version" value={detail.version} />
                      {/* Not Field: the one control of its own form needs no "Required" beside its name. */}
                      <div className="cap-field">
                        <label className="cap-field-label" htmlFor={`replace-${detail.id}`}>
                          Replace the file
                        </label>
                        <p className="cap-field-help" id={`replace-help-${detail.id}`}>
                          A new {detail.contentType} file, up to {size(limits.maxBytes)}, under the same address: every post that shows this file shows the new one, and the old one is
                          gone from the site. Alt text, caption and tags stay. Readers who already loaded the old picture may keep seeing it until their browser's cache expires.
                        </p>
                        <input className="cap-input" id={`replace-${detail.id}`} type="file" name="file" accept={cropType(detail.contentType)} required aria-describedby={`replace-help-${detail.id}`} />
                      </div>
                      <div className="app-actions">
                        <Button type="submit" name="intent" value="replace" variant="danger" pending={pending === "replace"}>
                          Replace<span className="cap-sr-only"> {name}</span>
                        </Button>
                      </div>
                    </Form>
                  ) : null}
                </Disclosure>
              ) : null}
            </div>
          ) : null}

          <section aria-labelledby="used-title" className="app-section">
            <h3 id="used-title">Used in</h3>
            {detail.usedBy.length === 0 ? (
              <p className="cap-muted">No post on the site uses it, as far as the site's check can see. A page elsewhere linking to it would not show here.</p>
            ) : (
              <ul className="app-list">
                {detail.usedBy.map((use) => (
                  <li key={`${use.type}:${use.id}:${use.detail}`}>
                    {use.title || use.id} <span className="cap-muted">({use.detail})</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {refused && refused.id === detail.id ? (
            <Alert tone="crit" title="Not deleted">
              {refused.message}
              {refused.usedBy.length > 0 ? (
                <ul className="app-list">
                  {refused.usedBy.map((use) => (
                    <li key={`${use.id}:${use.detail}`}>
                      {use.title || use.id} ({use.detail})
                    </li>
                  ))}
                </ul>
              ) : null}
            </Alert>
          ) : null}

          {canDelete && detail.deletable && serverAsks === detail.id ? (
            <Alert tone="warn" title={`Delete ${name} from ${site}?`}>
              <Form method="post" className="app-form">
                <p>The file leaves the site's storage, and nothing in Carrel can bring it back.</p>
                <input type="hidden" name="id" value={detail.id} />
                <input type="hidden" name="confirm" value="delete" />
                <div className="app-actions">
                  <Button type="submit" name="intent" value="delete" variant="danger" pending={busy}>
                    Delete from the site
                  </Button>
                  <Link to={here({ id: detail.id })} className="cap-btn" preventScrollReset>
                    Keep it
                  </Link>
                </div>
              </Form>
            </Alert>
          ) : null}

          {/* Trash and delete together at the end, the one that cannot be undone last. */}
          {(offers.trash && writable) || (canDelete && detail.deletable && serverAsks !== detail.id) ? (
            <div className="app-actions app-detail-end">
              {offers.trash && writable ? (
                <Form method="post">
                  <input type="hidden" name="id" value={detail.id} />
                  <input type="hidden" name="version" value={detail.version} />
                  <Button type="submit" name="intent" value={inTrash ? "restore" : "trash"} pending={pending === "trash" || pending === "restore"}>
                    {inTrash ? "Restore" : "Move to trash"}
                    <span className="cap-sr-only"> {name}</span>
                  </Button>
                </Form>
              ) : null}
              {canDelete && detail.deletable && serverAsks !== detail.id ? (
                <Form method="post">
                  <input type="hidden" name="id" value={detail.id} />
                  <Button
                    type="submit"
                    name="intent"
                    value="delete"
                    variant="danger"
                    onClick={(event) => {
                      event.preventDefault();
                      onAskDelete(event.currentTarget);
                    }}
                  >
                    Delete<span className="cap-sr-only"> {name}</span>
                  </Button>
                </Form>
              ) : null}
            </div>
          ) : null}
        </div>
      </Panel>
  );
}
