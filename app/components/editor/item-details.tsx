// An item's frontmatter in the editor's Details tab, and read-only on the AI draft page: Capsomer's
// FrontmatterFields with the boxes Carrel knows for a post or a legal page (lib/frontmatter.ts). Any
// other kind keeps its content in keys of its own (a recipe's servings, a cohort's researchers), so it
// gets its whole frontmatter as text, for the site to check on save. A legal page can add a shared
// section here too.

import { Field } from "capsomer/react/field";
import { FrontmatterFields } from "capsomer/react/frontmatter-fields";

import { splitSource } from "@drdustinedwards/site-helpers/frontmatter";
import { fieldSpecs } from "~/lib/frontmatter";
import { kindWord } from "~/lib/kind-words";
import { legalTypeOf, marker, sectionsUsed } from "~/lib/legal";

type SectionChoice = { key: string; title: string };

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
  /** The site's kind for the item; none is a post. */
  kind?: string | null;
  /** The search fields the site lists: the description is then one box in Search and sharing, not here too. */
  searchFields?: readonly string[];
}) {
  const legal = legalTypeOf(source) !== null;
  if (!legal && kind && kind !== "post")
    return (
      <FrontmatterFields
        source={source}
        onChange={onChange}
        readOnly={readOnly}
        fields={[]}
        extra="text"
        legend={`${kindWord(kind)} details`}
      />
    );
  const unused = legal
    ? sections.filter((s) => !sectionsUsed(splitSource(source).body).includes(s.key))
    : [];
  return (
    <FrontmatterFields
      source={source}
      onChange={onChange}
      readOnly={readOnly}
      fields={fieldSpecs(legal, searchFields)}
      extra="text"
      legend={legal ? "Legal page details" : "Post details"}
    >
      {legal && !readOnly && onChange && unused.length > 0 ? (
        <div className="cap-fm-field" data-wide="">
          <Field
            label="Add a shared section"
            help="Written at the end of the text. It is filled in from the details above each time the page is saved to the site; edit its wording on the Legal tab, not here."
          >
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
    </FrontmatterFields>
  );
}
