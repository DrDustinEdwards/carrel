// A post's frontmatter as labelled fields: editable in the editor, read-only on the AI draft page.
// The editor keeps the one source string; these fields read from it and write back through
// setField, so a key they do not show is never touched (app/lib/frontmatter.ts).

import { Field } from "capsomer/react/field";

import { FIELDS, readFields, setField, splitSource, joinSource, type FieldKey } from "~/lib/frontmatter";

const HINTS: Partial<Record<FieldKey, string>> = {
  tags: "Separated by commas.",
  key_takeaways: "One per line.",
  date: "Year, month, day: 2026-10-04.",
};

/** Sets one field in a source and returns the whole source. A source with no frontmatter is returned as it was. */
export function withField(source: string, key: FieldKey, value: string): string {
  const parts = splitSource(source);
  return parts.front === null ? source : joinSource({ ...parts, front: setField(parts.front, key, value) });
}

export function FrontmatterFields({ source, onChange, readOnly }: { source: string; onChange?: (next: string) => void; readOnly?: boolean }) {
  const { front } = splitSource(source);
  if (front === null) return null;
  const values = readFields(front);
  const shown = FIELDS.filter((f) => !readOnly || values[f.key] !== "");
  if (shown.length === 0) return null;
  return (
    <fieldset className="app-fm">
      <legend>Post details</legend>
      {shown.map((f) => {
        const wide = f.kind !== "line" && f.key !== "tags";
        const props = {
          className: "cap-input",
          value: values[f.key],
          readOnly: readOnly || !onChange,
          onChange: (event: { target: { value: string } }) => onChange?.(withField(source, f.key, event.target.value)),
        };
        return (
          <div key={f.key} className="app-fm-field" data-wide={wide ? "" : undefined}>
            <Field label={f.label} help={HINTS[f.key]}>
              {f.kind === "text" || f.kind === "lines" ? <textarea {...props} rows={f.kind === "lines" ? 4 : 2} /> : <input {...props} type="text" />}
            </Field>
          </div>
        );
      })}
    </fieldset>
  );
}
