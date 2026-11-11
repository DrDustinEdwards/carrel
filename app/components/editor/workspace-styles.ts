import aiJobButtonsCss from "capsomer/ai-job-buttons.css?url";
import chartBuilderCss from "capsomer/chart-builder.css?url";
import editorWorkspaceCss from "capsomer/editor-workspace.css?url";
import frontmatterFieldsCss from "capsomer/frontmatter-fields.css?url";

/** The Capsomer stylesheets of the writing workspace, which the editor and a book file link; app.css holds only what every route needs. */
export const workspaceStyles = [
  editorWorkspaceCss,
  frontmatterFieldsCss,
  chartBuilderCss,
  aiJobButtonsCss,
].map((href) => ({ rel: "stylesheet", href }));
