// A frontmatter text box that keeps what is typed while it has focus: the stored value is trimmed by
// the writer, the typing is not. Shared by the search fields and the post fields.

import { useState, type ChangeEvent } from "react";

export function useTyped(stored: string) {
  const [typed, setTyped] = useState<string | null>(null);
  return {
    value: typed ?? stored,
    onBlur: () => setTyped(null),
    keep: (text: string) => setTyped(text),
  };
}

/** A box's props: its typing kept, and each change written through `write`. */
export function typedProps(
  box: ReturnType<typeof useTyped>,
  locked: boolean,
  write: (text: string) => void,
) {
  return {
    className: "cap-input",
    value: box.value,
    readOnly: locked,
    onBlur: box.onBlur,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      box.keep(event.target.value);
      write(event.target.value);
    },
  };
}
