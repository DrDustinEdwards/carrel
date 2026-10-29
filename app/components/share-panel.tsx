// The Owner's Share panel on a project's page: invite a coauthor by email straight onto this project
// with a role. It posts intent "share" to the page's own action, which calls shareFromForm
// (people-admin.server.ts), so the rules are the People page's. The answer stays in this panel.

import { useFetcher } from "react-router";
import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Field } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Select } from "capsomer/react/select";

import type { ShareAnswer } from "~/lib/people-admin.server";

export function SharePanel({ site }: { site: boolean }) {
  const fetcher = useFetcher<{ share?: ShareAnswer }>();
  const answer = fetcher.state === "idle" ? fetcher.data?.share : undefined;
  return (
    <Panel title="Share" src="A coauthor sees this project only. The People page lists everyone and every role.">
      {answer && !answer.ok ? (
        <Alert tone="crit" title="Not shared">
          {answer.message}
        </Alert>
      ) : answer?.ok ? (
        <Banner tone={answer.access.state === "in-step" ? "ok" : "warn"} title={`Shared with ${answer.email}.`}>
          {answer.access.state === "in-step"
            ? "Cloudflare Access lets them in now."
            : answer.access.state === "waiting"
              ? `Waiting for Cloudflare: ${answer.access.detail} Retry on the People page.`
              : "They cannot sign in until their email is allowed in Cloudflare Access by hand. The People page says where."}
        </Banner>
      ) : null}
      <fetcher.Form method="post" className="app-form">
        <input type="hidden" name="intent" value="share" />
        <div className="app-fields">
          <Field label="Email" required>
            <input className="cap-input" type="email" name="email" required autoComplete="off" />
          </Field>
          <Field label="Name" help="For someone new to Carrel. An existing person keeps their name.">
            <input className="cap-input" type="text" name="name" autoComplete="off" />
          </Field>
          <Field label="Role">
            <Select
              name="role"
              defaultValue="reader"
              options={[
                { value: "reader", label: "Reader: comments and suggests changes" },
                { value: "editor", label: "Editor: also writes and saves drafts" },
                // An Author publishes their own posts, so the role is offered on a site's project only.
                ...(site ? [{ value: "author", label: "Author: also publishes the posts they write" }] : []),
              ]}
            />
          </Field>
        </div>
        <div className="app-actions">
          <Button type="submit" variant="primary" pending={fetcher.state !== "idle"}>
            Share
          </Button>
        </div>
      </fetcher.Form>
    </Panel>
  );
}
