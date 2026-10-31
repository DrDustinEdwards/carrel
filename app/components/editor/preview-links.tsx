// Preview links (E2, E3): a link anyone can open to read this post as it stands now, without signing in,
// for as long as the person chooses, and the post's working links, each of which can be revoked. The site
// makes and keeps them (site-api `previewLinks`); it answers a link's address once and keeps only a hash,
// so the list shows when each was made and when it stops working, never its address.

import { useRef, useState } from "react";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { ConfirmDialog } from "capsomer/react/confirm-dialog";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "capsomer/react/dialog";
import { Panel } from "capsomer/react/panel";
import { Segmented } from "capsomer/react/segmented";
import { Time } from "capsomer/react/time";

export type LinkRow = { id: string; createdAt: string; expiresAt: string };
type Made = { ok: true; url: string; expiresAt: string } | { ok: false; message: string };

/** The durations offered, in hours. A site's own limit (site-api v0.19.0 `previewLinkHours`, else 168) leaves out the longer ones. */
const DURATIONS = [
  { hours: 1, label: "An hour" },
  { hours: 24, label: "A day" },
  { hours: 48, label: "2 days" },
  { hours: 168, label: "A week" },
  { hours: 720, label: "A month" },
] as const;

type Props = {
  links: LinkRow[];
  maxHours: number;
  busy: boolean;
  noun: string;
  make: (hours: number) => Promise<Made>;
  revoke: (id: string) => Promise<void>;
};

export function PreviewLinks({ links, maxHours, busy, noun, make, revoke }: Props) {
  const offered = DURATIONS.filter((d) => d.hours <= maxHours);
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState<string>("48");
  const [made, setMade] = useState<Made | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<{ id: string; opener: HTMLElement | null } | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const start = (button: HTMLElement) => {
    opener.current = button;
    setMade(null);
    setCopied(false);
    setOpen(true);
  };

  return (
    <Panel title="Preview links" id="preview-links" count={links.length} src="Anyone with a link can read it, without signing in" size="sm">
      <div className="app-stack" data-tight>
        {links.length > 0 ? (
          <ul className="app-link-list" aria-label="Working preview links">
            {links.map((l) => (
              <li key={l.id}>
                <span>
                  Made <Time at={l.createdAt} format="exact" />, works until <Time at={l.expiresAt} format="exact" />
                </span>
                <Button size="sm" variant="danger" onClick={(event) => setRevoking({ id: l.id, opener: event.currentTarget })}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="cap-muted">No working links.</p>
        )}
        <div className="app-actions">
          <Button size="sm" onClick={(event) => start(event.currentTarget)}>
            Make a preview link
          </Button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen} size="sm" returnTo={opener.current} aria-labelledby="preview-link-title">
        <DialogHeader>
          <DialogTitle id="preview-link-title">Make a preview link</DialogTitle>
          <DialogDescription>Anyone with the link can read this {noun} as it stands now, until the link stops working or you revoke it. Search engines are told not to list it.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {made?.ok ? (
            <div className="app-stack" data-tight>
              <label className="cap-field-label" htmlFor="preview-link-url">
                The link
              </label>
              <input id="preview-link-url" className="cap-input cap-mono" type="text" readOnly value={made.url} onFocus={(event) => event.currentTarget.select()} />
              <p className="cap-muted">
                It works until <Time at={made.expiresAt} format="exact" />. It is shown only now: the site keeps no copy of it.
              </p>
            </div>
          ) : (
            <Segmented legend="How long it works" size="sm" value={hours} onChange={setHours} options={offered.map((d) => ({ value: String(d.hours), label: d.label }))} />
          )}
          {made && !made.ok ? <Alert tone="crit">{made.message}</Alert> : null}
        </DialogBody>
        <DialogFooter>
          {made?.ok ? (
            <>
              <Button
                variant="primary"
                onClick={() => {
                  void navigator.clipboard?.writeText(made.url).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy the link"}
              </Button>
              <DialogClose part="cancel">Done</DialogClose>
            </>
          ) : (
            <>
              <DialogClose part="cancel">Cancel</DialogClose>
              <Button variant="primary" pending={busy} onClick={() => void make(Number(hours)).then(setMade)}>
                Make the link
              </Button>
            </>
          )}
        </DialogFooter>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this preview link?"
        lead="Anyone who opens it from now on sees that it no longer works. This cannot be undone; you can make a new link."
        body={[]}
        action="Revoke the link"
        returnTo={revoking?.opener}
        perform={async () => {
          if (revoking) await revoke(revoking.id);
        }}
        onClose={() => setRevoking(null)}
      />
    </Panel>
  );
}
