// The focal point of one image (components/media/detail-panel.tsx): the point a site's crops are cut
// around (site-runtime ./image, the file's `focus`). Click the picture, or move the point with the
// arrow keys, and see the crops the site may cut. The two fields are the control itself, so the form
// works without script; the picture and the previews follow them. The point and the previews are
// placed through CSS custom properties set on the element, never a style attribute in the markup.

import { useEffect, useRef, useState } from "react";
import { Form } from "react-router";
import { Button } from "capsomer/react/button";
import { Field } from "capsomer/react/field";

/** The crops shown beside the picture, as the site's uses commonly ask for them. */
const PREVIEWS = [
  { label: "Square", ratio: "1 / 1" },
  { label: "Wide", ratio: "16 / 9" },
  { label: "Tall", ratio: "4 / 5" },
];

/** "XxY" as the site stores it, as percents for the fields; the center when there is none. */
function percents(focus: string | null): { x: number; y: number } {
  const m = focus ? /^([\d.]+)x([\d.]+)$/.exec(focus) : null;
  return m ? { x: Math.round(Number(m[1]) * 1000) / 10, y: Math.round(Number(m[2]) * 1000) / 10 } : { x: 50, y: 50 };
}

const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n * 10) / 10));

/** Sets the point on an element as two custom properties, which app.css reads for the marker and the previews. */
function usePoint(point: { x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.style.setProperty("--focus-x", `${point.x}%`);
    ref.current?.style.setProperty("--focus-y", `${point.y}%`);
  }, [point.x, point.y]);
  return ref;
}

type Props = {
  id: string;
  version: string;
  src: string;
  name: string;
  focus: string | null;
  pending: boolean;
};

export function FocusPicker({ id, version, src, name, focus, pending }: Props) {
  const [point, setPoint] = useState(() => percents(focus));
  const frame = usePoint(point);
  const set = (x: number, y: number) => setPoint({ x: clamp(x), y: clamp(y) });

  return (
    <Form method="post" className="app-form" key={`focus:${id}:${version}`}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={version} />
      <fieldset className="cap-field">
        {/* Named by the disclosure it sits in (detail-panel.tsx); the legend is for a screen reader. */}
        <legend className="cap-sr-only">Focal point</legend>
        <p className="cap-field-help">The part of the picture the site keeps when it crops it to fit. Click the picture to move it. {focus ? "" : "None yet: the site guesses."}</p>
        <div className="app-focus" ref={frame}>
          <button
            type="button"
            className="app-focus-frame"
            aria-label={`Focal point of ${name}: ${point.x}% across, ${point.y}% down. Click the picture, or use the arrow keys, to move it.`}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              set(((event.clientX - box.left) / box.width) * 100, ((event.clientY - box.top) / box.height) * 100);
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 10 : 2;
              const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
              const move = moves[event.key];
              if (!move) return;
              event.preventDefault();
              set(point.x + move[0], point.y + move[1]);
            }}
          >
            <img src={src} alt="" />
            <span className="app-focus-mark" aria-hidden="true" />
          </button>
          <ul className="app-focus-previews" aria-label="How the site's crops would look">
            {PREVIEWS.map((p) => (
              <li key={p.label} data-ratio={p.ratio}>
                <img src={src} alt="" loading="lazy" />
                <span>{p.label}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="app-focus-fields">
          <Field label="From the left (%)">
            <input className="cap-input" type="number" name="x" min={0} max={100} step={0.1} value={point.x} onChange={(event) => set(Number(event.target.value), point.y)} />
          </Field>
          <Field label="From the top (%)">
            <input className="cap-input" type="number" name="y" min={0} max={100} step={0.1} value={point.y} onChange={(event) => set(point.x, Number(event.target.value))} />
          </Field>
        </div>
      </fieldset>
      <input type="hidden" name="intent" value="set-focus" />
      <div className="app-actions">
        <Button type="submit" pending={pending}>
          Save focal point
        </Button>
        {focus ? (
          <Button type="submit" name="clear" value="yes" variant="quiet">
            Clear it<span className="cap-sr-only"> and let the site guess</span>
          </Button>
        ) : null}
      </div>
    </Form>
  );
}
