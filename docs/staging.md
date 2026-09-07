# Staging deployment

Staging covers the marketing site, self-hosted application, and metadata Worker.
Both GitHub staging environments exist and permit only the `staging` branch.
The marketing and metadata Workers are live. Tunnel, Access, and CI credentials are provisioned.
The first application deployment and complete GitHub workflow acceptance are pending.

| Part | Source | Staging target |
| --- | --- | --- |
| Marketing | `nerkza/tantalar_web`, branch `staging` | Worker `tantalar-web-staging`, `staging.tantalar.app` |
| Application | `nerkza/tantalar`, branch `staging` | Scaleway VPS, `app-staging.tantalar.app`, Tunnel and Access |
| Metadata | `nerkza/tantalar`, branch `staging` | Worker `tantalar-metadata-staging`, `metadata-staging.tantalar.app` |

Production remains on its existing configuration. This change does not add production deployment triggers.

## Deployment flow

The marketing workflow runs its build and browser tests before staging deployment.
It adds staging-only crawler exclusions. See `tantalar_web/DEPLOYMENT.md`.

Application CI runs the existing checks, license gate, dependency audit, and Docker smoke test.
It publishes the tested image to GHCR with the source commit in its tag.
The metadata workflow deploys first and checks a real TMDB configuration request.
The application job then sends the Compose configuration to the VPS and deploys the immutable image digest.

Deployments are serial for each target. Each job checks the latest staging branch commit before deployment.
An older run skips deployment when a newer commit exists.

The VPS script backs up a running staging database before replacement.
It waits for container health, checks readiness, and verifies the running source commit.
A failed check fails the workflow. It does not restore a database automatically.

## Resource isolation

- Compose project: `tantalar-staging`.
- Data volume: `tantalar-staging_staging-data`.
- Application port: `127.0.0.1:8791`; no public origin port.
- Application configuration: `docker/staging.yaml`, mounted read-only.
- Metadata URL: `https://metadata-staging.tantalar.app/v1/tmdb`.
- Metadata rate-limit namespace: `2026090701`, separate from production.
- Metadata secret: staging Worker's own `TMDB_API_TOKEN`.
- Tunnel: a dedicated remotely managed `tantalar-staging` tunnel.

Use synthetic data and test accounts. Do not mount production media, databases, or download directories.
Do not configure a personal TMDB override on staging; that override bypasses the staging gateway.
The standard image includes FFmpeg. PAR2 and full archive extraction require separately supplied tools, as documented in `deploy.md`.

## Provisioned infrastructure

### Cloudflare

Use Lewis's account: `8a7e656cee230b4e541ab2caa3ff382e`.

- Dedicated Tunnel: `tantalar-staging`, ID `0b07e2bc-e7e3-4b8b-aa6a-3972acd709b0`.
- Human Access: `app-staging.tantalar.app`, email allowlist `lewis@cookson.xyz`, one-time PIN.
- Application origin: `http://127.0.0.1:8791` through the host-networked connector.
- Deployment Access: `ssh-staging.tantalar.app`, service-token-only policy, origin `ssh://127.0.0.1:22`.
- Both ingress rules require Access token validation with their own application audiences.
- Tunnel token: `/srv/tantalar-staging/secrets/tunnel-token`, UID `65532`, mode `0400`, parent root-only.
- `TMDB_API_TOKEN` is installed on the staging metadata Worker. A real configuration request passed.
- CI Access service token expires on 7 September 2027. Rotate its two GitHub secrets before expiry.

The metadata endpoint uses the existing public, rate-limited gateway model. Browser-only Access would block its server-side caller.
Marketing staging is public with `noindex`. Add Access separately if marketing previews need restricted access.
Both staging Workers disable `workers.dev` and preview URLs.

### VPS

