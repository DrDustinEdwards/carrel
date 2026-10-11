// The words for a kind the site reports, so a phage is called a phage and not a post. Carrel has no
// list of kinds: these are made from the site's own kind name, whatever it is.

/** The kind as a heading word: "phage" is "Phage". An item with no kind is a post. */
export function kindWord(kind: string | null | undefined): string {
  const k = kind || "post";
  return `${k.charAt(0).toUpperCase()}${k.slice(1)}`;
}

/** The kind in the plural, as a heading word: "Posts", "Dictionaries", "Addresses". */
export function kindPlural(kind: string | null | undefined): string {
  const word = kindWord(kind);
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

/** The kind inside a sentence: "this phage". */
export const kindNoun = (kind: string | null | undefined) => (kind || "post").toLowerCase();
