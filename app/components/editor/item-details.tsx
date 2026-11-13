// An item's frontmatter as labeled fields: editable in the editor, read-only on the AI draft page.
// The boxes are Capsomer's FrontmatterFields; this picks which of Carrel's fields an item gets
// (app/lib/frontmatter.ts) and adds the legal page's shared-section picker.

import { Field } from "capsomer/react/field";
import { FrontmatterFields } from "capsomer/react/frontmatter-fields";

import { splitSource } from "@drdustinedwards/site-helpers/frontmatter";
import { FIELDS } from "~/lib/frontmatter";
import { kindNoun, kindWord } from "~/lib/kind-words";
import { legalTypeOf, marker, sectionsUsed } from "~/lib/legal";
import "capsomer/frontmatter-fields.css";

type SectionChoice = { key: string; title: string };

/**
 * `kind` is the site's kind for the item. A post (or an item with no kind) gets the post's fields and a
 * legal page the legal fields; any other kind keeps its content in keys of its own (a recipe's servings, a
 * cohort's researchers), so each of its keys gets a box typed from its value, for the site to check on save.
 */
export function ItemDetails({
  source,
  onChange,
  readOnly,
  sections = [],
  kind = null,
  searchFields = [],
}: {
  source: string;
  onChange?: (next: string) => void;
  readOnly?: boolean;
  sections?: SectionChoice[];
  kind?: string | null;
  /** The search fields the site lists: the description is then one box in Search and sharing, not here too. */
  searchFields?: readonly string[];
}) {
  const legal = legalTypeOf(source) !== null;
  if (!legal && kind && kind !== "post") {
    return (
      <FrontmatterFields
        source={source}
        onChange={onChange}
        readOnly={readOnly}
        legend={`${kindWord(kind)} details`}
      >
        <p className="cap-field-help cap-fm-field" data-wide="">
          The site's own keys for this {kindNoun(kind)}, as it stores them. The site checks them
          when you save.
        </p>
      </FrontmatterFields>
    );
  }
  const fields = FIELDS.filter(
    (f) =>
      (f.on === "all" || f.on === (legal ? "legal" : "post")) &&
      !(!legal && searchFields.includes(f.key)),
  );
  const used = sectionsUsed(splitSource(source).body);
  const unused = sections.filter((s) => !used.includes(s.key));
  return (
    <FrontmatterFields
      source={source}
      onChange={onChange}
      readOnly={readOnly}
      fields={fields}
      extra="text"
      raw={false}
      legend={legal ? "Legal page details" : "Post details"}
    >
      {legal && !readOnly && onChange && unused.length > 0 ? (
        <div className="cap-fm-field" data-wide="">
          <Field
            label="Add a shared section"
            help="Written at the end of the text. It is filled in from the details above each time the page is saved to the site; edit its wording on the Legal tab, not here."
          >
            {(control) => (
              <div className="cap-select-wrap">
                <select
                  {...control}
                  className="cap-select"
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
              </div>
            )}
          </Field>
        </div>
      ) : null}
    </FrontmatterFields>
  );
}
