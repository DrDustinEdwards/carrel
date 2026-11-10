// The editor's inspector: everything about the text that is not the text (its details, checks, comments,
// search fields and history), in tabs beside the writing on a wide screen and in a sheet from the bottom on
// a phone, so the writing comes first everywhere. The post editor, the book file editor and the AI draft
// page use the same one, so the same tab is in the same place on each.
//
// `head` (saving and publishing) stays in the page on a phone, under the text, where it is reached by
// scrolling; only the tabs go in the sheet. One copy of the tabs is drawn at a time, so no field is twice
// in the page.

import { Button } from "capsomer/react/button";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "capsomer/react/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "capsomer/react/tabs";
import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";

export type InspectorTab = {
  value: string;
  label: string;
  /** Shown on the tab, for what needs the person: open checks, comments. */
  count?: number;
  content: ReactNode;
};

/** The co-editing room's suggestions and comments, as a tab; none outside a room. */
export function commentsTab(panels: ReactNode): InspectorTab {
  return {
    value: "comments",
    label: "Comments",
    content: panels ? <div className="app-stack">{panels}</div> : null,
  };
}

/** The width below which the inspector is a sheet; it matches the editor's grid in app.css. */
const WIDE = "(min-width: 1100px)";

function useWide(): boolean {
  // The server draws the wide layout; a phone moves the tabs into the sheet once it is live.
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

export function Inspector({
  label,
  head,
  tabs,
  defaultTab,
}: {
  /** Names the region and the sheet: "About this post". */
  label: string;
  head?: ReactNode;
  tabs: InspectorTab[];
  defaultTab?: string;
}) {
  const wide = useWide();
  const shown = tabs.filter(
    (t) => t.content !== null && t.content !== undefined && t.content !== false,
  );
  // `?tab=checks` opens on that tab (and on a phone opens the sheet): a link from Home's flags lands on the checks.
  const [params] = useSearchParams();
  const asked = shown.find((t) => t.value === params.get("tab"))?.value;
  const [tab, setTab] = useState(asked ?? defaultTab ?? shown[0]?.value ?? "");
  const [open, setOpen] = useState(asked !== undefined);
  const current = shown.some((t) => t.value === tab) ? tab : (shown[0]?.value ?? "");
  const needs = shown.reduce((n, t) => n + (t.count ?? 0), 0);

  const body = (
    <Tabs value={current} onValueChange={setTab} className="app-inspector-tabs">
      <TabsList aria-label={label} variant="line" size="sm">
        {shown.map((t) => (
          <TabsTrigger key={t.value} value={t.value} count={t.count || undefined}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {shown.map((t) => (
        <TabsContent key={t.value} value={t.value} className="app-inspector-panel">
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  );

  return (
    <aside className="app-editor-side app-inspector" aria-label={label}>
      {head}
      {wide ? (
        body
      ) : (
        <>
          <div className="app-inspector-open">
            {shown.map((t) => (
              <Button
                key={t.value}
                size="sm"
                onClick={() => {
                  setTab(t.value);
                  setOpen(true);
                }}
              >
                {t.label}
                {t.count ? <span className="app-tab-count">{t.count}</span> : null}
              </Button>
            ))}
            {needs > 0 ? <span className="cap-sr-only">{needs} need you</span> : null}
          </div>
          <Dialog
            open={open}
            onOpenChange={setOpen}
            placement="bottom"
            className="app-inspector-sheet"
            aria-label={label}
          >
            <DialogHeader>
              <DialogTitle>{label}</DialogTitle>
            </DialogHeader>
            <DialogBody>{body}</DialogBody>
          </Dialog>
        </>
      )}
    </aside>
  );
}
