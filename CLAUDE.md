# CLAUDE.md - carrel

Carrel is a private writing hub for articles across sites, books and manuscripts. This repo holds the app code only: no writing is stored here. Manuscripts live in the private repo DrDustinEdwards/novels.

## Before acting

- Read `carrel/core.md` in Capsid (the `capsid` MCP server, which this folder connects to as `agent:carrel-driver`). It outranks this file.
- The carrel key reads and writes the `carrel` namespace only. It cannot read `capsid/` documents such as `capsid/conventions.md`; the rules below are the ones this repo needs from them.
- The design work is Capsid job `job_38897f3599f4`. Read it before writing code.
- The carrel key cannot read the `dustinedwards` namespace. To reuse the site's editor, read the local clone at `C:\Users\email\dev\dustinedwards-info` directly.

## Rules

- Never commit `.mcp.json`: it carries the carrel driver key. It is gitignored, with `.claude/settings.local.json`.
- Never commit a key, a secret, `.dev.vars` or `.env`.
- No AI trailer on any commit or pull request.
- No em dashes.
