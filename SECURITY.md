# Security Policy

## Supported versions

Only the latest release of Tantalar receives security fixes.

## Reporting a vulnerability

Do not open a public issue for security reports.

Email security@tantalar.dev with:

- A description of the issue and its impact.
- Steps or a proof of concept to reproduce it.
- Any logs, with credentials and API keys removed.

You will get an acknowledgement within 5 business days. We aim to publish a
fix and a coordinated disclosure note within 90 days of a confirmed report.

## Scope

In scope: the server, the web UI, the plugin SDK and contract, the official
first-party plugins, and the Docker image.

Out of scope: self-inflicted misconfiguration (exposing the server without a
reverse proxy), vulnerabilities in third-party plugins not distributed here,
and denial-of-service by volume.

## Design notes

- Passwords use Argon2id; sessions are httpOnly cookies with CSRF
  double-submit protection on mutations.
- API keys are stored hashed and scoped.
- Plugins run out of process and cannot bypass the public contract.
- Serving authorization is fail-closed at a single choke point before any
  metadata, bytes, subtitles, playlists, or segments are served.
