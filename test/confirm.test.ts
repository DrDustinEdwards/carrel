import { describe, expect, it } from "vitest";

import { confirmationRequired, confirmationSatisfied } from "~/lib/confirm.server";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("confirmationSatisfied", () => {
  it("needs confirmed=1", () => {
    expect(confirmationSatisfied(form({ intent: "discard" }))).toBe(false);
    expect(confirmationSatisfied(form({ confirmed: "0" }))).toBe(false);
    expect(confirmationSatisfied(form({ confirmed: "1" }))).toBe(true);
  });

  it("also needs the typed word, in any case, when one is asked for", () => {
    expect(confirmationSatisfied(form({ confirmed: "1" }), "remove")).toBe(false);
    expect(confirmationSatisfied(form({ confirmed: "1", confirm: "nope" }), "remove")).toBe(false);
    expect(confirmationSatisfied(form({ confirmed: "1", confirm: " Remove " }), "remove")).toBe(
      true,
    );
  });

  it("refuses with a 400 and says nothing changed", async () => {
    const res = confirmationRequired();
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Nothing was changed");
  });
});
