// The words for a kind the site reports, so a recipe is called a recipe and not a post. Carrel has no
// list of kinds: these are made from the site's own kind name, whatever it is.

import { capitalize } from "@drdustinedwards/site-helpers/text";

/** The kind as a heading word: "recipe" is "Recipe". An item with no kind is a post. */
export function kindWord(kind: string | null | undefined): string {
  return capitalize(kind || "post");
}

/** The kind in the plural, as a heading word: "Posts", "Dictionaries", "Addresses". */
export function kindPlural(kind: string | null | undefined): string {
  const word = kindWord(kind);
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

/** The kind inside a sentence: "this recipe". */
export const kindNoun = (kind: string | null | undefined) => (kind || "post").toLowerCase();
