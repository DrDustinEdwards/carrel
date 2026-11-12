// The frontmatter fields the editor shows, as data for Capsomer's FrontmatterFields, whose reader and
// writer (readBox, setBox, over Prelum's block reader) leave every block a field did not change byte
// for byte. Shared by the server and the browser.

import type { FieldSpec } from "capsomer/react/frontmatter-fields";

/** The one word the banner field holds; turning it off removes the key. */
export const BANNER_WORD = "Draft";

/** Which items show a field: a post, a legal page, or both. */
export type FieldOn = "all" | "post" | "legal";

/** The fields the editor shows, in order, with the help the editor gives each. */
export const FIELDS: readonly (FieldSpec & { on: FieldOn })[] = [
  { key: "title", label: "Title", box: "line", on: "all" },
  { key: "description", label: "Description", box: "text", on: "all" },
  { key: "date", label: "Date", box: "line", on: "post", help: "Year, month, day: 2026-10-04." },
  { key: "tags", label: "Tags", box: "list", on: "post" },
  { key: "assumed_audience", label: "Audience", box: "text", on: "post" },
  { key: "key_takeaways", label: "Key takeaways", box: "lines", on: "post" },
  {
    key: "site_name",
    label: "Site name",
    box: "line",
    on: "legal",
    help: "Filled into shared text as {{site_name}}.",
  },
  {
    key: "operator_name",
    label: "Operator",
    box: "line",
    on: "legal",
    help: "Filled into shared text as {{operator_name}}.",
  },
  {
    key: "contact",
    label: "Contact",
    box: "line",
    on: "legal",
    help: "An email address or a path. Shared text: {{contact}}.",
  },
  {
    key: "jurisdiction",
    label: "Jurisdiction",
    box: "line",
    on: "legal",
    help: "Shared text: {{jurisdiction}}.",
  },
  {
    key: "data_held",
    label: "Data this site holds",
    box: "list",
    on: "legal",
    help: "What this site collects, separated by commas. Shared text: {{data_held}}.",
  },
  {
    key: "last_updated",
    label: "Last updated",
    box: "line",
    on: "legal",
    help: "Set when the Owner publishes a changed text. Edit it only to correct it.",
  },
  {
    key: "banner",
    label: "Draft banner",
    box: "flag",
    flag: { on: BANNER_WORD, off: null },
    on: "legal",
    help: `Shows the word "${BANNER_WORD}" on the page until you are satisfied with it.`,
  },
];
