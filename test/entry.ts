// The Worker the test pool runs. The real entry imports the React Router build, which exists only
// after `react-router build`; the tests drive the gate and the libraries directly instead.
import { DocRoom as Room } from "../workers/doc-room";
import { changed, saved } from "./room-saves";

/** The real room, telling test/room-saves.ts when a change is waiting for its save. */
export class DocRoom extends Room {
  // Saves in milliseconds rather than a second, so the wait after each test stays short. Every other
  // behavior is the real room's.
  static override callbackOptions = {
    ...Room.callbackOptions,
    debounceWait: 10,
    debounceMaxWait: 50,
  };
  #changes = 0;

  override async onStart() {
    await super.onStart();
    this.document.on("update", () => {
      this.#changes++;
      changed(this);
    });
  }

  override async onSave() {
    const covered = this.#changes;
    try {
      await super.onSave();
    } finally {
      if (covered === this.#changes) saved(this);
    }
  }
}
export { ToolCallLog } from "@dustinedwards/site-runtime/audit-log";
export { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";

export default {
  fetch() {
    return new Response("test entry", { status: 501 });
  },
} satisfies ExportedHandler;
