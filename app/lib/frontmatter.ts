// A post's source is YAML frontmatter and a Markdown body. The editor shows the frontmatter as
// fields and the body as the text, and joins them back into the one source the site stores.
//
// The join is lossless: the source is cut into the text before the body and the body, the
// frontmatter into top-level blocks (a key line and the lines that belong to it), and only a block
// whose field was changed is written again. Every other block, comment and unknown key comes back
// byte for byte. Shared by the server and the browser.

export type Split = { front: string | null; body: string; open: string; close: string };

const FENCE = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n(?:[ \t]*\r?\n)*|$))/;

/** Cuts a source into its frontmatter text, its body and the fences between, so `open + front + close + body` is the source. Blank lines after the closing fence go with the fence, so the body starts at its first line of text. */
export function splitSource(source: string): Split {
  const m = FENCE.exec(source);
  if (!m) return { front: null, body: source, open: "", close: "" };
  return { front: m[2]!, body: source.slice(m[0].length), open: m[1]!, close: m[3]! };
}

export function joinSource(s: Split): string {
  return s.front === null ? s.body : `${s.open}${s.front}${s.close}${s.body}`;
}

type Block = { key: string | null; lines: string[] };

const KEY = /^([A-Za-z_][\w-]*):(.*)$/;

function blocks(front: string): Block[] {
  const out: Block[] = [];
  for (const line of front.split("\n")) {
    const m = KEY.exec(line);
    if (m) out.push({ key: m[1]!, lines: [line] });
    else if (out.length > 0) out[out.length - 1]!.lines.push(line);
    else out.push({ key: null, lines: [line] });
  }
  return out;
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function listOf(block: Block): string[] {
  const first = KEY.exec(block.lines[0]!)![2]!.trim();
  if (first.startsWith("[") && first.endsWith("]")) {
    return first
      .slice(1, -1)
      .split(",")
      .map((t) => unquote(t))
      .filter(Boolean);
  }
  return block.lines
    .slice(1)
    .map((l) => /^\s*-\s+(.*)$/.exec(l)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(unquote);
}

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
  if (front === null) return values;
  for (const block of blocks(front)) {
    const field = FIELDS.find((f) => f.key === block.key);
    if (!field) continue;
    if (field.kind === "tags") values[field.key] = listOf(block).join(", ");
    else if (field.kind === "flag") values[field.key] = unquote(KEY.exec(block.lines[0]!)![2]!) === BANNER_WORD ? BANNER_WORD : "";
    else if (field.kind === "lines") values[field.key] = listOf(block).join("\n");
    else values[field.key] = unquote(KEY.exec(block.lines[0]!)![2]!);
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
  const all = blocks(front);
  const at = all.findIndex((b) => b.key === key);
  const fresh = value.trim() === "" ? [] : writeBlock(key, field.kind, value);
  if (at >= 0) {
    if (fresh.length > 0) all[at] = { key, lines: fresh };
    else all.splice(at, 1);
  } else if (fresh.length > 0) {
    all.push({ key, lines: fresh });
  }
  return all.flatMap((b) => b.lines).join("\n");
}
