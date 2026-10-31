// The log's route names (workers/route.ts) stay in step with Desk's routes, and Desk's /health answers without Access.

import { describe, expect, it } from "vitest";

import routes from "../app/routes";
import { gate } from "../workers/gate";
import { DESK_PATTERNS, routeOf } from "../workers/route";
import { testEnv } from "./env";

type Entry = { path?: string; index?: boolean; children?: Entry[] };
const paths = (list: Entry[]): string[] => list.flatMap((r) => [...(r.index ? ["/"] : r.path ? [`/${r.path}`] : []), ...paths(r.children ?? [])]);

describe("route names", () => {
  it("name every route app/routes.ts declares, and a path no route has stays unnamed", () => {
    expect([...DESK_PATTERNS].sort()).toEqual(paths(routes as Entry[]).sort());
    expect(routeOf(new Request("https://desk.test/p/sample/e/42"))).toBe("/p/:project/e/:item");
    expect(routeOf(new Request("https://desk.test/wp-login.php"))).toBeUndefined();
  });
});

describe("Desk /health", () => {
  it("answers the shared health with the deployed commit, with no Access token and without rendering", async () => {
    let rendered = false;
    const response = await gate(new Request("https://desk.test/health"), { ...testEnv, DEPLOY_SHA: "abcdef1" } as Env, async () => {
      rendered = true;
      return new Response("inside");
    });
    expect(rendered).toBe(false);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(await response.json()).toMatchObject({ sha: "abcdef1" });
  });
});
