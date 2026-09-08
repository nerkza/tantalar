# Staging deployment

Staging covers the marketing site and metadata Worker. Lewis requested removal of self-hosted application staging on 8 September 2026.

| Part | Source | Staging target |
| --- | --- | --- |
| Marketing | `nerkza/tantalar_web`, branch `staging` | Worker `tantalar-web-staging`, `staging.tantalar.app` |
| Metadata | `nerkza/tantalar`, branch `staging` | Worker `tantalar-metadata-staging`, `metadata-staging.tantalar.app` |

## Deployment flow

Both GitHub staging environments permit only the `staging` branch.
The marketing workflow builds and tests the website before deployment. See `tantalar_web/DEPLOYMENT.md`.
Application CI retains its checks and Docker build/boot test. It no longer needs image publication or VPS deployment.
Metadata deployment requires the existing checks, license checks, and dependency audit.
The metadata workflow deploys the Worker and checks a real TMDB configuration request.
Each deployment checks the current branch commit and skips an obsolete run.

The existing browser checks remain unchanged. Main and pull requests require the full browser suite.
The staging branch requires core browser flows. Its separate full browser job remains nonblocking.

## Access and isolation

Marketing staging requires Cloudflare Access email-code login for `lewis@cookson.xyz`, with a 24-hour session.
The existing **Tantalar staging** Access application protects this hostname.
Crawler exclusions remain enabled. Both staging Workers disable `workers.dev` and preview URLs.
Production marketing at `tantalar.app` remains public.

Metadata staging uses the public, rate-limited gateway model for server calls.
Its route is `metadata-staging.tantalar.app`; its rate-limit namespace is `2026090701`.
Its `TMDB_API_TOKEN` is stored directly on the staging Worker.
Both GitHub staging environments retain `CLOUDFLARE_API_TOKEN` for Worker deployment.
Do not add native Cloudflare Builds to these targets; that creates competing deployments.

## Application staging removal — 8 September 2026

Completed:
- Removed VPS containers `tantalar-staging-tantalar-1` and `tantalar-staging-cloudflared-1`.
- Locked the `tantalar-staging` account, set its shell to `/usr/sbin/nologin`, and removed its authorized SSH key.
- Removed GitHub's four `TANTALAR_STAGING_*` secrets and two SSH variables.
- Removed the application deployment job, GHCR staging publication, Compose configuration, and deployment script from staging CI.
- Preserved metadata staging configuration and its isolation test.

Pending completion:
- Delete the dedicated `tantalar-staging` Cloudflare Tunnel, deployment Access application, and CI service token.
- Remove `app-staging.tantalar.app` from the shared Access application. Preserve marketing's hostname and policy.
- Delete application and deployment SSH DNS records.
- Database volume `tantalar-staging_staging-data` and files under `/srv/tantalar-staging` remain for recovery. Data deletion needs confirmation.

Verified: no staging application containers remain, and port 8791 has no listener.
No in-progress staging workflow existed during removal. Removed credentials prevent the old workflow from redeploying.
Six metadata and staging tests passed after the local changes.

## Releases

Application release tags, version policy, release channels, and self-hoster updates remain undecided.
Removing the VPS test installation does not publish an application release or create a production deployment trigger.

## Using staging

1. Commit the relevant changes.
2. Push the reviewed commit to the repository's `staging` branch after approval.
3. Check the GitHub Actions deployment result.
4. Open the staging address from the table above.

For rollback, revert the relevant commit and deploy it to staging after approval.
