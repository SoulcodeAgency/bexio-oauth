# Security policy

This library stores OAuth refresh tokens, so we take reports seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub's [private vulnerability reporting](https://github.com/SoulcodeAgency/bexio-oauth/security/advisories/new). Include what you found, how to reproduce it, and the affected version.

We aim to acknowledge reports within 3 working days and to ship a fix for confirmed issues as a patch release.

## Supported versions

Only the latest minor release receives security fixes while the package is at 0.x.

## Scope

In scope: the published package `@soulcode/bexio-oauth` (token handling, encryption, the OAuth flow, the Postgres store). Out of scope: the example apps and the test mock under `examples/`, which are not meant for production.
