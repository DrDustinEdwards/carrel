// A destructive request carries its confirmation (devkit-destructive). A guard in the page's own script is gone for a
// reader without JavaScript while the destruction is not, so the action itself refuses what was not confirmed.
// The page asks (Capsomer's confirm dialog, or its confirm page for a plain form) and posts `confirmed=1`; a typed word,
// where the page asks for one, posts as `confirm`.

/** Whether the request says the person confirmed: `confirmed=1`, and the typed word when one was asked for. */
export function confirmationSatisfied(form: FormData, word?: string): boolean {
  if (form.get("confirmed") !== "1") return false;
  if (word === undefined) return true;
  return (
    String(form.get("confirm") ?? "")
      .trim()
      .toLowerCase() === word.toLowerCase()
  );
}

/** The refusal for a destructive request that was not confirmed. Nothing was changed. */
export function confirmationRequired(): Response {
  return new Response("Confirm this change first. Nothing was changed.", { status: 400 });
}
