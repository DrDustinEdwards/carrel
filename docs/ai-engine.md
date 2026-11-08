# The AI engine switch

Carrel's AI work runs on one of two engines: Dustin's Claude subscription (a Claude Code routine) or the Claude API
(a direct call with the Worker's `ANTHROPIC_API_KEY`). The choice is site-runtime's `./ai-engine`; the page is `/ai`
(Owner only). The PR checker is not part of this; it stays on DeepSeek.

## Settings

- **Everything:** Subscription, API, or Automatic (the subscription, then the API only when the routine certainly
  started nothing). Until settings are saved it is Subscription: the API spends money, so it is never the default.
- **Per job:** each job can follow Everything or have its own engine.
- **Use the API for 1, 3 or 7 days:** an override that beats every setting until its date, for when the subscription
  runs low. Carrel cannot read the subscription meter (claude.ai/settings/usage is the only one).
- **API cap a month:** at the cap the API closes; Subscription is used instead and Automatic stops falling back.
  Every API call is recorded in `ai_usage` at Anthropic's list prices (`PRICES` in site-runtime).

## Jobs

| Job | Subscription | API |
| --- | --- | --- |
| Social post drafts | The routine drafts every waiting post in one run (`social/routine.server.ts`). | `draftPostViaApi` drafts each item in the same pass. |
| Germomics episode summary and chapters | The routine, once per episode transcript (`episode-drafts.server.ts`). | `draftEpisodeViaApi` drafts them from the transcript, once per transcript. |
| Search description and title | None: ask a Claude session. | The editor's button writes them as an AI draft beside your text (`suggestSeo`). |

An API draft is saved beside your own, never over it. Only the description is written, and the search title on sites
that keep one apart from the post's title.

## Setup

`npx wrangler secret put ANTHROPIC_API_KEY` on the Carrel Worker. Without it the API engine reports a missing key and
the subscription still works.
