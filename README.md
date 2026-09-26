# carrel

Carrel: a private writing hub for articles across sites, books and manuscripts (app code only; no writing is stored here).

The design is `carrel/design.md` in Capsid. This is stage 1, the private shell: a React Router Worker that admits a request only when Cloudflare Access has signed it and its email belongs to an active person in Carrel, per-project roles, and a health check that emails on a change of state.

## Develop

```sh
npm install                  # also creates wrangler.jsonc from the example
npm run db:migrate:local
npm run seed:owner -- you@example.com "Your Name"
npm test                     # Vitest in workerd with local D1
npm run typecheck
```

Every request without a valid Access token is refused, locally too, so the app answers 403 until it runs behind Access.

## Deploy order (Carrel is never public)

1. `npx wrangler d1 create carrel`, put the id in `wrangler.jsonc`, `npm run db:migrate:remote`, `npm run seed:owner -- <email> "<name>" --remote`.
2. `npm run deploy` with no route: `workers_dev` and `preview_urls` are false, so nothing reaches the Worker yet.
3. Turn on Access for the Worker (Workers & Pages, carrel, Access, All traffic) and `npx wrangler secret put ACCESS_AUD`.
4. Uncomment `routes` in `wrangler.jsonc` and deploy again to add `carrel.dustinedwards.info`.