Target: `scaleway-start9`. Do not use the frozen OVH host.
The read-only inspection found 836 GiB free on `/data`, about 27 GiB available RAM, and port `8791` unused.
Docker Compose v5.5.0 validated the staging configuration. The dedicated cloudflared connector is running.

`/srv/tantalar-staging/releases` belongs to the dedicated `tantalar-staging` user with Docker access.
Keep `/srv` and Docker storage on the existing `/data` filesystem.
A dedicated restricted SSH key is authorized. GitHub holds that key and the independently verified VPS host key.
Docker access gives host-level control; use the key only for this environment.

The GitHub runner uses `cloudflared access ssh` with the dedicated service credential.
The existing VPS firewall remains unchanged. SSH and the application use outbound Tunnel connections.

The VPS must be able to pull `ghcr.io/nerkza/tantalar`.
Each deployment supplies its GitHub job token through standard input for a temporary registry login.
The deploy script removes its temporary Docker credential directory on exit.
Do not change package visibility without approval.

### GitHub

Both repositories now have a `staging` environment restricted to the `staging` branch.
The following environment settings are installed.

| Repository | Environment setting | Purpose |
| --- | --- | --- |
| Both | Secret `CLOUDFLARE_API_TOKEN` | Workers Scripts Edit on Lewis's account; Zone Read and Workers Routes Edit on `tantalar.app` |
| `tantalar` | Variable `TANTALAR_STAGING_SSH_HOST` | SSH address reachable from the runner |
| `tantalar` | Variable `TANTALAR_STAGING_SSH_USER` | Dedicated VPS deployment user |
| `tantalar` | Secret `TANTALAR_STAGING_SSH_KEY` | Deployment private key |
| `tantalar` | Secret `TANTALAR_STAGING_KNOWN_HOSTS` | Independently verified SSH host-key record |
| `tantalar` | Secrets `TANTALAR_STAGING_ACCESS_CLIENT_ID`, `TANTALAR_STAGING_ACCESS_CLIENT_SECRET` | Service credential for the SSH Access application |

Temporary Tunnel, Access, and DNS edit permissions were removed from the API token before storage in GitHub.

The Docker job uses its GitHub token to publish the image. No personal write token is required.
The reusable metadata workflow obtains its Cloudflare secret from the `staging` environment.
Do not also connect native Cloudflare Builds to these staging targets; that would create competing deployments.

## First deployment and acceptance

1. Review and commit the required source in both checkouts. Both contain substantial unpublished work.
2. Activation and first staging pushes were approved in this setup session.
3. Push the reviewed commits to `staging` in both repositories.
4. Confirm the marketing, metadata, and application workflow checks pass.
5. Confirm an unauthenticated application request reaches Access, not Tantalar setup.
6. Sign in through Access. Create a staging-only administrator and confirm movie search uses the staging gateway.
7. Verify the application version reports the deployed commit.
8. Restart staging and confirm its users and settings persist.

Never report staging as live from local dry runs alone.

## Verified locally

On 7 September 2026: eight marketing browser tests and seven staging/metadata tests passed.
Marketing build, both Worker staging dry runs, metadata type generation/typecheck, and workflow YAML/shell syntax checks passed.
The dependency update and torrent/staging checks passed: 32 tests across four files.
The dependency audit passes with one documented unreachable `ip.isPublic` advisory exception; see the torrent dependency record.
The existing VPS validated Compose configuration and runs the Tunnel connector.
The complete application CI, image publish, and live acceptance remain unrun.

## Rollback

Keep prior release directories and image digests.
For a code-only reversal, revert the commit and push it to staging after approval.
For a migration reversal, stop staging and restore its pre-upgrade database backup before starting the previous image.
Use the backup and restore procedure in `deploy.md`. Never run `docker compose down --volumes` during rollback.

## References

- [Cloudflare Worker environments](https://developers.cloudflare.com/workers/wrangler/environments/)
- [Self-hosted applications with Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [Cloudflared token-file parameter](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/run-parameters/#token-file)
