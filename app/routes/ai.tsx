// The AI switch (site-runtime ./ai-engine): which engine does Carrel's AI work, Dustin's Claude subscription or the
// Claude API. One table: everything, then a row per job with its engine and model, saved together; the monthly cap
// on API spend beside this month's spend. The quick actions (the API for a few days, draft now) sit in the head's
// menu. The Owner's alone.

import { Form, useNavigation } from "react-router";
import { PRICES } from "@dustinedwards/site-runtime/ai-engine";
import { MODEL_IDS } from "@dustinedwards/site-runtime/anthropic";
import { Table } from "capsomer/react/table";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Empty } from "capsomer/react/empty";
import { Field } from "capsomer/react/field";
import { FormMenu } from "capsomer/react/menu";
import { PageHead } from "capsomer/react/page-head";
import { Status } from "capsomer/react/status";
import { Panel } from "capsomer/react/panel";
import { Row, RowList } from "capsomer/react/row-list";
import { Select } from "capsomer/react/select";

import {
  FEATURES,
  monthSpendMicros,
  readAiModels,
  readAiSettings,
  saveAiSettings,
  usageThisMonth,
} from "~/lib/ai-engine.server";
import { drizzle } from "drizzle-orm/d1";

import { projects } from "~/db/schema";
import { writeAltText } from "~/lib/alt-text.server";
import { getEnv, getViewer } from "~/lib/context";
import { draftEpisodes } from "~/lib/episode-drafts.server";
import { readForm } from "~/lib/form.server";
import { processSocial } from "~/lib/social/queue.server";
import { routineConfig } from "~/lib/social/routine.server";

import type { Route } from "./+types/ai";

export function meta() {
  return [{ title: "AI engine · Carrel" }];
}

const ENGINES = [
  { value: "auto", label: "Automatic: subscription, the API when it is refused" },
  { value: "subscription", label: "Subscription" },
  { value: "api", label: "API" },
];

const price = (tier: keyof typeof MODEL_IDS) => {
  const p = PRICES[MODEL_IDS[tier]];
  return p ? `$${p.input} in / $${p.output} out per million tokens` : "no listed price";
};
const MODELS = [
  { value: "", label: "The job's own default" },
  { value: "fast", label: `Fast, ${MODEL_IDS.fast} (${price("fast")})` },
  { value: "standard", label: `Standard, ${MODEL_IDS.standard} (${price("standard")})` },
  { value: "deep", label: `Deep, ${MODEL_IDS.deep} (${price("deep")})` },
];

