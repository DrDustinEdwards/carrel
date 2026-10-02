import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  // Every page sits in the shell; the resource routes (the preview, the media API, the exports, the
  // Google redirects) render nothing of their own and stay outside it.
  layout("routes/frame.tsx", [
    index("routes/home.tsx"),
    route("p/:project", "routes/project.tsx"),
    route("p/:project/new", "routes/project.new.tsx"),
    route("p/:project/e/:item", "routes/editor.tsx"),
    route("p/:project/media", "routes/media.tsx"),
    route("p/:project/flags", "routes/project.flags.tsx"),
    route("people", "routes/people.tsx"),
    route("books/new", "routes/book.new.tsx"),
    route("b/:project", "routes/book.tsx"),
    route("b/:project/c/:chapter", "routes/book.chapter.tsx"),
    route("b/:project/f/*", "routes/book.file.tsx"),
    route("p/:project/e/:item/unpublish", "routes/unpublish.tsx"),
    route("p/:project/e/:item/ai/:id", "routes/ai-draft.tsx"),
    route("manuscripts", "routes/manuscripts.tsx"),
    route("social", "routes/social.tsx"),
  ]),
  route("p/:project/media/api", "routes/media.api.ts"),
  route("p/:project/e/:item/preview", "routes/preview.ts"),
  route("b/:project/export/:format", "routes/book.export.ts"),
  route("b/:project/authorship", "routes/book.authorship.ts"),
  route("auth/google/:step", "routes/auth.google.ts"),
] satisfies RouteConfig;
