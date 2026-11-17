#!/bin/bash
set -euo pipefail

CONFIG_PATH="${CONFIG_PATH:-${1:-pcm-connectathon/example-team-config.json}}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-${TEAM_ADMIN_PASSWORD:-change-me}}"

SP_BASE_URL="${SP_BASE_URL:-}"
PCM_UI_BASE_URL="${PCM_UI_BASE_URL:-}"
REFERENCE_DS_BASE_URL="${REFERENCE_DS_BASE_URL:-}"
REFERENCE_DS_HEALTH_URL="${REFERENCE_DS_HEALTH_URL:-}"

ARGS=(pcm-connectathon/scripts/run-sanity-check.js --config "$CONFIG_PATH" --admin-password "$ADMIN_PASSWORD")

if [ -n "$SP_BASE_URL" ]; then
  ARGS+=(--sp-base-url "$SP_BASE_URL")
fi
if [ -n "$PCM_UI_BASE_URL" ]; then
  ARGS+=(--pcm-ui-base-url "$PCM_UI_BASE_URL")
fi
if [ -n "$REFERENCE_DS_BASE_URL" ]; then
  ARGS+=(--reference-ds-base-url "$REFERENCE_DS_BASE_URL")
fi
if [ -n "$REFERENCE_DS_HEALTH_URL" ]; then
  ARGS+=(--reference-ds-health-url "$REFERENCE_DS_HEALTH_URL")
fi

echo "--- Running config-driven standard operations sanity check ---"
node "${ARGS[@]}"
