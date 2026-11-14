// The state a page keeps for its confirm dialogs: what is being asked about and the control that asked, so focus goes
// back to it. `ask(subject, event.currentTarget)` opens; spread `props` into the ConfirmDialog whose `open` is your own
// test of `subject`. Capsomer 0.151 dropped its copy (it thought no app used it).

import { useState } from "react";

export function useConfirmAction<T>() {
  const [asking, setAsking] = useState<{ subject: T; opener: HTMLElement | null } | null>(null);
  const close = () => setAsking(null);
  return {
    subject: asking?.subject ?? null,
    ask: (subject: T, opener?: EventTarget | null) =>
      setAsking({ subject, opener: opener instanceof HTMLElement ? opener : null }),
    close,
    props: { returnTo: asking?.opener, onClose: close },
  };
}
