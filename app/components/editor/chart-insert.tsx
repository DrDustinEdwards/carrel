// "Insert chart" (E2): a chart from data Dustin pastes or picks from a CSV file, written as the site's
// `:::chart` block. He picks the type and the columns and writes the title and the finding; the dialog
// lists what the chart check would flag (E4), offers a finding drafted from the data (E5) that goes in
// only when he takes it, and shows the chart as the site renders it, in a sandboxed frame, before
// anything is in the post. The block goes in at the cursor, as "Insert from library" puts a figure.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "capsomer/react/button";
import { Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "capsomer/react/dialog";
import { Check, Field } from "capsomer/react/field";
import { Segmented } from "capsomer/react/segmented";
import { Select } from "capsomer/react/select";

import { CHART_KINDS, chartBlock, csvColumns, type ChartKind } from "~/lib/chart-block";
import type { ChartFinding } from "~/lib/chart-check";

// Larger than any chart a post should inline; Prelum and Enarratio set their own limits under it.
const MAX_CSV_BYTES = 200 * 1024;
const NOT_READY = "Add the data, pick the columns and write the finding first.";

export type ChartPreview = {
  /** The preview route that renders posted text through the site. */
  action: string;
  /** The text to preview: the post's frontmatter with the chart as its body. */
  source: (block: string) => string;
};

export function ChartInsert({ preview, onInsert }: { preview: ChartPreview; onInsert: (block: string) => void }) {
  const [open, setOpen] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [type, setType] = useState<ChartKind>("bar");
  const [csv, setCsv] = useState("");
  const [fileError, setFileError] = useState("");
  const [x, setX] = useState("");
  const [y, setY] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [alt, setAlt] = useState("");
  const [caption, setCaption] = useState("");
  const [findings, setFindings] = useState<ChartFinding[] | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const frame = `chart-preview-${useId().replace(/[^a-z0-9]/gi, "")}`;

  const columns = useMemo(() => csvColumns(csv), [csv]);
  // A new header picks the first column for x and every numeric one after it for y; a choice that
  // is still a column is kept.
  useEffect(() => {
    const names = columns.map((c) => c.name);
    setX((cur) => (names.includes(cur) ? cur : (names[0] ?? "")));
    setY((cur) => {
      const kept = cur.filter((n) => names.includes(n));
      return kept.length ? kept : columns.filter((c, i) => i > 0 && c.numeric).map((c) => c.name);
    });
  }, [columns]);

  const ready = columns.length >= 2 && x !== "" && y.length > 0 && !y.includes(x);
  const block = ready ? chartBlock({ type, x, y, title, alt: alt || "A chart.", caption, csv }) : "";
  const final = ready && alt.trim() ? chartBlock({ type, x, y, title, alt, caption, csv }) : "";

  // The check and the drafted finding, on Prelum's code, loaded only once the dialog has a chart.
  useEffect(() => {
    if (!block) {
      setFindings(null);
      setSuggestion(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void import("~/lib/chart-check").then((m) => {
        if (!live) return;
        setFindings(m.checkCharts(final || block));
        setSuggestion(m.suggestFinding(block));
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [block, final]);

  const close = () => {
    setOpen(false);
    setPreviewed(false);
  };
  const reset = () => {
    setType("bar");
    setCsv("");
    setFileError("");
    setTitle("");
    setAlt("");
    setCaption("");
  };

  async function readFile(file: File | undefined) {
    setFileError("");
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) return setFileError(`${file.name} is ${Math.ceil(file.size / 1024)} KB; a chart's data must be under ${MAX_CSV_BYTES / 1024} KB.`);
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") return setFileError(`${file.name} is not a CSV file.`);
    setCsv(await file.text());
  }

  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        onClick={(event) => {
          setOpener(event.currentTarget);
          setOpen(true);
        }}
      >
        Insert chart
      </Button>
      <Dialog open={open} onOpenChange={(o) => !o && close()} placement="center" size="lg" returnTo={opener} aria-labelledby="chart-insert-title">
        <DialogHeader divider>
          <DialogTitle id="chart-insert-title">Insert a chart</DialogTitle>
          <DialogDescription>Paste the data or choose a CSV file, pick the type and the columns, then write its title and finding. Nothing is in the post until you insert it.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="app-stack">
            <Segmented legend="Chart type" size="sm" value={type} onChange={setType} options={CHART_KINDS.map((k) => ({ value: k.value, label: k.label }))} />
            <Field label="Data, as CSV" help="The first line names the columns. Paste it here, or choose a file below." required>
              <textarea className="cap-input app-chart-csv" rows={6} spellCheck={false} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"year,visits\n2024,1204\n2025,1530"} />
            </Field>
            <Field label="Or choose a CSV file" error={fileError || undefined}>
              <input className="cap-input" type="file" accept=".csv,text/csv" onChange={(e) => void readFile(e.target.files?.[0])} />
            </Field>
            {columns.length >= 2 ? (
              <>
                <Field label="Along the bottom (x)" required>
                  <Select size="sm" value={x} onChange={(e) => setX(e.target.value)} options={columns.map((c) => ({ value: c.name, label: c.name }))} />
                </Field>
                <fieldset className="app-chart-y">
                  <legend>Measured (y), one series each</legend>
                  {columns
                    .filter((c) => c.name !== x)
                    .map((c) => (
                      <Check
                        key={c.name}
                        label={c.numeric ? c.name : `${c.name} (not all numbers)`}
                        checked={y.includes(c.name)}
                        onChange={(e) => setY((cur) => (e.target.checked ? [...cur, c.name] : cur.filter((n) => n !== c.name)))}
                      />
                    ))}
                </fieldset>
              </>
            ) : csv.trim() ? (
              <p className="app-note">The data needs a header line and at least two columns.</p>
            ) : null}
            <Field label="Title" help="What the chart is about, shown above it.">
              <input className="cap-input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Finding" required help="What the reader should see in it, in a sentence. It is shown under the title and read out in place of the chart.">
              <textarea className="cap-input" rows={2} value={alt} onChange={(e) => setAlt(e.target.value)} />
            </Field>
            {suggestion ? (
              <div className="app-chart-suggestion" role="group" aria-label="Suggested finding">
                <p className="app-note">
                  Drafted from the data: <q>{suggestion}</q>
                </p>
                <Button size="sm" variant="quiet" onClick={() => setAlt(suggestion)}>
                  Use as the finding
                </Button>
              </div>
            ) : null}
            <Field label="Caption" help="Optional. Shown under the chart.">
              <input className="cap-input" value={caption} onChange={(e) => setCaption(e.target.value)} />
            </Field>
            {findings?.length ? (
              <div role="status">
                <p className="app-note">The chart check flags:</p>
                <ul className="app-chart-findings">
                  {findings.map((f, i) => (
                    <li key={i}>{f.message}</li>
                  ))}
                </ul>
              </div>
            ) : findings ? (
              <p className="app-note" role="status">
                The chart check flags nothing.
              </p>
            ) : null}
            <form ref={form} method="post" action={preview.action} target={frame} onSubmit={() => setPreviewed(true)}>
              <input type="hidden" name="source" value={final ? preview.source(final) : ""} />
              <Button type="submit" size="sm" variant="quiet" disabledReason={final ? undefined : NOT_READY}>
                Preview as the site shows it
              </Button>
            </form>
            {/* Sandboxed with no permissions, as the editor's own preview is. */}
            <iframe className="app-chart-preview" name={frame} title="The chart as the site renders it" sandbox="" hidden={!previewed} />
          </div>
        </DialogBody>
        <DialogFooter align="between">
          <DialogClose part="cancel">Cancel</DialogClose>
          <Button
            disabledReason={final ? undefined : NOT_READY}
            onClick={() => {
              onInsert(final);
              reset();
              close();
            }}
          >
            Insert chart
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
