// The header at the top of a book file, read with Prelum's frontmatter reader (splitSource, readKey,
// readList): enough for scene headers and bible entries. Keys hold a string, a boolean, or a list of
// strings (inline `[a, b]` or one `- item` per line). A line it cannot read is reported, never guessed at.

import { readKey, readList, splitSource } from "@drdustinedwards/site-helpers/frontmatter";
import { normalizeNewlines } from "@drdustinedwards/site-helpers/text";

export type HeaderValue = string | boolean | string[];

export type Parsed = {
  data: Record<string, HeaderValue>;
  body: string;
  /** The 1-based line of the file where the body starts, so a finding in the body names the file's line. */
  bodyLine: number;
  /** Lines the parser did not understand, by file line. A file with no header has none. */
  problems: { line: number; text: string }[];
};

const KEY = /^([A-Za-z_][\w-]*):(.*)$/;
const ITEM = /^\s*-\s+/;

/** One key's value: a list where it holds one, `true` or `false` as a boolean, else its text. */
function valueOf(front: string, key: string, after: string): HeaderValue {
  const v = after.trim();
  if (v === "" || v.startsWith("[")) {
    const items = readList(front, key);
    return items.length || v.startsWith("[") ? items : "";
  }
  if (/^(true|false)(\s+#.*)?$/.test(v)) return v.startsWith("true");
  return readKey(front, key);
}

/** The header read with Prelum's block reader, keeping the booleans, the body's line and the lines it cannot read. */
export function parseFile(source: string): Parsed {
  const normal = normalizeNewlines(source);
  const split = splitSource(normal);
  if (split.front === null) {
    const open = normal.split("\n", 1)[0]?.trim() === "---";
    return {
      data: {},
      body: normal,
      bodyLine: 1,
      problems: open ? [{ line: 1, text: "The header opens with --- and never closes." }] : [],
    };
  }
  const front = split.front;
  const data: Record<string, HeaderValue> = {};
  const problems: Parsed["problems"] = [];
  // A `- item` line belongs to the key above it only when that key has nothing after its colon.
  let listKey = false;
  front.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    if (listKey && ITEM.test(line)) return;
    const match = KEY.exec(line);
    if (!match) {
      problems.push({ line: i + 2, text: line });
      listKey = false;
      return;
    }
    const [, key = "", after = ""] = match;
    data[key] = valueOf(front, key, after);
    listKey = after.trim() === "";
  });
  const bodyLine = (split.open + front + split.close).split("\n").length;
  return { data, body: split.body, bodyLine, problems };
}

export function text(data: Record<string, HeaderValue>, key: string): string {
  const value = data[key];
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.join(", ");
  return "";
}

export function list(data: Record<string, HeaderValue>, key: string): string[] {
  const value = data[key];
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter(Boolean);
  if (typeof value === "string")
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  return [];
}

export function flag(data: Record<string, HeaderValue>, key: string): boolean {
  return data[key] === true;
}
