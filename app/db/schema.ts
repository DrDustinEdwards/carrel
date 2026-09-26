// Mirrors drizzle/0001_init.sql, which owns the shape. Change both in the same commit.

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
