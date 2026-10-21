// The frontmatter fields the editor shows, read and written through site-api's block reader and
// writer, so only a block whose field was changed is written again and every other block, comment
// and unknown key comes back byte for byte. Shared by the server and the browser.

import { readKey, readList, setBlock } from "@dustinedwards/site-api/frontmatter";

/**
 * The fields the editor shows. A list field is a list of strings, a flag is one fixed word or nothing,
 * the rest are one line of text. `on` says which items show it: a post, a legal page, or both.
 */
export const FIELDS = [
  { key: "title", label: "Title", kind: "line", on: "all" },
  { key: "description", label: "Description", kind: "text", on: "all" },
  { key: "date", label: "Date", kind: "line", on: "post" },
  { key: "tags", label: "Tags", kind: "tags", on: "post" },
  { key: "assumed_audience", label: "Audience", kind: "text", on: "post" },
  { key: "key_takeaways", label: "Key takeaways", kind: "lines", on: "post" },
  { key: "site_name", label: "Site name", kind: "line", on: "legal" },
  { key: "operator_name", label: "Operator", kind: "line", on: "legal" },
  { key: "contact", label: "Contact", kind: "line", on: "legal" },
  { key: "jurisdiction", label: "Jurisdiction", kind: "line", on: "legal" },
  { key: "data_held", label: "Data this site holds", kind: "tags", on: "legal" },
  { key: "last_updated", label: "Last updated", kind: "line", on: "legal" },
  { key: "banner", label: "Draft banner", kind: "flag", on: "legal" },
] as const;
export type FieldKey = (typeof FIELDS)[number]["key"];
export type FieldValues = Record<FieldKey, string>;

/** The one word the banner field holds. */
export const BANNER_WORD = "Draft";

/** What each field holds now: tags as "a, b", takeaways one per line. */
export function readFields(front: string | null): FieldValues {
  const values = Object.fromEntries(FIELDS.map((f) => [f.key, ""])) as FieldValues;
  for (const field of FIELDS) {
    if (field.kind === "tags") values[field.key] = readList(front, field.key).join(", ");
    else if (field.kind === "lines") values[field.key] = readList(front, field.key).join("\n");
    else if (field.kind === "flag") values[field.key] = readKey(front, field.key) === BANNER_WORD ? BANNER_WORD : "";
    else values[field.key] = readKey(front, field.key);
  }
  return values;
}

function writeBlock(key: FieldKey, kind: (typeof FIELDS)[number]["kind"], value: string): string[] {
  if (kind === "tags") {
    const tags = value.split(",").map((t) => t.trim()).filter(Boolean);
    return [`${key}: [${tags.join(", ")}]`];
  }
  if (kind === "lines") {
    const items = value.split("\n").map((t) => t.trim()).filter(Boolean);
    return [`${key}:`, ...items.map((t) => `  - ${JSON.stringify(t)}`)];
  }
  if (kind === "flag") return [`${key}: ${JSON.stringify(BANNER_WORD)}`];
  if (key === "date") return [`date: ${value.trim()}`];
  return [`${key}: ${JSON.stringify(value.replace(/\s*\n\s*/g, " ").trim())}`];
}

/**
 * The frontmatter with one field set. A block whose field already holds that value is left as it
 * was; an emptied field is removed; a field the frontmatter lacks is added at the end.
 */
export function setField(front: string, key: FieldKey, value: string): string {
  const field = FIELDS.find((f) => f.key === key)!;
  if (readFields(front)[key] === value) return front;
  return setBlock(front, key, value.trim() === "" ? [] : writeBlock(key, field.kind, value));
}
