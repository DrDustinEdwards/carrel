// A post's frontmatter as labelled fields: editable in the editor, read-only on the AI draft page.
// The editor keeps the one source string; these fields read from it and write back through
// setField, so a key they do not show is never touched (app/lib/frontmatter.ts).

import { Field } from "capsomer/react/field";

import { BANNER_WORD, FIELDS, readFields, setField, splitSource, joinSource, type FieldKey } from "~/lib/frontmatter";
import { legalTypeOf, marker, sectionsUsed } from "~/lib/legal";

const HINTS: Partial<Record<FieldKey, string>> = {
  tags: "Separated by commas.",
  key_takeaways: "One per line.",
  date: "Year, month, day: 2026-10-04.",
  site_name: "Filled into shared text as {{site_name}}.",
  operator_name: "Filled into shared text as {{operator_name}}.",
  contact: "An email address or a path. Shared text: {{contact}}.",
  jurisdiction: "Shared text: {{jurisdiction}}.",
  data_held: "What this site collects, separated by commas. Shared text: {{data_held}}.",
  last_updated: "Set when the Owner publishes a changed text. Edit it only to correct it.",
  banner: `Shows the word "${BANNER_WORD}" on the page until you are satisfied with it.`,
};

/** Sets one field in a source and returns the whole source. A source with no frontmatter is returned as it was. */
export function withField(source: string, key: FieldKey, value: string): string {
  const parts = splitSource(source);
  return parts.front === null ? source : joinSource({ ...parts, front: setField(parts.front, key, value) });
}

export type SectionChoice = { key: string; title: string };

export function FrontmatterFields({ source, onChange, readOnly, sections = [] }: { source: string; onChange?: (next: string) => void; readOnly?: boolean; sections?: SectionChoice[] }) {
  const { front, body } = splitSource(source);
  if (front === null) return null;
  const values = readFields(front);
  const legal = legalTypeOf(source) !== null;
  const shown = FIELDS.filter((f) => (f.on === "all" || f.on === (legal ? "legal" : "post")) && (!readOnly || values[f.key] !== ""));
  if (shown.length === 0) return null;
  const used = sectionsUsed(body);
  const unused = sections.filter((s) => !used.includes(s.key));
  return (
    <fieldset className="app-fm">
      <legend>{legal ? "Legal page details" : "Post details"}</legend>
      {shown.map((f) => {
        if (f.kind === "flag") {
          return (
            <div key={f.key} className="app-fm-field" data-wide="">
              <Field label={f.label} help={HINTS[f.key]}>
                <input type="checkbox" checked={values[f.key] !== ""} disabled={readOnly || !onChange} onChange={(event) => onChange?.(withField(source, f.key, event.target.checked ? BANNER_WORD : ""))} />
              </Field>
            </div>
          );
        }
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
      {legal && !readOnly && onChange && unused.length > 0 ? (
        <div className="app-fm-field" data-wide="">
          <Field label="Add a shared section" help="Written at the end of the text. It is filled in from the details above each time the page is saved to the site; edit its wording on the Legal tab, not here.">
            <select
              className="cap-input"
              value=""
              onChange={(event) => {
                const key = event.target.value;
                if (key) onChange(`${source.replace(/\n*$/, "")}\n\n${marker(key)}\n`);
              }}
            >
              <option value="">Choose a section</option>
              {unused.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.title}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}
    </fieldset>
  );
}
