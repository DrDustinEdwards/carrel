// Test-only entry for `npm run check:conformance`. NEVER DEPLOYED: the deploy target is
// workers/app.ts, and this file is reached only by passing it positionally to `wrangler dev`.
//
// The official conformance suite cannot complete an OAuth sign-in, so this mounts the REAL protocol
// layer and the REAL tools (app/lib/mcp/server.ts) with the door's token check replaced by a fixed
// session: an Owner who owns nothing, so a tool call returns an empty answer rather than touching a
// site. What gets certified is the code that ships. The door is certified separately, against
// auth-entry.ts, which mounts the real door.

import { handleMcp } from "~/lib/mcp/server";

const SESSION = {
  viewer: { id: 1, email: "owner@conformance.invalid", name: "Conformance", isOwner: true, isReviewer: false },
  client: "conformance suite",
};

export default {
  fetch(request, env, ctx) {
    return handleMcp(request, env, ctx, SESSION, { carrelOrigin: "http://localhost:8792" });
  },
} satisfies ExportedHandler<Env>;
