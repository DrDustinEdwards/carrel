// The first MCP App on Carrel's AI door: carrel_read_item shows a post's versions side by side inside the chat (the
// site's text, Dustin's working draft, and each AI draft saved beside it). Read only: the view calls no tool and
// changes nothing; saving and publishing stay with the tools and their rules.
//
// Wire format, from the official client (@modelcontextprotocol/ext-apps 2.0.4, spec 2026-01-26): the view sends the
// JSON-RPC request `ui/initialize` to the host over postMessage, then the notification `ui/notifications/initialized`,
// and the host answers with `ui/notifications/tool-result`, whose params are the tool's result. The view reads
// `structuredContent` and writes it with textContent only: every field is text people or AI sessions wrote, so it is
// never parsed as HTML.

/** The view's address, named by the tool's `_meta.ui.resourceUri`. */
export const POST_APP_URI = "ui://carrel/post-versions";
/** The MIME type the MCP Apps spec requires for a view. */
export const APP_MIME_TYPE = "text/html;profile=mcp-app";
/** The tool whose answer the view shows. */
export const POST_APP_TOOL = "carrel_read_item";

const VIEW_SCRIPT = `
const host = window.parent;
let nextId = 1;
const send = (message) => host.postMessage({ jsonrpc: "2.0", ...message }, "*");
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const column = (heading, meta, source) => {
  const box = el("section", undefined, "col");
  box.append(el("h2", heading), el("p", meta, "meta"), el("pre", source || "(empty)"));
  return box;
};
const render = (data) => {
  const root = document.getElementById("root");
  root.replaceChildren();
  const columns = [];
  const site = data.site;
  columns.push(column("On the site", site ? "Version " + (site.version ?? "?") : "Not on the site yet", site ? site.source : ""));
  const mine = data.dustinsDraft;
  columns.push(column("Dustin's draft", mine ? "Saved " + (mine.updatedAt ?? "") : "None", mine ? mine.source : ""));
  for (const draft of Array.isArray(data.aiDrafts) ? data.aiDrafts : []) {
    // The tool returns a draft's summary (who, when, its note, its length), not its text.
    const facts = [draft.client, draft.createdAt, draft.words + " words", "based on version " + draft.baseVersion];
    columns.push(column("AI draft", facts.filter(Boolean).join(" · "), draft.note || ""));
  }
  const grid = el("div", undefined, "grid");
  grid.append(...columns);
  const flags = Array.isArray(data.flags) ? data.flags.length : 0;
  root.append(el("p", flags + (flags === 1 ? " open flag" : " open flags"), "meta"), grid);
};
window.addEventListener("message", (event) => {
  if (event.source !== host) return;
  const message = event.data;
  if (message && message.method === "ui/notifications/tool-result" && message.params) {
    const data = message.params.structuredContent;
    if (data && typeof data === "object") render(data);
  }
});
send({ id: nextId++, method: "ui/initialize", params: {
  appInfo: { name: "carrel-post-versions", version: "1.0.0" },
  appCapabilities: {},
  protocolVersion: "2026-01-26",
} });
window.addEventListener("message", function once(event) {
  if (event.source !== host || !event.data || event.data.id !== 1) return;
  window.removeEventListener("message", once);
  send({ method: "ui/notifications/initialized" });
});
new ResizeObserver(() => send({ method: "ui/notifications/size-changed", params: {
  width: Math.ceil(window.innerWidth), height: Math.ceil(document.documentElement.scrollHeight),
} })).observe(document.body);
`;

const VIEW_STYLE = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #5c5c66; --line: #d9d9e0; }
@media (prefers-color-scheme: dark) { :root { --bg: #17171c; --fg: #ececf1; --muted: #a0a0ad; --line: #34343e; } }
body { margin: 0; padding: 12px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.col { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; min-width: 0; }
h2 { font-size: 14px; margin: 0; }
.meta { color: var(--muted); font-size: 12px; margin: 2px 0 8px; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.5 ui-monospace, monospace; max-height: 420px; overflow: auto; }
`;

/** The view's page: one self-contained document, no external script, style or font (so it needs no CSP allowance). */
export const POST_APP_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Post versions</title><style>${VIEW_STYLE}</style></head>
<body><div id="root"><p class="meta">Waiting for the post…</p></div><script>${VIEW_SCRIPT}</script></body></html>`;
