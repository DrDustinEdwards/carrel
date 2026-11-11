// The writing buttons the AI switch drives: a few buttons that post a job to a route and show what came of it. The route
// (routes/ai-write.ts, routes/book.ai-write.ts) runs the job on the engine the setting names and saves an AI draft beside
// the author's text.

import { useFetcher } from "react-router";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";

export type WriteButton = { job: string; label: string };

type Answer = {
  error?: string;
  message?: string;
  href?: string | null;
  engine?: "api" | "subscription" | null;
  job?: string;
};

export function AiWriteButtons({
  action,
  buttons,
  fields,
}: {
  action: string;
  buttons: WriteButton[];
  /** Hidden fields the route needs, such as a book file's path. */
  fields?: Record<string, string>;
}) {
  const fetcher = useFetcher<Answer>();
  const busy = fetcher.state !== "idle";
  const answer = fetcher.data;
  return (
    <div className="cap-stack" data-gap="6">
      <fetcher.Form method="post" action={action} className="cap-cluster" data-gap="3">
        {Object.entries(fields ?? {}).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {buttons.map((b) => (
          <Button key={b.job} type="submit" name="job" value={b.job} size="sm" pending={busy}>
            {b.label}
          </Button>
        ))}
      </fetcher.Form>
      {answer?.job && (answer.error || answer.message) ? (
        <fetcher.Form method="post" action={action} className="cap-cluster" data-gap="3">
          {Object.entries(fields ?? {}).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <input type="hidden" name="job" value={answer.job} />
          <Button
            type="submit"
            name="engine"
            value={answer.engine === "api" ? "subscription" : "api"}
            size="sm"
            pending={busy}
          >
            {answer.engine === "api" ? "Run it on the subscription" : "Run it on the API"}
          </Button>
        </fetcher.Form>
      ) : null}
      {answer?.error ? <Alert tone="crit">{answer.error}</Alert> : null}
      {answer?.message ? (
        <Alert tone="ok">
          {answer.message}
          {answer.href ? (
            <>
              {" "}
              <a href={answer.href}>Open it</a>
            </>
          ) : null}
        </Alert>
      ) : null}
    </div>
  );
}
