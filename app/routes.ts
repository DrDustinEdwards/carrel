import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("p/:project", "routes/project.tsx"),
  route("p/:project/new", "routes/project.new.tsx"),
  route("p/:project/e/:item", "routes/editor.tsx"),
  route("p/:project/e/:item/preview", "routes/preview.ts"),
] satisfies RouteConfig;
