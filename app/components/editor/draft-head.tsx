// The head of a page that shows one draft kept beside the person's own (routes/ai-draft.tsx, routes/transcript-draft.tsx):
// where it sits, who saved it and when, and the one step that uses it, asked once in a confirm before the form posts.

import { routerRenderLink } from "capsomer/react/link";
import { useRef, type ReactNode } from "react";
import { Form, useNavigation } from "react-router";
import { Button } from "capsomer/react/button";
import { ConfirmDialog, useConfirmAction } from "capsomer/react/confirm-dialog";
import { PageHead } from "capsomer/react/page-head";
import { Time } from "capsomer/react/time";

/** A draft's id from the route, or a 404: ids are positive whole numbers. */
export function draftIdParam(value: string | undefined): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Response("Not found", { status: 404 });
  return id;
}

type Props = {
  project: { slug: string; name: string };
  itemId: string;
  /** "AI draft" or "Transcript draft": the crumb and the start of the title. */
  kind: string;
  draft: { client: string; note: string; createdAt: string };
  /** The step that uses the draft, offered only when the person may take it. */
  use: {
    label: string;
    title: string;
    lead: string;
    action: string;
  } | null;
  /** Links after the step, ending with the way back. */
  links: ReactNode;
};

export function DraftHead({ project, itemId, kind, draft, use, links }: Props) {
  const editor = `/p/${project.slug}/e/${encodeURIComponent(itemId)}`;
  const busy = useNavigation().state !== "idle";
  const asking = useConfirmAction<true>();
  const form = useRef<HTMLFormElement>(null);
  return (
    <>
      <PageHead
        renderLink={routerRenderLink}
        crumbs={[
          { label: project.name, href: `/p/${project.slug}` },
          { label: itemId, href: editor },
          { label: kind },
        ]}
        title={`${kind} from ${draft.client}`}
        lead={
          <>
            Saved <Time at={draft.createdAt} format="exact" />
            {draft.note ? ` · ${draft.note}` : ""}
          </>
        }
        actions={
          <>
            {use ? (
              <Form method="post" ref={form}>
                <Button
                  type="submit"
                  variant="primary"
                  pending={busy}
                  onClick={(event) => {
                    event.preventDefault();
                    asking.ask(true, event.currentTarget);
                  }}
                >
                  {use.label}
                </Button>
              </Form>
            ) : null}
            {links}
          </>
        }
      />
      {use ? (
        <ConfirmDialog
          {...asking.props}
          open={asking.subject !== null}
          title={use.title}
          lead={use.lead}
          body={[]}
          action={use.action}
          perform={async () => {
            // Submitting the form itself does not press the button again, so it does not ask twice.
            form.current?.requestSubmit();
          }}
        />
      ) : null}
    </>
  );
}
