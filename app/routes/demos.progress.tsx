// /demos/progress: the book page's "Today's writing" panel (components/writing/progress-panel.tsx) in Desk's
// frame, drawn with sample words, so its chart can be seen and checked live without a sign-in (devkit
// live/areas.json, area 10). The only page Desk serves before its door (workers/demo.ts): it reads no viewer,
// nothing from D1 and takes no write, and the panel's target form is left out (canEdit false).
import { Banner } from "capsomer/react/banner";
import { PageHead } from "capsomer/react/page-head";

import { Frame, type FrameData } from "~/components/frame";
import { ProgressPanel } from "~/components/writing/progress-panel";
import { sampleProgress } from "~/lib/demo/writing-sample";

import type { Route } from "./+types/demos.progress";

export function meta() {
  return [{ title: "Writing progress demo · Carrel" }, { name: "robots", content: "noindex" }];
}

export function loader() {
  return sampleProgress();
}

// The frame as a visitor sees it: no name, no Owner's views, one sample book.
const FRAME: FrameData = { name: "Sample", isOwner: false, projects: [{ slug: "sample-book", name: "Sample book", kind: "book" }] };

export default function ProgressDemo({ loaderData }: Route.ComponentProps) {
  return (
    <Frame data={FRAME}>
      <div className="app-page">
        <PageHead title="Sample book" lead="A book's page in Desk, with its writing progress." />
        <div className="app-stack">
          <Banner tone="info" title="Demo with sample data">
            This is how the page looks for a signed-in writer. The numbers are made up, and nothing here belongs to a real account.
          </Banner>
          <ProgressPanel {...loaderData} canEdit={false} titlePage="#" error={null} saved={false} />
        </div>
      </div>
    </Frame>
  );
}
