#!/bin/bash
set -euo pipefail

# Keep the root demo fixtures on the same deterministic role layout as team
# environments: RSA transport certificates and separate P-256 assertion keys.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$REPO_ROOT/pcm-connectathon/scripts/generate-team-certs.js" \
  --team-id local \
  --out "$REPO_ROOT/certs" \
  --pcm-api-host localhost \
  --sp-host localhost \
  --ds-host localhost \
  --ds-fhir-host localhost
