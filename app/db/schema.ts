// Mirrors drizzle/0001_init.sql and 0002_site_content.sql, which own the shape. Change both in the
// same commit. The FTS5 table site_items_fts has no mirror: only index.server.ts touches it, in SQL.

import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const people = sqliteTable("people", {
  id: integer("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  isOwner: integer("is_owner", { mode: "boolean" }).notNull().default(false),
  disabledAt: text("disabled_at"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  site: text("site"),
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
});
