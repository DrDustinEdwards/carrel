// The CSP report sink counts each client by site-runtime's key (an IPv6 address by its /64), and the preview failure page
// names itself with a heading.

import { describe, expect, it } from "vitest";

import { previewFailure } from "~/lib/preview.server";

import { cspReport } from "../workers/csp-report";

describe("the CSP report sink", () => {
  it("counts every address of one IPv6 /64 as one client", async () => {
    const keys: string[] = [];
    const env = {
      CSP_REPORT_RATE_LIMIT: {
        limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }),
      },
    } as unknown as Env;
    for (const ip of ["2001:db8:0:1::1", "2001:db8:0:1:ffff::2"]) {
      const request = new Request("https://door.test/csp-report", {
        method: "POST",
        headers: { "CF-Connecting-IP": ip },
        body: "{}",
      });
      expect((await cspReport(request, env, "https://carrel.test")).status).toBe(204);
    }
    expect(new Set(keys).size).toBe(1);
  });
});

describe("the preview failure page", () => {
  it("puts its message in a heading", async () => {
    expect(await previewFailure("No site <here>").text()).toContain(
      "<h1>No site &#60;here&#62;</h1>",
    );
  });
});
