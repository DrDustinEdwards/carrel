# Coauthor accounts

A coauthor is a person with a role on one project (Dustin's ruling of 2026-10-10, point 2b). The Owner shares a project from its own page (the **Share** panel on a site's or a book's page) or from **People**. Carrel decides what a coauthor may do; Cloudflare Access decides whether they reach Desk at all.

Carrel keeps Access in step itself, through Capsid. After every change to a role or to disabled, `app/lib/access-sync.server.ts` posts Carrel's whole allow list to Capsid's `POST /ops/access-sync` with Carrel's own Capsid agent key (the secret `CAPSID_AGENT_KEY`). Capsid, the only holder of the Cloudflare token, makes the Access group pinned for the namespace `carrel` hold exactly those emails, and frees the Zero Trust seat of anyone just removed (capsid `src/access-sync.ts`, `docs/portal.md`, "The Access sync token").

The allow list is every active person with a role on at least one project. It leaves out AI agents (they use a key at the AI door), reviewers (the AI door only) and the Owner, whom Desk's own policy admits directly, so no sync can lock Dustin out.

**People** says how the last sync went: **Cloudflare Access is in step**, or **Waiting for Cloudflare** with Capsid's or Cloudflare's words and a **Retry** button. Until `CAPSID_AGENT_KEY` is set, the page shows the old steps for allowing each email by hand.

## One-time setup

Do these in order. Each step says who does it and where.

1. **Dustin: create the rule group.** In the Cloudflare dashboard, go to **Zero Trust** > **Access controls** > **Policies**, select the **Rule groups** tab, then **Add a group**, named exactly `carrel-people`. Give it one **Include** rule with the **Emails** selector and a coauthor's address (a group needs a rule; the first sync replaces it). Use only Emails rules in this group. Capsid refuses to write a group that has any other kind of include rule, because a sync would erase it.

2. **The seat: pin the group in Capsid.** Capsid's migration `0040_access_sync_groups.sql` and the secret `CF_ACCESS_SYNC_TOKEN` must already be in place (capsid `docs/portal.md`, "The Access sync token"). Get the group's id from the List Access groups endpoint, `GET https://api.cloudflare.com/client/v4/accounts/{account_id}/access/groups`, where the group named `carrel-people` carries it as `id`. Then, in the capsid folder:

   ```sh
   npx wrangler d1 execute capsid --remote --command "INSERT INTO access_sync_groups (namespace, group_id, group_name, pinned_by) VALUES ('carrel', '<group id>', 'carrel-people', 'access:<seat email>');"
   ```

   This is the insert from the migration's comment, with `carrel` and `carrel-people` in place of the lab's values. Capsid checks the group's name against `group_name` before every write, so a wrong id refuses instead of overwriting another group.

3. **The seat: let Carrel's key make the call.** `/ops/access-sync` checks the key with `checkScope(agent, { tool: "/ops/access-sync", grant: "write", namespace: "carrel" })` (capsid `src/access-sync.ts`). So the agent whose key is Carrel's `CAPSID_AGENT_KEY` needs all three of these:
   - `namespaces` holds `carrel`, or is `*`;
   - `grants` holds `write`;
   - `tools` is `*`, or a list that holds the entry `/ops/access-sync` exactly as written.

   Check with the Capsid Admin tool `capsid_admin_manage_agents`, action `list`. The key already reports to Capsid's inbox, which needs `write` on `carrel` too, so usually only `tools` can be missing. When `tools` is a list without `/ops/access-sync`, call action `update_scopes` with the agent's `name` and `tools` set to the whole current list plus `"/ops/access-sync"`. `update_scopes` replaces each axis it names, so leaving out an entry already there (such as `/ops/inbox/report`) removes it. It is admin only, audit-logged, and needs a recent sign-in from an OAuth session (capsid `docs/auth.md`). A key without the scope gets a 403, which **People** shows as "Waiting for Cloudflare: Capsid answered 403: unauthorized: ...".

4. **Dustin: let the group into Desk.** Desk (desk.dustinedwards.info) is guarded by its hostname Access application (docs/coediting.md, "Before it works on Desk"), whose Allow policy is the reusable one the Worker's Access made, `carrel - Production`. Go to **Zero Trust** > **Access controls** > **Policies** and select **Configure** on that policy. Add an **Include** rule with the **Rule group** selector and the value `carrel-people`, then **Save**. Keep the existing Include rule that admits you. Include rules are an OR, so the group adds coauthors and takes no one away.

5. **Dustin, if it is not on yet: one-time PIN.** A coauthor with no Cloudflare account signs in with a code Access emails them. Turn it on at **Zero Trust** > **Integrations** > **Identity providers** > **Add new identity provider** > **One-time PIN**.

6. **The seat: ship and sync.** In the carrel folder, run `npm run db:migrate:remote` (it applies `drizzle/0023_access_sync.sql`), then deploy. Open **People** and press **Sync now**. It should say **Cloudflare Access is in step**.

## What stays by hand

- The AI door (carrel-mcp.dustinedwards.info) has its own Access for SaaS application and its own policy, `Carrel people`. The sync does not touch it, so a coauthor who will use Carrel from Claude is still added to that policy by hand (People says so). Adding `carrel-people` to that policy too would let every coauthor reach the AI door. That needs Dustin's ruling first.
- Reviewers and AI agents are never synced.

## Where the dashboard paths come from

Read on 2026-10-29:

- developers.cloudflare.com/cloudflare-one/access-controls/policies/groups/: **Zero Trust** > **Access controls** > **Policies**, the **Rule groups** tab, **Add a group**.
- developers.cloudflare.com/workers/configuration/cloudflare-access/: Worker-level Access refuses WebSockets, so Desk uses a hostname application.
- developers.cloudflare.com/changelog/post/2025-12-03-reusable-access-policies/: a production Worker gets its own reusable policy named `<worker-name> - Production`.
- developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/ and .../policy-management/: **Zero Trust** > **Access controls** > **Applications** > **Configure** > **Policies**, and **Zero Trust** > **Access controls** > **Policies** > **Configure** > **Save**; an Include rule can admit the members of a rule group.
- developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/: the **Rule group** selector, and the List Access groups endpoint for a group's `id`.
- developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/: the One-time PIN steps.
