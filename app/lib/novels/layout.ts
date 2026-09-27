// The novels repository's layout, from the design job: shared/ for voice passages, checks, assembly
// and templates; one folder per book with bible/, outline/, chapters/NN-name/NN-scene.md, and build/
// ignored. Paths here are relative to the book's folder unless a name says otherwise.

import { flag, list, parseFile, text, type HeaderValue } from "./frontmatter";

export type FileKind = "scene" | "character" | "place" | "rule" | "outline" | "book" | "note";

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NUMBERED = /^(\d{2,3})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** A book folder name: lower case, digits and single hyphens, as every segment is. */
export function isBookFolder(value: string): boolean {
  return SEGMENT.test(value) && value !== "shared" && value.length <= 80;
}

/**
 * A Markdown file Carrel may open and save inside a book: known folders only, plain segments, no
 * `..`, nothing under build/. Anything else is refused before Git is asked.
 */
export function isBookPath(path: string): boolean {
  if (!path.endsWith(".md") || path.length > 200) return false;
  const parts = path.slice(0, -3).split("/");
  if (!parts.every((p) => SEGMENT.test(p))) return false;
  if (parts.length === 1) return parts[0] === "book";
  const [top] = parts;
  if (top === "chapters") return parts.length === 3 && NUMBERED.test(parts[1]!) && NUMBERED.test(parts[2]!);
  if (top === "bible") return parts.length === 2 || (parts.length === 3 && ["characters", "places", "rules"].includes(parts[1]!));
  if (top === "outline") return parts.length === 2;
  return false;
}

export function kindOf(path: string): FileKind {
  if (path === "book.md") return "book";
  if (path.startsWith("chapters/")) return "scene";
  if (path.startsWith("bible/characters/")) return "character";
  if (path.startsWith("bible/places/")) return "place";
  if (path.startsWith("bible/rules/")) return "rule";
  if (path.startsWith("outline/")) return "outline";
  return "note";
}

/** "03-the-long-road" to "The long road". */
export function titleFromSegment(segment: string): string {
  const name = NUMBERED.exec(segment)?.[2] ?? segment;
  const words = name.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** The next NN- prefix after the ones present, two digits until a hundred. */
export function nextNumbered(existing: string[], name: string): string {
  const numbers = existing.map((s) => Number(NUMBERED.exec(s)?.[1] ?? 0));
  const next = Math.max(0, ...numbers) + 1;
  return `${String(next).padStart(2, "0")}-${name}`;
}

export type SceneHeader = {
  pov: string;
  date: string;
  location: string;
  characters: string[];
  goal: string;
  conflict: string;
  outcome: string;
  flashback: boolean;
};

export type CharacterEntry = { name: string; aliases: string[]; born: string; died: string };
export type PlaceEntry = { name: string; aliases: string[] };
export type RuleEntry = { name: string; forbidden: string[] };
export type BookEntry = { title: string; author: string; language: string };

export type Meta =
  | { kind: "scene"; header: SceneHeader; hasHeader: boolean }
  | { kind: "character"; entry: CharacterEntry }
  | { kind: "place"; entry: PlaceEntry }
  | { kind: "rule"; entry: RuleEntry }
  | { kind: "book"; entry: BookEntry }
  | { kind: "outline" | "note" };

/** The name a bible file stands for when its header gives none: its file name. */
function fallbackName(path: string): string {
  const file = path.split("/").pop()!.replace(/\.md$/, "");
  return titleFromSegment(file);
}

export function readMeta(path: string, data: Record<string, HeaderValue>, hasHeader: boolean): Meta {
  const kind = kindOf(path);
  switch (kind) {
    case "scene":
      return {
        kind,
        hasHeader,
        header: {
          pov: text(data, "pov"),
          date: text(data, "date"),
          location: text(data, "location"),
          characters: list(data, "characters"),
          goal: text(data, "goal"),
          conflict: text(data, "conflict"),
          outcome: text(data, "outcome"),
          flashback: flag(data, "flashback"),
        },
      };
    case "character":
      return {
        kind,
        entry: { name: text(data, "name") || fallbackName(path), aliases: list(data, "aliases"), born: text(data, "born"), died: text(data, "died") },
      };
    case "place":
      return { kind, entry: { name: text(data, "name") || fallbackName(path), aliases: list(data, "aliases") } };
    case "rule":
      return { kind, entry: { name: text(data, "name") || fallbackName(path), forbidden: list(data, "forbidden") } };
    case "book":
      return { kind, entry: { title: text(data, "title"), author: text(data, "author"), language: text(data, "language") || "en" } };
    default:
      return { kind };
  }
}

export function describe(path: string, source: string): { meta: Meta; words: number } {
  const parsed = parseFile(source);
  return { meta: readMeta(path, parsed.data, Object.keys(parsed.data).length > 0), words: countProseWords(parsed.body) };
}

export function countProseWords(body: string): number {
  return body.match(/[\p{L}\p{N}]+(?:['\u2019][\p{L}]+)*/gu)?.length ?? 0;
}

export const TEMPLATES: Record<"scene" | "character" | "place" | "rule", (name: string) => string> = {
  scene: () =>
    ["---", "pov:", "date:", "location:", "characters: []", "goal:", "conflict:", "outcome:", "---", "", ""].join("\n"),
  character: (name) => ["---", `name: ${name}`, "aliases: []", "born:", "died:", "---", "", ""].join("\n"),
  place: (name) => ["---", `name: ${name}`, "aliases: []", "---", "", ""].join("\n"),
  rule: (name) =>
    [
      "---",
      `name: ${name}`,
      "# Each pattern is matched against every scene, ignoring case. A match is flagged, never refused.",
      "forbidden: []",
      "---",
      "",
      "",
    ].join("\n"),
};

function orderKey(path: string): number[] {
  return path.split("/").slice(1).map((segment) => Number(NUMBERED.exec(segment.replace(/\.md$/, ""))?.[1] ?? 0));
}

/** Scenes in reading order: chapters by their number, then scenes by theirs (so 100 follows 99). */
export function readingOrder<T extends { path: string }>(files: T[]): T[] {
  return files
    .filter((f) => kindOf(f.path) === "scene")
    .sort((a, b) => {
      const [ka, kb] = [orderKey(a.path), orderKey(b.path)];
      return ka[0]! - kb[0]! || ka[1]! - kb[1]! || (a.path < b.path ? -1 : 1);
    });
}

export function chapterOf(path: string): string | null {
  const parts = path.split("/");
  return parts[0] === "chapters" && parts.length === 3 ? parts[1]! : null;
}
