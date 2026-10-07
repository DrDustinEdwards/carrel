// Cloudflare's Workers best practices: a current compatibility date, and observability with logs AND
// traces at a stated sampling rate. The example is the template every install starts from; the
// vitest, conformance and harness configs each carry their own copy of the date and must match it.

import { describe, expect, it } from "vitest";

import conformance from "./conformance/wrangler.jsonc?raw";
import harness from "./harness/wrangler.jsonc?raw";
import example from "../wrangler.jsonc.example?raw";
import vitestConfig from "../vitest.config.ts?raw";

const dateOf = (text: string, pattern: RegExp): string | undefined => pattern.exec(text)?.[1];

describe("wrangler configuration", () => {
  it("every config that sets a compatibility date sets the example's", () => {
    const wanted = dateOf(example, /"compatibility_date":\s*"(\d{4}-\d{2}-\d{2})"/);
    expect(wanted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const found = [
      dateOf(conformance, /"compatibility_date":\s*"(\d{4}-\d{2}-\d{2})"/),
      dateOf(harness, /"compatibility_date":\s*"(\d{4}-\d{2}-\d{2})"/),
      dateOf(vitestConfig, /compatibilityDate:\s*"(\d{4}-\d{2}-\d{2})"/),
    ];
    // Three copies read, so "all equal" cannot mean "none found".
    expect(found).toHaveLength(3);
    expect(found).toEqual([wanted, wanted, wanted]);
  });

  it("the example turns on logs and traces, each with a stated head_sampling_rate", () => {
    const stripped = example.replace(/^\s*\/\/.*$/gm, "");
    const observability = /"observability":\s*\{([\s\S]*?)\n\t\},/.exec(stripped)?.[1] ?? "";
    expect(observability.length).toBeGreaterThan(0);
    expect(observability).toMatch(/"logs":\s*\{[^}]*"enabled":\s*true[^}]*"head_sampling_rate":\s*\d/);
    expect(observability).toMatch(/"traces":\s*\{[^}]*"enabled":\s*true[^}]*"head_sampling_rate":\s*\d/);
  });
});
