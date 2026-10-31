// Rename in the editor (A3): the same rename as the posts list's, through the content kit at the posts
// endpoint, so the roles and the hold on unsaved changes are the list's. The site moves the post to its
// new id and, where it was ever published, its old address redirects to the new one. The editor then
// opens the post at its new id.

import { useEffect, useRef, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "capsomer/react/dialog";
import { Field } from "capsomer/react/field";

type Answer = { ok: boolean; message: string; outcomes?: { id: string; ok: boolean; message: string }[] };

export function RenameButton({ slug, itemId, version, live, noun }: { slug: string; itemId: string; version: string; live: boolean; noun: string }) {
  const [open, setOpen] = useState(false);
  const [newId, setNewId] = useState(itemId);
  const opener = useRef<HTMLElement | null>(null);
  const fetcher = useFetcher<Answer>();
  const navigate = useNavigate();
  const base = `/p/${encodeURIComponent(slug)}`;
  const answer = fetcher.state === "idle" ? fetcher.data : undefined;
  const outcome = answer?.outcomes?.[0];

  useEffect(() => {
    if (outcome?.ok && newId !== itemId) void navigate(`${base}/e/${encodeURIComponent(newId.trim())}`);
  }, [outcome, newId, itemId, base, navigate]);

  return (
    <>
      <Button
        variant="quiet"
        onClick={(event) => {
          opener.current = event.currentTarget;
          setNewId(itemId);
          setOpen(true);
        }}
      >
        Rename
      </Button>
      <Dialog open={open} onOpenChange={setOpen} size="sm" returnTo={opener.current} aria-labelledby="rename-title">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void fetcher.submit({ intent: "rename", ids: itemId, versions: version, newId: newId.trim() }, { method: "post", action: `${base}/posts/api` });
          }}
        >
          <DialogHeader>
            <DialogTitle id="rename-title">Rename this {noun}</DialogTitle>
            <DialogDescription>
              {live ? `The ${noun}'s address changes. Its old address keeps redirecting to the new one.` : "Its id on the site changes. It has no public address yet."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label="New id" help="Lowercase letters, digits and hyphens, with / between parts.">
              <input className="cap-input cap-mono" type="text" value={newId} onChange={(event) => setNewId(event.target.value)} spellCheck={false} autoCapitalize="none" />
            </Field>
            {answer && !(outcome?.ok ?? false) ? <Alert tone="crit">{outcome?.message ?? answer.message}</Alert> : null}
          </DialogBody>
          <DialogFooter>
            <DialogClose part="cancel">Cancel</DialogClose>
            <Button type="submit" variant="primary" pending={fetcher.state !== "idle"} disabledReason={!newId.trim() || newId.trim() === itemId ? "Type a new id" : undefined}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </>
  );
}
