# Changelog

## [0.2.0](https://github.com/SoulcodeAgency/bexio-oauth/compare/v0.1.0...v0.2.0) (2026-10-25)


### ⚠ BREAKING CHANGES

* start() no longer takes a Request: start({ ownerId, returnTo }). refreshIdle() gains timeBudget and reports remaining; its default limit drops from 500 to 100. Both example apps and docs follow.

### Features

* harden the OAuth client and split it into modules (code audit) ([#14](https://github.com/SoulcodeAgency/bexio-oauth/issues/14)) ([41e7595](https://github.com/SoulcodeAgency/bexio-oauth/commit/41e7595c0b5cd80dc7652b1e953aee5d9ef1298b))

## 0.1.0 (2026-10-25)


### Features

* add bexio-oauth token custody library v0.1 ([#4](https://github.com/SoulcodeAgency/bexio-oauth/issues/4)) ([02e615c](https://github.com/SoulcodeAgency/bexio-oauth/commit/02e615c25666be9238c7535d2ad844dd0000be87)), closes [#3](https://github.com/SoulcodeAgency/bexio-oauth/issues/3)
