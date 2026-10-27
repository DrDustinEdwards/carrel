// The panel a bulk action leaves on the posts list, the mentions list and the media library: one line
// per item, done or left as it was, with the reason. It takes focus when a result arrives.

import { Button } from "capsomer/react/button";
import { Panel } from "capsomer/react/panel";
import { Status } from "capsomer/react/status";
import { type ReactNode, useEffect, useRef } from "react";

type Outcome = { id: string | number; ok: boolean; message: string };

export function BulkResult<T extends Outcome>({
  result,
  id,
  label,
  name,
  more,
  onClear,
}: {
  result: { what: string; outcomes: T[] };
  id: string;
  label: string;
  name: (o: T) => ReactNode;
  more?: (o: T) => ReactNode;
  onClear: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.tabIndex = -1;
      el.focus();
    }
  }, [result]);
  return (
    <Panel
      title="Result"
      id={id}
      ref={ref}
      src={`${result.what}: ${result.outcomes.filter((o) => o.ok).length} of ${result.outcomes.length} done`}
      actions={
        <Button size="sm" onClick={onClear}>
          Clear this result
        </Button>
      }
    >
      <ul className="app-flags" aria-label={label}>
        {result.outcomes.map((o) => (
          <li key={o.id}>
            {o.ok ? <Status tone="ok">Done</Status> : <Status tone="crit">Left as it was</Status>}
            <span>
              {name(o)}
              <br />
              {o.message}
              {more?.(o)}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
