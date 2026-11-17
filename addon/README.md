# The Docs panel

Carrel's add-on in Google Docs (the Docs plan, slice 6): a side panel where Dustin writes a request, picks what Carrel
does (suggest edits, write new text, review and comment, or write directly) and sends it with the words he selected.
Carrel does the job with its own engine, the model and effort set on Desk's AI page, through the same Docs functions
every AI uses. Carrel's end is `app/lib/google/panel.server.ts`, at `/docs-panel` on the AI door's host.

It is installed in Dustin's account alone, never published. `appsscript.json` and `Code.gs` are the whole add-on.

## Setup

1. An Apps Script project with these two files, tied to the Google Cloud project that holds Carrel's service account.
2. A test deployment of it as a Google Workspace add-on, installed for Dustin.
3. The first request from the panel answers with the add-on's client id when Carrel does not know it yet; set that id
   as the `GOOGLE_PANEL_CLIENT_ID` variable on the Worker. It is not a secret.

The Doc must be in the manuscripts index (or a Carrel folder) for Carrel to work in it, as for every AI.
