// The two questions the editor and a book file's page ask before a person's own leftover draft is deleted or put in
// for everyone, one place so both pages ask the same thing (the server refuses both without `confirmed=1`).

import { ConfirmDialog } from "capsomer/react/confirm-dialog";

type Props = {
  open: boolean;
  returnTo: HTMLElement | null | undefined;
  perform: () => Promise<void>;
  onClose: () => void;
};

export function DropDraftDialog({ open, returnTo, perform, onClose }: Props) {
  return (
    <ConfirmDialog
      open={open}
      title="Delete your own draft?"
      lead="The draft you kept from before shared editing is deleted. This cannot be undone."
      body={[]}
      action="Delete draft"
      returnTo={returnTo}
      perform={perform}
      onClose={onClose}
    />
  );
}

export function PutDraftDialog({ open, returnTo, perform, onClose }: Props) {
  return (
    <ConfirmDialog
      open={open}
      title="Put your draft in for everyone?"
      lead="Your draft's text replaces the text everyone here is working on, and changes since the last save are not kept."
      body={[]}
      action="Replace the text"
      returnTo={returnTo}
      perform={perform}
      onClose={onClose}
    />
  );
}
