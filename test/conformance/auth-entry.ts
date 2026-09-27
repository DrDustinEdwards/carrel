// Test-only entry for the authorization-server half of `npm run check:conformance`. NEVER DEPLOYED.
// It mounts the real AI door (app/lib/mcp/door.ts), OAuth provider included, exactly as workers/app.ts
// hands it a request on the carrel-mcp hostname. No Access for SaaS secrets are set, which only shuts
// /authorize (503, not configured means not open); the metadata this half certifies is served anyway.

import { aiDoor } from "~/lib/mcp/door";

export default {
  fetch(request, env, ctx) {
    return aiDoor(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
