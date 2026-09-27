import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("p/:project", "routes/project.tsx"),
  route("p/:project/new", "routes/project.new.tsx"),
  route("p/:project/e/:item", "routes/editor.tsx"),
  route("p/:project/media", "routes/media.tsx"),
  route("p/:project/flags", "routes/project.flags.tsx"),
  route("people", "routes/people.tsx"),
  route("p/:project/media/api", "routes/media.api.ts"),
  route("p/:project/e/:item/preview", "routes/preview.ts"),
  route("books/new", "routes/book.new.tsx"),
  route("b/:project", "routes/book.tsx"),
  route("b/:project/c/:chapter", "routes/book.chapter.tsx"),
  route("b/:project/f/*", "routes/book.file.tsx"),
  route("b/:project/export/:format", "routes/book.export.ts"),
  route("b/:project/authorship", "routes/book.authorship.ts"),
  route("p/:project/e/:item/unpublish", "routes/unpublish.tsx"),
  route("p/:project/e/:item/ai/:id", "routes/ai-draft.tsx"),
  route("manuscripts", "routes/manuscripts.tsx"),
  route("auth/google/:step", "routes/auth.google.ts"),
  route("social", "routes/social.tsx"),
] satisfies RouteConfig;
