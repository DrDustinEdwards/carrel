// Who may do what on a project. Pure, so every caller (UI loaders now, MCP tools later) asks the
// same question the same way.

export type Role = "reader" | "editor" | "owner";

/**
 * `delete_media` removes a file from a site's storage (stage 3). It is the Owner's alone: a file can
 * be in use on pages the site's reference check cannot see, such as another site linking it.
 * `delete_content` removes a post from a site. Also the Owner's alone: unlike unpublish, it takes the
 * post off the site's list altogether.
 */
export type Action = "read" | "comment" | "edit" | "publish" | "send_external" | "manage" | "delete_media" | "delete_content";

const ALLOWED: Record<Role, ReadonlySet<Action>> = {
  reader: new Set(["read", "comment"]),
  editor: new Set(["read", "comment", "edit"]),
  owner: new Set(["read", "comment", "edit", "publish", "send_external", "manage", "delete_media", "delete_content"]),
};

/** A person with no role on a project may do nothing on it, including read it. */
export function can(role: Role | null, action: Action): boolean {
  return role !== null && ALLOWED[role].has(action);
}
