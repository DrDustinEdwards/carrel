// The scope of a list: every site, or one. A plain GET form with a select, so it works with no script and the
// choice is in the address; with script, choosing submits at once. It replaces the per-site menu entries.
// Kept here until a second Capsomer app needs one, then it moves to Capsomer.

import { useRef } from "react";
import { Form } from "react-router";

export type ScopeSite = { slug: string; name: string };

export function ScopeChip({
  sites,
  value,
  keep = {},
  all = "All sites",
  name = "site",
  action,
}: {
  sites: ScopeSite[];
  /** The slug in force, or "" for every site. */
  value: string;
  /** Other query values to carry (the status tab, the search) when the scope changes. */
  keep?: Record<string, string | undefined>;
  /** The label of the unscoped choice; null when the page needs one site (Media). */
  all?: string | null;
  name?: string;
  /** Where the form goes; the current page when left out. */
  action?: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <Form method="get" action={action} ref={form} className="app-scope">
      {Object.entries(keep).map(([k, v]) =>
        v ? <input key={k} type="hidden" name={k} value={v} /> : null,
      )}
      <label className="app-scope-label">
        <span className="cap-sr-only">Show posts from</span>
        <select
          className="cap-select"
          name={name}
          value={value}
          onChange={() => form.current?.requestSubmit()}
        >
          {all === null ? null : <option value="">{all}</option>}
          {sites.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <noscript>
        <button className="cap-btn" type="submit">
          Show
        </button>
      </noscript>
    </Form>
  );
}
