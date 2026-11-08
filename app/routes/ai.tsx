// The AI switch (site-runtime ./ai-engine): which engine does Carrel's AI work, Dustin's Claude subscription or the
// Claude API. One setting for everything, an optional setting per job, and a monthly cap on API spend. The Owner's alone.

import { Form, useNavigation } from "react-router";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { Select } from "capsomer/react/select";

import {
  FEATURES,
  monthSpendMicros,
  readAiSettings,
  saveAiSettings,
  usageThisMonth,
} from "~/lib/ai-engine.server";
import { getEnv, getViewer } from "~/lib/context";
import { readForm } from "~/lib/form.server";

import type { Route } from "./+types/ai";

export function meta() {
  return [{ title: "AI engine · Carrel" }];
}

const ENGINES = [
  { value: "auto", label: "Automatic: subscription, the API when it is refused" },
  { value: "subscription", label: "Subscription" },
  { value: "api", label: "API" },
];

const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 2)}`;

export async function loader({ context }: Route.LoaderArgs) {
  const env = getEnv(context);
  if (!getViewer(context).isOwner) throw new Response("Not found", { status: 404 });
  const [settings, spent, usage] = await Promise.all([
    readAiSettings(env.DB),
    monthSpendMicros(env.DB),
    usageThisMonth(env.DB),
  ]);
  return { settings, spent, usage, features: FEATURES.map((f) => ({ ...f })) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const form = await readForm(request);
  const current = await readAiSettings(env.DB);
  if (form.get("override") !== null) {
    // "The subscription is low": the API for a few days, then back to the saved settings by itself.
    const days = Number(form.get("override"));
    const override =
      days >= 1 && days <= 31
        ? { engine: "api", until: new Date(Date.now() + days * 86_400_000).toISOString() }
        : null;
    await saveAiSettings(env.DB, viewer, { ...current, override });
    return {
      done: override
        ? `Everything runs on the API until ${override.until.slice(0, 10)}.`
        : "Back to your settings.",
    };
  }
  const features: Record<string, string> = {};
  for (const f of FEATURES) {
    const v = String(form.get(`feature-${f.key}`) ?? "");
    if (v) features[f.key] = v;
  }
  const cap = Number(form.get("cap") || 0);
  await saveAiSettings(env.DB, viewer, {
    master: String(form.get("master") ?? "auto"),
    features,
    apiCapMicros: Number.isFinite(cap) ? Math.round(cap * 1_000_000) : 0,
    override: current.override,
  });
  return { done: "Saved." };
}

export default function Ai({ loaderData, actionData }: Route.ComponentProps) {
  const { settings, spent, usage, features } = loaderData;
  const busy = useNavigation().state !== "idle";
  return (
    <div className="app-page">
      <PageHead
        title="AI engine"
        lead="Choose whether Carrel's AI work runs on your Claude subscription or on the Claude API."
      />
      {actionData && "done" in actionData ? <Alert tone="ok">{actionData.done}</Alert> : null}
      <Panel
        title="Subscription running low?"
        src={
          settings.override
            ? `On the API until ${settings.override.until.slice(0, 10)}`
            : "Using your settings below"
        }
      >
        <Form method="post" className="app-actions">
          {[1, 3, 7].map((d) => (
            <Button key={d} type="submit" name="override" value={d} size="sm">
              Use the API for {d} {d === 1 ? "day" : "days"}
            </Button>
          ))}
          {settings.override ? (
            <Button type="submit" name="override" value={0} size="sm">
              Back to my settings
            </Button>
          ) : null}
        </Form>
      </Panel>
      <Form method="post" className="app-form">
        <Panel title="Engine">
          <div className="app-stack">
            <Field label="Everything">
              <Select name="master" defaultValue={settings.master} options={ENGINES} />
            </Field>
            {features.map((f) => (
              <Field key={f.key} label={f.label} help={f.note}>
                <Select
                  name={`feature-${f.key}`}
                  defaultValue={settings.features[f.key] ?? ""}
                  options={[{ value: "", label: "Follow everything" }, ...ENGINES]}
                />
              </Field>
            ))}
            <Field
              label="API cap a month, $"
              help="At the cap the API closes: Subscription is used instead, and Automatic stops falling back. 0 is no cap."
            >
              <input
                className="cap-input"
                name="cap"
                type="number"
                min={0}
                step="0.01"
                defaultValue={(settings.apiCapMicros / 1_000_000).toFixed(2)}
              />
            </Field>
            <div className="app-actions">
              <Button type="submit" variant="primary" pending={busy}>
                Save
              </Button>
            </div>
          </div>
        </Panel>
      </Form>
      <Panel title="API spend this month" src={`${dollars(spent)} so far`}>
        {usage.length === 0 ? (
          <Empty kind="all-clear" flush title="Nothing spent">
            No API calls this month.
          </Empty>
        ) : (
          <RowList label="API spend by job">
            {usage.map((u) => (
              <Row
                key={u.feature}
                title={features.find((f) => f.key === u.feature)?.label ?? u.feature}
                detail={`${u.calls} calls · ${dollars(u.micros)}`}
              />
            ))}
          </RowList>
        )}
        <p className="cap-muted app-note">
          Costs are Anthropic's list prices times the tokens each call used. The subscription has no
          meter Carrel can read; claude.ai/settings/usage shows it.
        </p>
      </Panel>
    </div>
  );
}
