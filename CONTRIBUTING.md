# Contributing to mark-it

Thanks for your interest in improving mark-it! This document covers local setup,
the change workflow, and the checks a pull request is expected to pass.

## Local development

mark-it is a [Bun](https://bun.sh) workspace (`packages/*` + `apps/*`). You need
Bun ≥ 1.1.

```sh
git clone https://github.com/AndreasKoestler/mark-it.git
cd mark-it
bun install
```

Run the CLI against a file from the workspace root:

```sh
bun mark-it path/to/doc.md
```

## Before you open a pull request

Run the full check suite from the repo root and make sure it's green:

```sh
bun run typecheck   # tsc -b across the workspace
bun run test        # unit tests (vitest)
bun run test:e2e    # Playwright acceptance tests against the CLI
```

Add or update tests for any behavior you change. New behavior without a test
that would fail before your change is unlikely to be merged.

## Branch naming

Branch off `main`:

- `feat/<short-description>` — new functionality
- `fix/<short-description>` — bug fixes
- `docs/<short-description>` — documentation-only changes
- `refactor/<short-description>` — internal changes with no behavior change

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/).
Use a `type(scope): summary` subject, e.g.:

```
feat(cli): add --no-open flag to the open subcommand
fix(core): re-anchor comments when source drifts by inline markup
docs: document the SSE agent transport
```

Common scopes in this repo: `cli`, `core`, `react`, `db`, `ui`.

## Opening the pull request

1. Push your branch and open a PR against `main`.
2. Describe **what** changed and **why**; link any related issue.
3. Confirm `typecheck`, `test`, and `test:e2e` pass locally (CI runs them too).
4. Keep PRs focused — one logical change per PR is easier to review.

## Reporting bugs and requesting features

Open a [GitHub issue](https://github.com/AndreasKoestler/mark-it/issues). For anything
security-sensitive, do **not** open a public issue — see [SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
