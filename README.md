# bexio-oauth

[![npm version](https://img.shields.io/npm/v/@soulcode/bexio-oauth?logo=npm&color=cb3837)](https://www.npmjs.com/package/@soulcode/bexio-oauth)
[![CI](https://img.shields.io/github/actions/workflow/status/SoulcodeAgency/bexio-oauth/ci.yml?branch=main&logo=github&label=CI)](https://github.com/SoulcodeAgency/bexio-oauth/actions/workflows/ci.yml)
[![CodeQL](https://img.shields.io/github/actions/workflow/status/SoulcodeAgency/bexio-oauth/codeql.yml?branch=main&logo=github&label=CodeQL)](https://github.com/SoulcodeAgency/bexio-oauth/actions/workflows/codeql.yml)
[![Node](https://img.shields.io/node/v/@soulcode/bexio-oauth?logo=nodedotjs&logoColor=white&color=5fa04e)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/types-included-3178c6?logo=typescript&logoColor=white)](packages/bexio-oauth/src)
[![License: MIT](https://img.shields.io/npm/l/@soulcode/bexio-oauth?color=blue)](LICENSE)

Let your users connect their Bexio account once, then call the Bexio API whenever you need to: in a request, a cron job or a queue worker. `@soulcode/bexio-oauth` runs the OAuth flow, keeps the tokens encrypted in your Postgres database and refreshes them for you.

```bash
npm install @soulcode/bexio-oauth pg
```

- [Package README](packages/bexio-oauth/README.md): install, quickstart, API at a glance.
- [Integration guide](docs/integration.md): concepts, API, database setup, security model.
- [Examples](examples/): working apps with Better Auth and Supabase Auth.
- [Development guide](docs/development.md): repo layout, tests, CI/CD.

## Contributing

Contributions are welcome: bug reports, docs fixes, new examples and code alike. For anything bigger than a small fix, please [open an issue](https://github.com/SoulcodeAgency/bexio-oauth/issues/new) first so we can agree on the approach. Setup, conventions and the PR flow are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Found a vulnerability? Please report it privately, not as a public issue. See the [security policy](SECURITY.md).

## License

[MIT](LICENSE)
