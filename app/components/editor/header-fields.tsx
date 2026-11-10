// A book file's header (its front matter: pov, date, location, characters, goal...) as one field per key,
// in the order the file has them, with the raw block one disclosure away for anything the fields do not
// say (a comment, a key with a list on several lines). A list shows as "a, b" and is written back as
// [a, b], the form the binder and the bible read (lib/novels/frontmatter.ts).

import { Disclosure } from "capsomer/react/disclosure";
import {
  joinSource,
  readKey,
  setRawKey,
  splitSource,
} from "@drdustinedwards/site-helpers/frontmatter";
import { useId, useState } from "react";

import { parseFile } from "~/lib/novels/frontmatter";

/** The value as it is written after the key: a list in brackets, text quoted only when YAML needs it. */
function rawOf(value: string, list: boolean): string {
  if (list) {
    const items = value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    return `[${items.join(", ")}]`;
  }
  const v = value.trim();
  return /^[\s\-?:,[\]{}#&*!|>'"%@`]|: | #/.test(v) ? JSON.stringify(v) : v;
}

/** "pov" reads as POV and "first_line" as "First line"; the key itself is in the text view. */
function labelOf(key: string): string {
  if (key.toLowerCase() === "pov") return "POV";
  const words = key.replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function HeaderFields({
  source,
  onChange,
  readOnly,
}: {
  source: string;
  onChange: (next: string) => void;
  readOnly: boolean;
}) {
  const id = useId();
  const split = splitSource(source);
  const { data } = parseFile(source);
  const keys = Object.keys(data);
  if (split.front === null)
    return <p className="app-note">This file has no header, so it has no details to set.</p>;
  const setKey = (key: string, value: string, list: boolean) => {
    const front = setRawKey(split.front ?? "", key, rawOf(value, list));
    onChange(joinSource({ ...split, front }));
  };
  return (
    <div className="app-stack">
      <div className="app-fm" role="group" aria-label="Header">
        {keys.map((key) => {
          const value = data[key];
          const list = Array.isArray(value);
          return (
            <div className="cap-field" key={key}>
              <label className="cap-field-label" htmlFor={`${id}-${key}`}>
                {labelOf(key)}
              </label>
              {list ? (
                <p className="cap-field-help" id={`${id}-${key}-help`}>
                  Separated by commas.
                </p>
              ) : null}
              {list ? (
                <ListInput
                  key={(value as string[]).join(", ")}
                  id={`${id}-${key}`}
                  describedBy={`${id}-${key}-help`}
                  value={(value as string[]).join(", ")}
                  readOnly={readOnly}
                  onCommit={(next) => setKey(key, next, true)}
                />
              ) : (
                <input
                  className="cap-input"
                  id={`${id}-${key}`}
                  value={readKey(split.front, key)}
                  readOnly={readOnly}
                  onChange={(event) => setKey(key, event.target.value, false)}
                />
              )}
            </div>
          );
        })}
      </div>
      <Disclosure summary="Edit as text">
        <label className="cap-sr-only" htmlFor={`${id}-raw`}>
          The header as text
        </label>
        <textarea
          className="cap-input app-header-raw"
          id={`${id}-raw`}
          rows={Math.max(4, keys.length + 2)}
          value={split.front}
          readOnly={readOnly}
          spellCheck={false}
          onChange={(event) => onChange(joinSource({ ...split, front: event.target.value }))}
        />
      </Disclosure>
    </div>
  );
}

/**
 * A list typed as "a, b": written when the field is left, so a comma being typed is not cleaned away. It is
 * keyed by the value, so a change from someone else draws it afresh.
 */
function ListInput({
  id,
  describedBy,
  value,
  readOnly,
  onCommit,
}: {
  id: string;
  describedBy: string;
  value: string;
  readOnly: boolean;
  onCommit: (next: string) => void;
}) {
  const [text, setText] = useState(value);
  return (
    <input
      className="cap-input"
      id={id}
      aria-describedby={describedBy}
      value={text}
      readOnly={readOnly}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (text !== value) onCommit(text);
      }}
    />
  );
}
