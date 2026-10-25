# AGENTS.md

Guidance for coding agents and contributors working on this repository.

## Project profile

- **What:** `@soulcode/bexio-oauth`, an MIT-licensed npm package for Bexio OAuth token custody (connect flow, encrypted grants in Postgres, coordinated refresh). See [docs/integration.md](docs/integration.md).
- **Layout:** npm workspaces. `packages/bexio-oauth` is the only published package; `examples/*` and `examples/_shared/*` are private.
- **Base branch:** `main`. Squash merges only; the PR title must be a Conventional Commit.
- **Tickets:** GitHub issues in this repo, referenced as `#123`.
- **Validation:** `npm run check` (format, lint, typecheck, unit + integration tests). Integration tests need `DATABASE_URL` pointing at a Postgres (see [docs/development.md](docs/development.md)). `npm run test:e2e` runs the example apps.
- **Node:** 24 (`.nvmrc`).

## Conventions

- **The integration guide is the spec.** Public behavior is defined in `docs/integration.md`; a PR that changes public behavior updates it in the same PR. `test/docs.test.ts` fails if an export is undocumented.
- **Generic by rule.** No references to specific downstream products or companies in code, docs, examples or table names. Use "user", "workspace", "your app".
- **Minimal dependencies.** Runtime dependencies are `openid-client` and `jose` only. No custom protocol or crypto code: use those libraries.
- **Single-statement store operations.** Every `GrantStore` method is one SQL statement (works through poolers and HTTP drivers).
- **Errors** are `BexioOAuthError` with a `code`; never put token values in messages or logs.
- **ADRs** (`docs/adr/`) only when the architecture departs from the design notes in `docs/integration.md` §15.

## Definition of done

- [ ] `npm run check` passes locally with `DATABASE_URL` set.
- [ ] New or changed behavior has tests at the right layer (unit, Postgres integration, or example e2e).
- [ ] `docs/integration.md` (and `docs/development.md` for CI changes) match the change.
- [ ] No product names, secrets or tokens in the diff.
- [ ] PR title is a Conventional Commit; the PR links its issue.
