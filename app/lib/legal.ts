// Legal pages: a privacy or terms page is an ordinary page on the site, with a few fields in its
// frontmatter and shared sections in its body. A shared section is written once in Carrel and
// reused by every site's page; a site's own facts are the fields. Each site still publishes its own
// page, so the shared text reaches a site only when its page is published. Pure, so the server, the
// editor and the tests read it the same way.

import { readFields, setField, splitSource, joinSource } from "~/lib/frontmatter";

export const LEGAL_TYPES = ["privacy", "terms"] as const;
export type LegalType = (typeof LEGAL_TYPES)[number];

/** The id a site gives each legal page; the page's address is registered on the site, never made here. */
export const legalItemId = (type: LegalType) => `page.${type}`;

/** The fields a shared section may name as `{{site_name}}`: the site's own facts. */
export const VARIABLES = ["site_name", "operator_name", "contact", "jurisdiction", "data_held"] as const;
type Variable = (typeof VARIABLES)[number];

export const SECTION_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Reads the frontmatter's `legal_type`, or null when the source is not a legal page. */
export function legalTypeOf(source: string): LegalType | null {
  const { front } = splitSource(source);
  if (front === null) return null;
  const match = /^legal_type:\s*["']?([a-z]+)["']?\s*$/m.exec(front);
  return LEGAL_TYPES.find((t) => t === match?.[1]) ?? null;
}

/** The `path:` line of a source's frontmatter, or null. */
export function pathOf(source: string): string | null {
  const { front } = splitSource(source);
  const match = front === null ? null : /^path:\s*["']?([^"'\r\n]*?)["']?\s*$/m.exec(front);
  return match ? match[1]! : null;
}

export const marker = (key: string) => `<!-- shared:${key} -->`;

// An opening marker, and the closing one when the section was already expanded.
const BLOCK = /<!--\s*shared:([a-z0-9-]+)\s*-->(?:[\s\S]*?<!--\s*\/shared:\1\s*-->)?/g;
const TOKEN = /\{\{\s*([a-z_]+)\s*\}\}/g;

export type SharedSection = { key: string; title: string; body: string };

export type Expansion = {
  text: string;
  /** Section keys the body names that Carrel does not have. They are left as written. */
  unknownSections: string[];
  /** Fields a used section needs and the page leaves empty. The token stays in the text. */
  missingFields: string[];
};

/** The keys of the shared sections a body names, in order. */
export function sectionsUsed(body: string): string[] {
  return [...body.matchAll(BLOCK)].map((m) => m[1]!);
}

/**
 * The body with each shared section's text written between its markers, the page's own fields
 * filled in. Running it again on its own output changes nothing, so a page can be expanded on every
 * write and compared with what is stored.
 */
export function expandShared(body: string, sections: readonly SharedSection[], values: Partial<Record<Variable, string>>): Expansion {
  const unknownSections: string[] = [];
  const missingFields: string[] = [];
  const text = body.replace(BLOCK, (whole, key: string) => {
    const section = sections.find((s) => s.key === key);
    if (!section) {
      unknownSections.push(key);
      return whole;
    }
    const filled = section.body.replace(TOKEN, (token, name: string) => {
      if (!(VARIABLES as readonly string[]).includes(name)) return token;
      const value = values[name as Variable]?.trim();
      if (value) return value;
      if (!missingFields.includes(name)) missingFields.push(name);
      return token;
    });
    return `${marker(key)}\n${filled.trim()}\n<!-- /shared:${key} -->`;
  });
  return { text, unknownSections, missingFields };
}

/** The page's own facts, from its frontmatter, for the sections that name them. */
export function valuesOf(source: string): Partial<Record<Variable, string>> {
  const fields = readFields(splitSource(source).front);
  return Object.fromEntries(VARIABLES.map((v) => [v, fields[v]]));
}

export type LegalWrite = { ok: true; source: string } | { ok: false; message: string };

/**
 * What goes to the site for a write to a legal page: shared sections expanded, and `last_updated`
 * stamped when the write makes a changed body public. Saving a draft only expands what it can: a
 * missing field is no reason to lose work, but a page that would go public with `{{operator_name}}`
 * still in it, or a section that does not exist, is refused with the field or key named.
 *
 * `public` is true for a publish, and for a save to a page that is already live.
 */
export function prepareLegalWrite(input: { source: string; stored: string | null; storedPublic: boolean; sections: readonly SharedSection[]; public: boolean; today: string }): LegalWrite {
  const parts = splitSource(input.source);
  if (parts.front === null) return { ok: false, message: "A legal page keeps its details in frontmatter, and this text has none." };
  const expansion = expandShared(parts.body, input.sections, valuesOf(input.source));
  if (input.public && expansion.unknownSections.length > 0) {
    return { ok: false, message: `There is no shared section called ${expansion.unknownSections.map((k) => `"${k}"`).join(", ")}. Add it on the Legal tab or remove its marker.` };
  }
  if (input.public && expansion.missingFields.length > 0) {
    return { ok: false, message: `The shared text needs ${expansion.missingFields.join(", ")} filled in on this page before it goes public.` };
  }
  let front = parts.front;
  const storedBody = input.stored === null ? null : splitSource(input.stored).body;
  if (input.public && (storedBody !== expansion.text || !input.storedPublic)) front = setField(front, "last_updated", input.today);
  return { ok: true, source: joinSource({ ...parts, front, body: expansion.text }) };
}