const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 2)}`;

export async function loader({ context }: Route.LoaderArgs) {
  const env = getEnv(context);
  if (!getViewer(context).isOwner) throw new Response("Not found", { status: 404 });
  const [settings, models, spent, usage] = await Promise.all([
    readAiSettings(env.DB),
    readAiModels(env.DB),
    monthSpendMicros(env.DB),
    usageThisMonth(env.DB),
  ]);
  const routine = routineConfig(env);
  const sites = (
    await drizzle(env.DB)
      .select({ slug: projects.slug, name: projects.name, site: projects.site })
      .from(projects)
      .all()
  ).filter((p) => p.site);
  return {
    sites: sites.map((p) => ({ value: p.slug, label: p.name })),
    settings,
    models,
    spent,
    usage,
    features: FEATURES.map((f) => ({ ...f })),
    // What each engine can do right now, so a setting that cannot work says so.
    routineMissing: "missing" in routine,
    apiKeyMissing: !env.ANTHROPIC_API_KEY,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const viewer = getViewer(context);
  const form = await readForm(request);
  if (!viewer.isOwner) throw new Response("Not found", { status: 404 });
  const current = await readAiSettings(env.DB);
  // The head's menu posts one "quick" value: draft now, the API for some days, or back to the settings.
  const quick = String(form.get("quick") ?? "");
  if (quick === "draft") form.set("draft-now", "1");
  else if (quick === "back") form.set("override", "0");
  else if (/^api-\d+$/.test(quick)) form.set("override", quick.slice(4));
  if (form.get("draft-now") !== null) {
    // The cron's two drafting passes, run on the spot instead of waiting for the next tick.
    const [episodes, social] = await Promise.all([
      draftEpisodes(env),
      processSocial(env, { draftNow: true }),
    ]);
    const problems = episodes.errors.length;
    return {
      done: `Episodes: ${episodes.fired.length} started${problems ? `, ${problems} failed (${episodes.errors[0]})` : ""}. Social posts: ${social.routineFired} sent to the routine, ${social.templated} from the template.`,
    };
  }
  if (form.get("alt-text") !== null) {
    const only = form.get("engine");
    const made = await writeAltText(
      env,
      viewer,
      String(form.get("site") ?? ""),
      only === "api" || only === "subscription" ? only : undefined,
    );
    return made.ok ? { done: made.message } : { problem: made.error };
  }
  if (form.get("override") !== null) {
    // "The subscription is low": the API for a few days, then back to the saved settings by itself.
    const days = Number(form.get("override"));
    const override =
      days >= 1 && days <= 31
        ? { engine: "api", until: new Date(Date.now() + days * 86_400_000).toISOString() }
        : null;
    await saveAiSettings(env.DB, viewer, {
      ...current,
      models: await readAiModels(env.DB),
      override,
    });
    return {
      done: override
        ? `Everything runs on the API until ${override.until.slice(0, 10)}.`
        : "Back to your settings.",
    };
  }
  const features: Record<string, string> = {};
  const models: Record<string, string> = {};
  for (const f of FEATURES) {
    const v = String(form.get(`feature-${f.key}`) ?? "");
    if (v) features[f.key] = v;
    const m = String(form.get(`model-${f.key}`) ?? "");
    if (m) models[f.key] = m;
  }
  const cap = Number(form.get("cap") || 0);
  await saveAiSettings(env.DB, viewer, {
    master: String(form.get("master") ?? "auto"),
    features,
    models,
    apiCapMicros: Number.isFinite(cap) ? Math.round(cap * 1_000_000) : 0,
    override: current.override,
  });
  return { done: "Saved." };
}

export default function Ai({ loaderData, actionData }: Route.ComponentProps) {
  const { sites, settings, models, spent, usage, features, routineMissing, apiKeyMissing } =
    loaderData;
  const busy = useNavigation().state !== "idle";
  const engineLabel = (v: string) => ENGINES.find((e) => e.value === v)?.label ?? v;
  return (
    <div className="app-page">
      <PageHead
        title="AI engine"
        lead="Choose whether Carrel's AI work runs on your Claude subscription or on the Claude API."
        actions={
          <FormMenu
            label="Run now"
            action="/ai"
            name="quick"
            items={[
              { label: "Draft what is waiting", value: "draft" },
              { label: "Use the API for 1 day", value: "api-1" },
              { label: "Use the API for 3 days", value: "api-3" },
              { label: "Use the API for 7 days", value: "api-7" },
              ...(settings.override ? [{ label: "Back to my settings", value: "back" }] : []),
            ]}
          />
        }
      />
      {actionData && "done" in actionData ? <Alert tone="ok">{actionData.done}</Alert> : null}
      {actionData && "problem" in actionData ? (
        <Alert tone="crit">{actionData.problem}</Alert>
      ) : null}

      <dl className="app-engine-status" aria-label="What each engine can do now">
        <div>
          <dt>Subscription</dt>
          <dd>
            {routineMissing ? (
              <Status tone="warn">Not connected</Status>
            ) : (
              <Status tone="ok">Connected</Status>
            )}
          </dd>
        </div>
        <div>
          <dt>API</dt>
          <dd>
            {apiKeyMissing ? <Status tone="warn">No key</Status> : <Status tone="ok">Ready</Status>}
          </dd>
        </div>
        <div>
          <dt>Running on</dt>
          <dd>
            {settings.override
              ? `The API for everything until ${settings.override.until.slice(0, 10)}, with no cap`
              : "The settings below"}
          </dd>
        </div>
      </dl>
      {routineMissing || apiKeyMissing ? (
        <p className="cap-muted app-note">
          {routineMissing
            ? "Until the subscription's drafting routine is connected, Subscription drafts nothing (posts get the template) and Automatic uses the API. "
            : ""}
          {apiKeyMissing ? "Without an API key the API engine cannot draft anything. " : ""}
          Both are Carrel secrets, set where Carrel is deployed.
        </p>
      ) : null}

      <Form method="post" id="engine-form">
        <Panel
          title="Engine for each job"
          flush
          footer={
            <div className="app-actions">
              <Button type="submit" variant="primary" pending={busy}>
                Save
              </Button>
            </div>
          }
        >
          <Table
            caption="The engine and model for each job"
            captionHidden
            tableClassName="app-engine-table"
          >
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Engine</th>
                <th scope="col">Model when the API does it</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  Everything
                  <span className="cap-muted app-outliner-chapter">
                    Each job follows this unless it says otherwise.
                  </span>
                </th>
                <td>
                  <Select
                    name="master"
                    aria-label="Engine for everything"
                    defaultValue={settings.master}
                    options={ENGINES}
                  />
                </td>
                <td className="cap-muted">Each job's own</td>
              </tr>
              {features.map((f) => (
                <tr key={f.key}>
                  <th scope="row">
                    {f.label}
                    {f.note ? (
                      <span className="cap-muted app-outliner-chapter">{f.note}</span>
                    ) : null}
                  </th>
                  <td>
                    <Select
                      name={`feature-${f.key}`}
                      aria-label={`${f.label}: engine`}
                      defaultValue={settings.features[f.key] ?? ""}
                      options={[
                        {
                          value: "",
                          label: `Follow everything (${engineLabel(settings.master).split(":")[0]})`,
                        },
                        ...ENGINES,
                      ]}
                    />
                  </td>
                  <td>
                    <Select
                      name={`model-${f.key}`}
                      aria-label={`${f.label}: model when the API does it`}
                      defaultValue={models[f.key] ?? ""}
                      options={MODELS}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      </Form>

      <div className="app-split" data-aside data-even>
        <Panel title="API spend this month" src={`${dollars(spent)} so far`}>
          <div className="app-stack" data-tight>
            <Field
              label="Cap a month, $"
              help="At the cap the API closes: Subscription is used instead, and Automatic stops falling back. 0 is no cap. Using the API for a few days lifts it until then. Saved with the table."
            >
              <input
                className="cap-input"
                name="cap"
                form="engine-form"
                type="number"
                min={0}
                step="0.01"
                defaultValue={(settings.apiCapMicros / 1_000_000).toFixed(2)}
              />
            </Field>
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
              Costs are Anthropic's list prices times the tokens each call used. The subscription
              has no meter Carrel can read; claude.ai/settings/usage shows it.
            </p>
          </div>
        </Panel>
        <Panel title="Alt text" src="Pictures without it">
          <Form method="post" className="app-stack" data-tight>
            <Field label="Site">
              <Select name="site" options={sites} />
            </Field>
            <Field label="Engine for this run">
              <Select
                name="engine"
                options={[
                  { value: "", label: "Use the setting" },
                  { value: "api", label: "Run it on the API" },
                  { value: "subscription", label: "Run it on the subscription" },
                ]}
              />
            </Field>
            <div className="app-actions">
              <Button type="submit" name="alt-text" value="1" pending={busy}>
                Write the missing alt text
              </Button>
            </div>
            <p className="cap-muted app-note">It sets alt only on files that have none.</p>
          </Form>
        </Panel>
      </div>
    </div>
  );
}
