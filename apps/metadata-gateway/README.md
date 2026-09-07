# Metadata gateway

This Cloudflare Worker supplies Tantalar's default TMDB access. It exposes only the routes used by the metadata plugin, validates all path and query values, caches successful JSON responses, and applies a per-IP request ceiling.

## Local use

Create `.dev.vars` with either a TMDB v3 API key or v4 API read token:

```dotenv
TMDB_API_TOKEN="replace-me"
```

Then run `pnpm dev` in this directory. `.dev.vars` is ignored by Git.

## Production setup

Set the credential with `wrangler secret put TMDB_API_TOKEN`, then deploy only after Tantalar's TMDB application, attribution, domain, and Cloudflare account are ready. The repository does not contain the credential.
