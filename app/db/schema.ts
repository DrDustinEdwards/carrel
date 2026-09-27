// Mirrors drizzle/0001_init.sql to 0005_google.sql, which own the shape. Change both in the
// same commit. The FTS5 table site_items_fts has no mirror: only index.server.ts touches it, in SQL.

import { sql } from "drizzle-orm";
import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const people = sqliteTable("people", {
  id: integer("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  isOwner: integer("is_owner", { mode: "boolean" }).notNull().default(false),
  isReviewer: integer("is_reviewer", { mode: "boolean" }).notNull().default(false),
  disabledAt: text("disabled_at"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  site: text("site"),
  book: text("book"),
});

export const projectMembers = sqliteTable(
  "project_members",
  {
    projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["reader", "editor"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.personId] })],
);

export const healthState = sqliteTable("health_state", {
  checkName: text("check_name").primaryKey(),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  detail: text("detail").notNull(),
  changedAt: text("changed_at").notNull(),
});

export const siteItems = sqliteTable(
  "site_items",
  {
    projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    status: text("status", { enum: ["draft", "scheduled", "published"] }).notNull(),
    path: text("path"),
    publishAt: text("publish_at"),
    publishedAt: text("published_at"),
    updatedAt: text("updated_at"),
    bodyUpdatedAt: text("body_updated_at"),
    syncedAt: text("synced_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.itemId] })],
);

export const drafts = sqliteTable(
  "drafts",
  {
    projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    baseVersion: text("base_version"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.itemId, t.personId] })],
);

export const changes = sqliteTable("changes", {
  id: text("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  itemId: text("item_id").notNull(),
  personId: integer("person_id").notNull().references(() => people.id),
  action: text("action", { enum: ["save", "publish", "schedule", "unpublish"] }).notNull(),
  versionBefore: text("version_before"),
  versionAfter: text("version_after").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  client: text("client"),
});

export const mcpSessions = sqliteTable("mcp_sessions", {
  id: text("id").primaryKey(),
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  clientName: text("client_name").notNull(),
  clientVersion: text("client_version"),
  protocolVersion: text("protocol_version").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  lastSeenAt: text("last_seen_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export const aiDrafts = sqliteTable("ai_drafts", {
  id: integer("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  itemId: text("item_id").notNull(),
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  client: text("client").notNull(),
  source: text("source").notNull(),
  baseVersion: text("base_version"),
  note: text("note").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export const aiPublications = sqliteTable("ai_publications", {
  changeId: text("change_id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  itemId: text("item_id").notNull(),
  personId: integer("person_id").notNull().references(() => people.id),
  client: text("client").notNull(),
  version: text("version").notNull(),
  publishedAt: text("published_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  emailedAt: text("emailed_at"),
  emailError: text("email_error"),
});

export const bookFiles = sqliteTable(
  "book_files",
  {
    projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    kind: text("kind", { enum: ["scene", "character", "place", "rule", "outline", "book", "note"] }).notNull(),
    sha: text("sha").notNull(),
    source: text("source").notNull(),
    meta: text("meta").notNull().default("{}"),
    words: integer("words").notNull().default(0),
    syncedAt: text("synced_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.path] })],
);

export const novelsShared = sqliteTable("novels_shared", {
  path: text("path").primaryKey(),
  sha: text("sha").notNull(),
  source: text("source").notNull(),
  syncedAt: text("synced_at").notNull(),
});

export const findings = sqliteTable("findings", {
  id: integer("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  checkName: text("check_name").notNull(),
  message: text("message").notNull(),
  line: integer("line"),
  excerpt: text("excerpt"),
  fingerprint: text("fingerprint").notNull(),
  status: text("status", { enum: ["open", "dismissed"] }).notNull().default("open"),
  dismissedBy: integer("dismissed_by").references(() => people.id),
  dismissedAt: text("dismissed_at"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export const authorship = sqliteTable("authorship", {
  id: text("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  personId: integer("person_id").notNull().references(() => people.id),
  client: text("client"),
  wordsAdded: integer("words_added").notNull(),
  wordsRemoved: integer("words_removed").notNull(),
  versionBefore: text("version_before"),
  versionAfter: text("version_after").notNull(),
  commitSha: text("commit_sha").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export const googleKeysSeen = sqliteTable("google_keys_seen", {
  privateKeyId: text("private_key_id").primaryKey(),
  clientEmail: text("client_email").notNull(),
  firstSeenAt: text("first_seen_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export const googleTokens = sqliteTable("google_tokens", {
  personId: integer("person_id").primaryKey().references(() => people.id, { onDelete: "cascade" }),
  refreshToken: text("refresh_token").notNull(),
  iv: text("iv").notNull(),
  scope: text("scope").notNull(),
  connectedAt: text("connected_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  lastError: text("last_error"),
});

export const googleOauthStates = sqliteTable("google_oauth_states", {
  state: text("state").primaryKey(),
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export const manuscripts = sqliteTable("manuscripts", {
  fileId: text("file_id").primaryKey(),
  name: text("name").notNull(),
  mimeType: text("mime_type").notNull(),
  webViewLink: text("web_view_link").notNull(),
  folder: text("folder").notNull().default(""),
  people: text("people").notNull().default("[]"),
  createdTime: text("created_time"),
  modifiedTime: text("modified_time"),
  syncedAt: text("synced_at").notNull(),
});

export const sentDocs = sqliteTable("sent_docs", {
  id: integer("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  itemId: text("item_id").notNull(),
  personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
  docId: text("doc_id").notNull(),
  docUrl: text("doc_url").notNull(),
  frontmatter: text("frontmatter").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export const searchConsolePages = sqliteTable(
  "search_console_pages",
  {
    projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    page: text("page").notNull(),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    ctr: real("ctr").notNull(),
    position: real("position").notNull(),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.page] })],
);
