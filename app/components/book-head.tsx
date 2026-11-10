// The head every tab of a book shares: the name, Refresh from Git, Export with its blocker, and the
// book's sections as link tabs (Manuscript, Progress, Bible and notes, Settings). Manuscript has three
// views of the same scenes (List, Outliner, Corkboard), each its own address, as a second row of links.

import { Form, useNavigation } from "react-router";
import { Link } from "capsomer/react/link";
import { Button, ButtonGroup } from "capsomer/react/button";
import { PageHead } from "capsomer/react/page-head";
import { TabsNav } from "capsomer/react/tabs";

import type { BookHeadData } from "~/lib/books.server";

export type BookSection = "manuscript" | "progress" | "bible" | "settings";
export type ManuscriptView = "list" | "outliner" | "corkboard";

const SECTIONS: { id: BookSection; label: string; path: string }[] = [
  { id: "manuscript", label: "Manuscript", path: "" },
  { id: "progress", label: "Progress", path: "/progress" },
  { id: "bible", label: "Bible and notes", path: "/bible" },
  { id: "settings", label: "Settings", path: "/settings" },
];

const VIEWS: { id: ManuscriptView; label: string; path: string }[] = [
  { id: "list", label: "List", path: "" },
  { id: "outliner", label: "Outliner", path: "/outliner" },
  { id: "corkboard", label: "Corkboard", path: "/corkboard" },
];

export function BookHead({
  book,
  section,
  view,
}: {
  book: BookHeadData;
  section: BookSection;
  view?: ManuscriptView;
}) {
  const navigation = useNavigation();
  const refreshing =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "refresh";
  const base = `/b/${book.slug}`;

  return (
    <>
      <PageHead
        title={book.name}
        lead={
          <>
            <span className="cap-mono">{book.book}/</span> in the writing repository.
          </>
        }
        actions={
          <>
            {book.connected ? (
              // Refresh lands on the scene list, which says what it read.
              <Form method="post" action={base}>
                <Button type="submit" name="intent" value="refresh" pending={refreshing}>
                  {refreshing ? "Refreshing" : "Refresh from Git"}
                </Button>
              </Form>
            ) : null}
            {book.canPublish ? (
              book.exportReady ? (
                <ButtonGroup label="Export">
                  <a className="cap-btn" href={`${base}/export/epub`}>
                    ePub
                  </a>
                  <a className="cap-btn" href={`${base}/export/docx`}>
                    Word
                  </a>
                  <a
                    className="cap-btn"
                    href={`${base}/export/print`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Print or PDF<span className="cap-sr-only"> (opens in a new tab)</span>
                  </a>
                </ButtonGroup>
              ) : (
                <Button disabledReason="Export waits until every flag is fixed or dismissed.">
                  Export
                </Button>
              )
            ) : null}
          </>
        }
      />
      <TabsNav aria-label="Sections of this book" variant="line">
        {SECTIONS.map((s) => (
          <Link
            key={s.id}
            to={base + s.path}
            className="cap-tab"
            aria-current={s.id === section ? "page" : undefined}
          >
            {s.label}
          </Link>
        ))}
      </TabsNav>
      {section === "manuscript" ? (
        <TabsNav aria-label="Views of the manuscript" size="sm" className="app-views">
          {VIEWS.map((v) => (
            <Link
              key={v.id}
              to={base + v.path}
              className="cap-tab"
              aria-current={v.id === view ? "page" : undefined}
            >
              {v.label}
            </Link>
          ))}
        </TabsNav>
      ) : null}
    </>
  );
}
