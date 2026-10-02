// Copied from DrDustinEdwards/dustinedwards-info@6e0f8c9 (app/lib/editor/publish-transition.mjs).
// Unchanged.

/**
 * The pressed button's intent carries the transition, not a hidden field: a submitter's value is the
 * one part of a form sent because of what was pressed, so the buttons mean the same without script.
 */

/**
 * @typedef {"draft" | "scheduled" | "published"} PostState
 * @typedef {{
 *   id: string,
 *   label: string,
 *   wantsDraft: boolean,
 *   ceremony: boolean,
 *   danger: boolean,
 * }} Transition
 */

/** @type {Transition} */
const SAVE_DRAFT = {
  id: "save-draft",
  label: "Save draft",
  wantsDraft: true,
  ceremony: false,
  danger: false,
};

/**
 * @type {Transition}
 */
const SAVE_CHANGES = {
  id: "save",
  label: "Update",
  wantsDraft: false,
  ceremony: false,
  danger: false,
};

/** @type {Transition} */
const UNPUBLISH = {
  id: "unpublish",
  label: "Revert to draft",
  wantsDraft: true,
  ceremony: false,
  // Not destructive, but it takes something off the public site.
  danger: true,
};

/**
 * @param {PostState} state
 * @param {boolean} everPublished
 * @returns {[Transition, ...Transition[]]}
 */
export function transitionsFor(state, everPublished) {
  if (state === "draft") {
    return [
      {
        id: everPublished ? "republish" : "publish",
        label: everPublished ? "Republish" : "Publish",
        wantsDraft: false,
        // Only a never-public post gets the ceremony; asking again on republish trains click-through.
        ceremony: !everPublished,
        danger: false,
      },
      SAVE_DRAFT,
    ];
  }
  // Published and scheduled are both draft: false; publish_at is the schedule control's, not this table's.
  return [SAVE_CHANGES, UNPUBLISH];
}

/** Publish is the ask and this is the answer; both mean draft: false, only this passes the ceremony. */
export const PUBLISH_CONFIRMED_INTENT = "publish-confirmed";

/**
 * @type {Readonly<Record<string, boolean>>}
 */
export const DRAFT_BY_INTENT = Object.freeze(
  Object.fromEntries([
    ...[
      ...transitionsFor("draft", false),
      ...transitionsFor("draft", true),
      ...transitionsFor("published", true),
    ].map((transition) => [transition.id, transition.wantsDraft]),
    [PUBLISH_CONFIRMED_INTENT, false],
  ]),
);

/**
 * Fails closed: an unknown intent is a draft, so the failure mode is a post that stays private.
 *
 * @param {string | null} intent
 * @returns {boolean}
 */
export function draftForIntent(intent) {
  if (intent === null) return true;
  return DRAFT_BY_INTENT[intent] ?? true;
}

/**
 * Cmd+S submits with no submitter, so it has to name the transition that keeps the current state.
 *
 * @param {PostState} state
 * @returns {string}
 */
export function saveInPlaceIntent(state) {
  const wantsDraft = state === "draft";
  // everPublished does not change which transition saves in place, so false is passed.
  const list = transitionsFor(state, false);
  const match = list.find((transition) => transition.wantsDraft === wantsDraft);
  return match ? match.id : SAVE_DRAFT.id;
}

/**
 * Takes now rather than reading the clock, so a component recomputing it cannot hydrate a different word.
 *
 * @param {{ draft: boolean, publishAt: string }} fields
 * @param {number} now epoch milliseconds
 * @returns {PostState}
 */
export function stateOf(fields, now) {
  if (fields.draft) return "draft";
  if (!fields.publishAt) return "published";
  const at = Date.parse(fields.publishAt);
  // An unparseable publish_at is not a schedule; treating it as one would hide a live post.
  if (Number.isNaN(at)) return "published";
  return at > now ? "scheduled" : "published";
}
