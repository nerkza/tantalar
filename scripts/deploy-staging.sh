#!/bin/sh
# Run from the uploaded release directory on the staging VPS.
set -eu

image="${1:?usage: deploy-staging.sh image-digest commit}"
commit="${2:?usage: deploy-staging.sh image-digest commit}"
case "$image" in ghcr.io/nerkza/tantalar@sha256:*) ;; *) echo "Invalid staging image registry" >&2; exit 1 ;; esac
digest="${image#ghcr.io/nerkza/tantalar@sha256:}"
case "$digest" in *[!a-f0-9]*|'') echo "Invalid staging image digest" >&2; exit 1 ;; esac
[ "${#digest}" -eq 64 ] || { echo "Invalid staging image digest" >&2; exit 1; }
case "$commit" in *[!a-f0-9]*|'') echo "Invalid commit" >&2; exit 1 ;; esac
[ "${#commit}" -eq 40 ] || { echo "Invalid commit" >&2; exit 1; }

export TANTALAR_STAGING_IMAGE="$image"
if [ -n "${3:-}" ]; then
  DOCKER_CONFIG="$(mktemp -d)"
  export DOCKER_CONFIG
  trap 'rm -rf "$DOCKER_CONFIG"' EXIT
  docker login ghcr.io --username "$3" --password-stdin
fi
docker compose -f compose.staging.yml pull
if [ -n "$(docker compose -f compose.staging.yml ps --status running -q tantalar)" ]; then
  docker compose -f compose.staging.yml exec -T tantalar tantalar-entrypoint backup
fi
docker compose -f compose.staging.yml up -d --wait --wait-timeout 120
docker compose -f compose.staging.yml exec -T -e EXPECTED_COMMIT="$commit" tantalar node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
const origin = 'http://127.0.0.1:8790';
const ready = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(10000) });
assert.equal(ready.status, 200, 'Staging is not ready');
const response = await fetch(`${origin}/api/v1/version`, { signal: AbortSignal.timeout(10000) });
assert.equal(response.status, 200, 'Version endpoint failed');
const version = await response.json();
assert.equal(version.build.commit, process.env.EXPECTED_COMMIT, 'Wrong staging commit');
console.log(`Staging ready: ${version.build.commit}`);
JS
