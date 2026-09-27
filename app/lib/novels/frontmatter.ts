// The header at the top of a book file: a narrow YAML subset, enough for scene headers and bible
// entries and small enough to test completely. Keys hold a string, a boolean, or a list of strings
// (inline `[a, b]` or one `- item` per line). Anything else is reported, never guessed at.

export type HeaderValue = string | boolean | string[];

export type Parsed = {
  data: Record<string, HeaderValue>;
  body: string;
  /** The 1-based line of the file where the body starts, so a finding in the body names the file's line. */
  bodyLine: number;
  /** Lines the parser did not understand, by file line. A file with no header has none. */
  problems: { line: number; text: string }[];
};

const KEY = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/;

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Splits `a, "b, c", d` on the commas outside quotes. */
function splitList(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      items.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items.map(unquote).filter((item) => item.length > 0);
}

function scalar(raw: string): HeaderValue {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) return splitList(v.slice(1, -1));
  if (v === "true") return true;
  if (v === "false") return false;
  return unquote(v);
}

export function parseFile(source: string): Parsed {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { data: {}, body: lines.join("\n"), bodyLine: 1, problems: [] };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) {
    return { data: {}, body: lines.join("\n"), bodyLine: 1, problems: [{ line: 1, text: "The header opens with --- and never closes." }] };
  }

  const data: Record<string, HeaderValue> = {};
  const problems: Parsed["problems"] = [];
  // A key with nothing after it is an empty value until a `- item` line makes it a list.
  let listKey: string | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const current = data[listKey];
      data[listKey] = [...(Array.isArray(current) ? current : []), unquote(item[1]!)];
      continue;
    }
    const match = KEY.exec(line);
    if (!match) {
      problems.push({ line: i + 1, text: line });
      listKey = null;
      continue;
    }
    const [, key, value] = match;
    const empty = value === undefined || value.trim() === "";
    data[key!] = empty ? "" : scalar(value);
    listKey = empty ? key! : null;
  }
  return { data, body: lines.slice(end + 1).join("\n"), bodyLine: end + 2, problems };
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
  if (typeof value === "string" && value.trim()) return splitList(value);
  return [];
}

export function flag(data: Record<string, HeaderValue>, key: string): boolean {
  return data[key] === true;
}
