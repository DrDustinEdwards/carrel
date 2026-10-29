# Co-editing

Every post and book file has one shared working copy, and everyone with a role on the project edits it at the same time. There are no edit locks. This is build step 10 of Dustin's writing-tools ruling of 2026-10-10 (Capsid `carrel/rulings/writing-tools-2026-10-10.md`, coauthoring stages b and c).

## Before it works on Desk: Access by hostname

Cloudflare's Worker-level Access does not pass WebSockets: "WebSocket upgrade requests to a Worker protected by a worker-level Access policy will fail with a `403` error", and a Worker that uses them, Durable Objects included, should use a hostname-based Access application instead (developers.cloudflare.com/workers/configuration/cloudflare-access/, "WebSocket limitation", read 2026-10-29). Desk is behind Worker-level Access today, so the rooms cannot connect until Dustin moves it. Nothing in Carrel's own check changes: `workers/gate.ts` still verifies the Access token on every request, against `ACCESS_AUD`.

1. **Make the hostname application.** **Zero Trust** > **Access controls** > **Applications** > **Create new application** > **Self-hosted and private** > **Add public hostname**, domain `desk.dustinedwards.info`. Under **Access policies**, add the existing policy the Worker's Access made (named `carrel - Production`, after the Worker's name when Access was turned on), so the same people get in. Keep One-time PIN among its identity providers. Select **Create**.
2. **Give Carrel its AUD.** Open the new application with **Configure**, copy the **Application Audience (AUD) Tag** from **Additional settings**, then in the carrel folder run `Get-Clipboard | npx wrangler secret put ACCESS_AUD`.
3. **Turn off Worker-level Access.** **Workers & Pages** > carrel-desk > **Access**, and turn Access off there. Open Desk, sign in, open a post: the room bar says who is here instead of "Connecting".

## The room

- **One Durable Object per file** (`workers/doc-room.ts`), built on [y-partyserver](https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver) 2.2.0 over Yjs 13.6. The binding is `DOC_ROOM`, migration tag `v1-doc-room` (`wrangler.jsonc.example`). The room keeps its copy in its own SQLite storage after every change, so it outlives hibernation and deploys, and mirrors it as Markdown into D1's `rooms` table, which the nightly backup carries.
- **The door decides who is in.** The browser reaches a room only at `/collab/...` on Desk, behind Access. `connectRoom` (`app/lib/rooms.server.ts`) checks the person's role on the project and passes who they are in a header it sets itself, so names in the room come from Carrel, never from another browser.
- **Starting.** The first person to open a file seeds the room: from their own earlier working draft when they have one, else from the site's text (or Git's). After that, everyone opening the file joins the same copy. Someone who had their own draft from before co-editing sees a banner offering **Use as the working copy** or **Drop it**.
- **Following the site.** When the site or Git moves on (a save through the AI door, or another tool) and nobody has unsaved changes, the room takes the new text. With unsaved changes the room stays, and the page says the site has a newer version.
- **Offline.** Changes typed while the connection is down are kept in the page and sent when it is back. The room bar says when the page is offline.

## In the editor

- **Carets and presence.** Each person has a color, the same on their caret, selection and ring in the room bar, drawn from Capsomer's `--series-1` to `--series-8`. Their name sits on their caret.
- **Formatted and Markdown.** The formatted editor (Tiptap 3.31 with `@tiptap/extension-collaboration`) is bound to the room. Markdown typed in the Markdown view goes into the room block by block (`patchMarkdown`, `app/lib/editor/collab.ts`), so it never overwrites someone else's paragraph. The Markdown view only shows the text while you are suggesting or while suggestions are waiting, since Markdown cannot show them.
- **Undo** undoes your own changes, not other people's.

## Suggesting

- An Editor, an Author or the Owner chooses **Editing** or **Suggesting** above the text; a Reader always suggests. The choice and the revision round are remembered on that device.
- A suggestion (`@handlewithcare/prosemirror-suggest-changes` 0.1.8, `app/lib/editor/suggest.ts`) carries who made it, when, and an optional revision round.
- The **Suggestions** panel lists them in reading order. Someone who edits accepts or rejects one, a round, or all. The person who made one withdraws it.
- The room enforces it: from a Reader it takes only changes that touch nothing but that Reader's own suggestions (`suggestOnly` in `workers/doc-room.ts`), and refuses anything else.
- A save leaves out every pending suggestion, so a suggestion reaches the site or Git only once accepted.

## Comments

- Select text and choose **Comment on the selection**. The thread is anchored with Yjs relative positions, so it stays on its passage as people type around it. If the passage is deleted, the thread says so.
- Everyone in the room comments and replies. The writer of a thread, or anyone who edits, resolves and reopens it. Writers edit their own comments; a writer or the Owner deletes one.
- The room stores comments in D1's `comments` table and tells everyone at once.

## Saving

- **Save**, **Publish** and **Schedule** send the room's text at that moment, never one browser's, through site-api's `expectedVersion` check (Git's sha for a book file). A 409 from the site means it changed underneath; nothing is overwritten.
- After a write, the room records the new version, and the revision is credited to the saver "with" everyone else who typed since the last save (the History panel and the book's authorship record).
- **Discard unsaved changes** puts the site's (or Git's) text back into the room for everyone.
- **Cancel the update** and **Unpublish** change only the post's state. The room takes the site's new version and keeps any unsaved text.

## Tests

`test/coediting.test.ts` drives real rooms in workerd through `test/room.ts`, a raw y-protocols client: the round trip of both Markdown dialects through Yjs, two editors syncing and a save crediting both, following the site, seeding from a draft, a Reader refused when changing text (a planted failure), Markdown patching that keeps another person's suggestion, and comments. The screen harness (`npm run harness`, `npm run check:a11y`) runs the editor screens with their rooms.
