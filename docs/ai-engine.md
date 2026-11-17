# The AI engine switch

Carrel's AI work runs on one of two engines: Dustin's Claude subscription (a Claude Code routine) or the Claude API
(a direct call with the Worker's `ANTHROPIC_API_KEY`). The choice is site-runtime's `./ai-engine`; the page is `/ai`
(Owner only). The PR checker is not part of this; it stays on DeepSeek.

## Settings

- **Everything:** Subscription, API, or Automatic (the subscription, then the API only when the routine certainly
  started nothing). Until settings are saved it is Automatic, with the background jobs (social drafts, episode drafts,
  search description) on the API, which answers at once and is metered, and a $20 monthly API cap.
- **Per job:** each job can follow Everything or have its own engine.
- **Use the API for 1, 3 or 7 days:** an override that beats every setting until its date, for when the subscription
  runs low, and it lifts the monthly cap until then. Carrel cannot read the subscription meter (claude.ai/settings/usage is the
  only one).
- **API cap a month:** at the cap the API closes; Subscription is used instead and Automatic stops falling back.
  Every API call is recorded in `ai_usage` at Anthropic's list prices (`PRICES` in site-runtime).

## Jobs

| Job                                    | Subscription                                                                           | API                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Social post drafts                     | The routine drafts every waiting post in one run (`social/routine.server.ts`).         | `draftPostViaApi` drafts each item in the same pass.                                  |
| Germomics episode summary and chapters | The routine, once per episode transcript (`episode-drafts.server.ts`).                 | `draftEpisodeViaApi` drafts them from the transcript, once per transcript.            |
| Search description and title           | The routine writes them with `carrel_read_item` and `carrel_save_draft`.               | `suggestSeo`, from the editor's button.                                               |
| Continue my draft, suggest edits       | The routine, told to read the post or book file and store a draft with Carrel's tools. | `ai-write.server.ts`, from the editor and book file buttons, with the voice excerpts. |
| Alt text for pictures without it       | The routine lists the no-alt files and sets each alt with `carrel_set_media_alt`.      | The site's own suggester (site-api `mediaSuggester`), then the Desk's alt step.       |

Every result but alt text is an AI draft beside your text, never over it, and starts only from a button press (or, for
social and episode drafts, the schedule). Alt text sets only files that have none. After any run the editor offers the
same job on the other engine. The AI engine page also has Draft now (the episode and social passes, without sending any
post) and a model and effort per job for when the API does it: fast, standard or deep with list prices, and low, medium,
high, extra high or max. Carrel always sends the effort, the job's own default when none is picked (the API's default for
that job's tier), because the API's default differs by model. Each call records its effort, and the spend by job is split
by it.

The API's alt text calls are metered on each site (its `anthropic_call` log), so they count as calls here but add no
dollars to the cap. At 80% of the cap Carrel emails the alert address once that month.

## Setup

`npx wrangler secret put ANTHROPIC_API_KEY` on the Carrel Worker. Without it the API engine reports a missing key and
the subscription still works.

The subscription route needs the Carrel routine: a Claude Code routine with an API trigger and only the Carrel connector,
its fire URL in `SOCIAL_ROUTINE_URL` and its token in `SOCIAL_ROUTINE_TOKEN` (both `wrangler secret put`). A routine
cannot be created from a session; it is made on claude.ai/code/routines.
