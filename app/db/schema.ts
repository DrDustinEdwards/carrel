// Mirrors drizzle/0001_init.sql to 0013_book_moves.sql, which own the shape. Change both in the
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
  // Media actions since migration 0007: item_id is then the site's media id, and a file has no version.
  // content-delete since migration 0009: item_id is the post's id, version_before the version deleted, version_after null.
  // media-alt, media-tags, media-trash and media-restore since migration 0010: version_before and version_after are the file's metadata versions.
  action: text("action", { enum: ["save", "publish", "schedule", "unpublish", "media-upload", "media-delete", "content-delete", "media-alt", "media-tags", "media-trash", "media-restore"] }).notNull(),
  versionBefore: text("version_before"),
  versionAfter: text("version_after"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  client: text("client"),
});

// Webmention decisions since migration 0011 (a table of its own: the changes table holds posts and
// files). mention_id is the site's id for the mention and is null for a sweep; status_after is null
// for a delete and a sweep; change_id is the id Carrel sent the site, so the two histories join.
const MENTION_STATUS = ["unverified", "pending", "approved", "rejected", "failed"] as const;
export const mentionDecisions = sqliteTable("mention_decisions", {
  id: integer("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  mentionId: text("mention_id"),
  personId: integer("person_id").notNull().references(() => people.id),
  action: text("action", { enum: ["approve", "reject", "delete", "sweep"] }).notNull(),
  statusBefore: text("status_before", { enum: MENTION_STATUS }),
  statusAfter: text("status_after", { enum: MENTION_STATUS }),
  changeId: text("change_id").notNull().unique(),
  client: text("client"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// The MCP call log (0012_mcp_calls.sql): one row per tool call, append-only (triggers refuse UPDATE
// and DELETE). No foreign key on the person, so the record outlives them.
export const mcpCalls = sqliteTable("mcp_calls", {
  id: integer("id").primaryKey(),
  personId: integer("person_id").notNull(),
  caller: text("caller").notNull(),
  client: text("client").notNull(),
  tool: text("tool").notNull(),
  arguments: text("arguments").notNull(),
  argumentsTruncated: integer("arguments_truncated", { mode: "boolean" }).notNull().default(false),
  outcome: text("outcome", { enum: ["ok", "refused"] }).notNull(),
  result: text("result").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

// No longer written: the MCP endpoint is stateless since the SDK v2 rebuild, and the client is known
// from the OAuth grant. Kept until a migration drops it, since dropping a table is a migration.
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
  /** What the save counts toward the day: typed words only. Empty before 0012 and for an AI client's save. */
  wordsTyped: integer("words_typed"),
});

export const statusLabels = sqliteTable(
  "status_labels",
  {
    projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    label: text("label").notNull(),
    color: integer("color").notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.position] })],
);

export const writingGoals = sqliteTable(
  "writing_goals",
  {
    projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    mode: text("mode", { enum: ["daily", "deadline"] }).notNull().default("daily"),
    dailyTarget: integer("daily_target"),
    writingDays: text("writing_days").notNull().default("0123456"),
    allowNegative: integer("allow_negative", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.personId] })],
);

export const untypedWords = sqliteTable(
  "untyped_words",
  {
    projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    personId: integer("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    words: integer("words").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.personId, t.path] })],
);

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

export const socialAccounts = sqliteTable("social_accounts", {
  id: integer("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  platform: text("platform", { enum: ["bluesky", "x"] }).notNull(),
  kind: text("kind", { enum: ["personal", "brand"] }).notNull(),
  handle: text("handle").notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  mode: text("mode", { enum: ["approval", "auto"] }).notNull().default("approval"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  dailyCap: integer("daily_cap").notNull().default(3),
  minGapMinutes: integer("min_gap_minutes").notNull().default(60),
  monthlyBudgetMills: integer("monthly_budget_mills").notNull().default(0),
  template: text("template").notNull().default(""),
  voiceGuide: text("voice_guide").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export const socialRoutineRuns = sqliteTable("social_routine_runs", {
  id: integer("id").primaryKey(),
  kind: text("kind", { enum: ["batch", "nightly"] }).notNull(),
  requestedAt: text("requested_at").notNull(),
  events: text("events").notNull(),
  status: text("status", { enum: ["fired", "failed"] }).notNull(),
  sessionUrl: text("session_url"),
  error: text("error"),
});

export const socialEvents = sqliteTable("social_events", {
  id: integer("id").primaryKey(),
  accountId: integer("account_id").notNull().references(() => socialAccounts.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  itemId: text("item_id").notNull(),
  title: text("title").notNull().default(""),
  url: text("url").notNull().default(""),
  summary: text("summary").notNull().default(""),
  publishedAt: text("published_at"),
  state: text("state", { enum: ["waiting", "routine", "covered", "templated", "closed"] }).notNull().default("waiting"),
  routineRunId: integer("routine_run_id").references(() => socialRoutineRuns.id),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export const socialPosts = sqliteTable("social_posts", {
  id: integer("id").primaryKey(),
  accountId: integer("account_id").notNull().references(() => socialAccounts.id, { onDelete: "cascade" }),
  eventId: integer("event_id").notNull().references(() => socialEvents.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  source: text("source", { enum: ["predrafted", "routine", "template"] }).notNull(),
  status: text("status", { enum: ["drafted", "held", "awaiting", "queued", "sent", "by-hand", "failed", "rejected"] }).notNull(),
  lint: text("lint").notNull().default("[]"),
  createdBy: text("created_by").notNull(),
  approvedBy: integer("approved_by").references(() => people.id),
  costMills: integer("cost_mills").notNull().default(0),
  platformPostId: text("platform_post_id"),
  error: text("error"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  sentAt: text("sent_at"),
  acknowledgedAt: text("acknowledged_at"),
});

export const legalSections = sqliteTable("legal_sections", {
  key: text("key").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedBy: integer("updated_by").notNull().references(() => people.id),
});

export const bookMoves = sqliteTable("book_moves", {
  id: integer("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  changeId: text("change_id").notNull(),
  fromPath: text("from_path").notNull(),
  toPath: text("to_path").notNull(),
  commitSha: text("commit_sha").notNull(),
  personId: integer("person_id").notNull().references(() => people.id),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});
