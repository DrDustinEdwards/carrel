// Copied from DrDustinEdwards/dustinedwards-info@6e0f8c9 (app/lib/content/reading-time.mjs).
// Unchanged.

// Imports nothing: the editor's chunk runs in the browser, and pipeline.mjs would bring shiki with it.

// Changing this restates every published post's reading time on the next regeneration.
const WORDS_PER_MINUTE = 200;

/**
 * Counts markdown syntax as words on purpose: it is the count published reading times were built with.
 *
 * @param {string} markdownText
 * @returns {number}
 */
export function countWords(markdownText) {
  return markdownText.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * @param {number} words
 * @returns {number}
 */
export function minutesForWords(words) {
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

/**
 * @param {string} markdownText
 * @returns {number}
 */
export function readingTimeMinutes(markdownText) {
  return minutesForWords(countWords(markdownText));
}
