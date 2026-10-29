// The details of one file in the media library (routes/media.tsx): its facts, the alt text, caption
// and tags forms, the focal point, crop and replace, where it is used, and the trash and delete buttons. A panel on the page, not a modal dialog,
// so each edit is a form that posts and works without script.

import { Form, Link, useNavigate } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Status } from "capsomer/react/status";

import type { MediaDetail, MediaUploadLimits } from "@dustinedwards/site-api";
import type { MediaOffers } from "~/lib/media.server";

import { CropEditor } from "./crop-editor";
import { FocusPicker } from "./focus-picker";
import { CROPPABLE, cropType, dims, size, type MediaUse } from "./format";

type Written =
  | { intent: string; ok: true; id: string; recorded: boolean }
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
  const name = detail.filename ?? detail.id;
  const writable = canUpload && Boolean(detail.version);
  const inTrash = Boolean(detail.trashedAt);
  const image = detail.contentType.startsWith("image/");
  const croppable = CROPPABLE.includes(cropType(detail.contentType));
  const replaceable = offers.replace && canReplace && Boolean(detail.version) && !inTrash;
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
            <dd>{detail.uploadedAt ? detail.uploadedAt.slice(0, 10) : "unknown"}</dd>
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

          {written && written.id === detail.id ? (
            written.ok ? (
              <Banner tone="ok">
                {written.intent === "trash"
                  ? "Moved to the trash."
                  : written.intent === "restore"
                    ? "Restored to the library."
                    : written.intent === "replace"
                      ? "Replaced. Every post that shows this file shows the new one."
                      : "Saved."}
                {written.recorded ? "" : " The site has it, but Carrel could not save the authorship record."}
              </Banner>
            ) : (
              <Alert tone={written.conflict ? "warn" : "crit"} title={written.conflict ? "The file changed" : "Not saved"}>
                {written.message}
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

          {offers.focus && writable && !inTrash && image ? (
            <FocusPicker id={detail.id} version={detail.version!} src={detail.src} name={name} focus={detail.focus} pending={pending === "set-focus"} />
          ) : null}

          {croppable && !inTrash && (canUpload || replaceable) ? (
            <div className="app-actions">
              <CropEditor
                id={detail.id}
                version={detail.version ?? ""}
                name={name}
                endpoint={endpoint}
                canReplace={replaceable}
                onSaved={(newId) => {
                  if (newId) void navigate(here({ id: newId }), { preventScrollReset: true });
                  else onChanged();
                }}
              />
            </div>
          ) : null}

          {replaceable && limits ? (
            <Form method="post" encType="multipart/form-data" className="app-form" key={`replace:${detail.id}:${detail.version}`}>
              <input type="hidden" name="id" value={detail.id} />
              <input type="hidden" name="version" value={detail.version} />
              <Field
                label="Replace the file"
                help={`A new ${detail.contentType} file, up to ${size(limits.maxBytes)}, under the same address: every post that shows this file shows the new one, and the old one is gone from the site. Alt text, caption and tags stay.`}
              >
                <input className="cap-input" type="file" name="file" accept={cropType(detail.contentType)} required />
              </Field>
              <div className="app-actions">
                <Button type="submit" name="intent" value="replace" variant="danger" pending={pending === "replace"}>
                  Replace<span className="cap-sr-only"> {name}</span>
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
            <p className="app-actions">
              {detail.tags.map((t) => (
                <Link key={t} to={here({ tag: t, id: "" })} className="cap-btn" data-size="sm">
                  Files tagged {t}
                </Link>
              ))}
            </p>
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

          {canDelete && detail.deletable ? (
            serverAsks === detail.id ? (
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
            ) : (
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
            )
          ) : null}
        </div>
      </Panel>
  );
}
