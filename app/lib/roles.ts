// Who may do what on a project. Pure, so every caller (UI loaders, MCP tools) asks the same question
// the same way.

export type Role = "reader" | "editor" | "author" | "owner";

/** The roles the Owner grants on a project, lowest first. The Owner's own role is never granted. */
const MEMBER_ROLES = ["reader", "editor", "author"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === "string" && (MEMBER_ROLES as readonly string[]).includes(value);
}

/**
 * `publish` publishes, schedules and unpublishes any post on the project, and is the Owner's alone.
 * `publish_own` does the same for the posts the person wrote: the Author's (Dustin's ruling of
 * 2026-10-29, after EmDash's content:publish_own). A post's author is the person whose save created
 * it in Carrel (`itemAuthor` in content.server.ts); a post made anywhere else has none, so only the
 * Owner publishes it. Use `mayPublish` for one item, never `publish_own` alone.
 * `delete_media` removes a file from a site's storage (stage 3). It is the Owner's alone: a file can
 * be in use on pages the site's reference check cannot see, such as another site linking it.
 * `delete_content` removes a post from a site. Also the Owner's alone: unlike unpublish, it takes the
 * post off the site's list altogether.
 * `suggest` makes tracked changes in a file's live editor, which someone with `edit` accepts or rejects:
 * a Reader is a coauthor who comments and suggests (ruling of 2026-10-10, point 2b), as a commenter in
 * Google Docs suggests. The room enforces it (workers/doc-room.ts, `suggestOnly`).
 * `read_mentions` and `decide_mention` are the Owner's alone: Dustin ruled (2026-09-26) that the inbox belongs to
 * Dustin alone (a mention is text a stranger sent, and the site reserves deleting one to its admin).
 * They are two actions so the page can be opened to Editors and Readers by changing one line here.
 */
export type Action =
  | "read"
  | "comment"
  | "suggest"
  | "edit"
  | "publish"
  | "publish_own"
  | "send_external"
  | "manage"
  | "delete_media"
  | "delete_content"
  | "read_mentions"
  | "decide_mention";

const ALLOWED: Record<Role, ReadonlySet<Action>> = {
  reader: new Set(["read", "comment", "suggest"]),
  editor: new Set(["read", "comment", "suggest", "edit"]),
  author: new Set(["read", "comment", "suggest", "edit", "publish_own"]),
  owner: new Set(["read", "comment", "suggest", "edit", "publish", "publish_own", "send_external", "manage", "delete_media", "delete_content", "read_mentions", "decide_mention"]),
};

/** A person with no role on a project may do nothing on it, including read it. */
export function can(role: Role | null, action: Action): boolean {
  return role !== null && ALLOWED[role].has(action);
}

/** Whether a person may change what the public sees of one post: any post for the Owner, their own for an Author. */
export function mayPublish(role: Role | null, wroteIt: boolean): boolean {
  return can(role, "publish") || (wroteIt && can(role, "publish_own"));
}

/** Each role's name on the screens. */
export const ROLE_LABEL: Record<Role, string> = { reader: "Reader", editor: "Editor", author: "Author", owner: "Owner" };
