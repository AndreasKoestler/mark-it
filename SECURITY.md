# Security Policy

## Supported versions

mark-it is pre-1.0. Security fixes are applied to the latest release on `main`
only. Please make sure you can reproduce an issue against the current `main`
before reporting.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately through GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Fill in the advisory form with a description, reproduction steps, and impact.

This opens a private channel visible only to the maintainers.

Please include:

- A description of the vulnerability and its impact.
- Step-by-step reproduction instructions or a proof of concept.
- The version / commit you tested against.
- Any suggested remediation, if you have one.

## What to expect

- We aim to acknowledge a report within a few days.
- We'll confirm the issue, determine its severity, and keep you updated on the fix.
- Once a fix is released, we're happy to credit you in the advisory unless you
  prefer to remain anonymous.

## Scope notes

mark-it binds its daemon to `127.0.0.1` and gates the local HTTP API with a
per-process random token advertised through a `0600`-mode discovery file under
your home directory. It is designed for local, single-machine use. Exposing the
daemon port to a network, or running it on a shared/multi-tenant host, is outside
the intended threat model — but if you find a way to bypass the localhost/token
boundary, we want to hear about it.
