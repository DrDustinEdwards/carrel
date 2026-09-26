// Who may do what on a project. Pure, so every caller (UI loaders now, MCP tools later) asks the
// same question the same way.

export type Role = "reader" | "editor" | "owner";

export type Action = "read" | "comment" | "edit" | "publish" | "send_external" | "manage";

const ALLOWED: Record<Role, ReadonlySet<Action>> = {
  reader: new Set(["read", "comment"]),
  editor: new Set(["read", "comment", "edit"]),
  owner: new Set(["read", "comment", "edit", "publish", "send_external", "manage"]),
};

/** A person with no role on a project may do nothing on it, including read it. */
export function can(role: Role | null, action: Action): boolean {
  return role !== null && ALLOWED[role].has(action);
}
