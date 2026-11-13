// The AI switch (site-runtime ./ai-engine): which engine does Carrel's AI work, Dustin's Claude subscription or the
// Claude API. Capsomer's AiEngineSettings: one table, everything then a row per job with its engine and model,
// saved together with the monthly cap on API spend, beside this month's spend. The quick actions (the API for a few days, draft now) sit in the head's
// menu. The Owner's alone.

import { Form, useNavigation } from "react-router";
import { PRICES } from "@dustinedwards/site-runtime/ai-engine";
import { MODEL_IDS } from "@dustinedwards/site-runtime/anthropic";
import { AiEngineSettings } from "capsomer/react/ai-engine-settings";
import { settingsFromForm } from "capsomer/behavior/ai-engine-settings";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Field } from "capsomer/react/field";
import { FormMenu } from "capsomer/react/menu";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Select } from "capsomer/react/select";

import {
  FEATURES,
  apiKeyMissing,
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
import "capsomer/ai-engine-settings.css";

export function meta() {
  return [{ title: "AI engine · Carrel" }];
}

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
    apiKeyMissing: apiKeyMissing(env),
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
  await saveAiSettings(env.DB, viewer, {
    ...settingsFromForm((name) => form.get(name), FEATURES),
    override: current.override,
  });
  return { done: "Saved." };
}

export default function Ai({ loaderData, actionData }: Route.ComponentProps) {
  const { sites, settings, models, spent, usage, features, routineMissing, apiKeyMissing } =
    loaderData;
  const busy = useNavigation().state !== "idle";
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

      <AiEngineSettings
        settings={settings}
        models={models}
        jobs={features}
        modelOptions={MODELS}
        ready={{ subscription: !routineMissing, api: !apiKeyMissing }}
        readyNote={
          <>
            {routineMissing
              ? "Until the subscription's drafting routine is connected, Subscription drafts nothing (posts get the template) and Automatic uses the API. "
              : ""}
            {apiKeyMissing ? "Without an API key the API engine cannot draft anything. " : ""}
            Both are Carrel secrets, set where Carrel is deployed.
          </>
        }
        spentMicros={spent}
        usage={usage.map((u) => ({ job: u.feature, calls: u.calls, micros: u.micros }))}
        capHelp="At the cap the API closes: Subscription is used instead, and Automatic stops falling back. 0 is no cap. Using the API for a few days lifts it until then. Saved with the table."
        costNote="Costs are Anthropic's list prices times the tokens each call used. The subscription has no meter Carrel can read; claude.ai/settings/usage shows it."
        Form={Form}
        pending={busy}
      />

      <Panel title="Alt text" src="Pictures without it">
        <Form method="post" className="cap-stack" data-gap="4">
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
          <div className="cap-cluster" data-gap="3">
            <Button type="submit" name="alt-text" value="1" pending={busy}>
              Write the missing alt text
            </Button>
          </div>
          <p className="cap-muted app-note">It sets alt only on files that have none.</p>
        </Form>
      </Panel>
    </div>
  );
}
