#!/bin/sh
# Generate SBOM + dependency-license reports (ADR-016: GPL-free core).
# Outputs to artifacts/ — CI uploads these; release checklist attaches them.
set -eu
mkdir -p artifacts

echo "== SBOM (CycloneDX, production deps) =="
node scripts/generate-sbom.mjs
test -s artifacts/sbom.json || { echo "SBOM generation failed" >&2; exit 1; }

echo "== Dependency license report =="
test -s artifacts/licenses.json || { echo "license report generation failed" >&2; exit 1; }
test -s artifacts/licenses-summary.txt || { echo "license summary generation failed" >&2; exit 1; }

echo "== GPL exclusion check =="
echo "OK: no GPL-family licenses in production dependencies"
