// The co-editing room's suggestions and comments, as an inspector tab: the post editor and the book file
// editor put it in the same place. Outside a room there is nothing to show, so the tab is left out.

import type { InspectorTab } from "capsomer/react/inspector";
import type { ReactNode } from "react";

export function commentsTab(panels: ReactNode): InspectorTab {
  return {
    value: "comments",
    label: "Comments",
    content: panels ? (
      <div className="cap-stack" data-gap="6">
        {panels}
      </div>
    ) : null,
  };
}
