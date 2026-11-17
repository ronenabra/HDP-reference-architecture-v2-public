#!/bin/sh
set -eu

CONFIG_SOURCE_PATH="${TEAM_CONFIG_PATH:-/runtime/team-config.json}"
# Bind-mounted config files sometimes require an in-place writer fallback.
# Parse once into a private snapshot so revision and policy reads cannot see
# different writes or a truncated file. Never replace a working snapshot with
# a transient invalid read; the next watcher iteration retries the source.
config_snapshot_dir="$(mktemp -d "${TMPDIR:-/tmp}/pcm-gateway-config.XXXXXX")"
CONFIG_PATH="$config_snapshot_dir/team-config.json"
trap 'rm -rf "$config_snapshot_dir"' EXIT

snapshot_config() {
  if [ ! -f "$CONFIG_SOURCE_PATH" ]; then
    if [ -f "$CONFIG_PATH" ]; then
      echo "[Runtime] Config temporarily unavailable; retaining last valid gateway configuration" >&2
      return 1
    fi
    return 0 # Preserve standalone environment-only startup.
  fi
  if ! jq -e -s 'if length == 1 and (.[0] | type == "object") then .[0] else error("expected one configuration object") end' \
      "$CONFIG_SOURCE_PATH" > "$config_snapshot_dir/pending.json"; then
    echo "[Runtime] Config read incomplete or invalid; retaining last valid gateway configuration" >&2
    return 1
  fi
  mv "$config_snapshot_dir/pending.json" "$CONFIG_PATH"
}
TEMPLATE_PATH="${NGINX_TEMPLATE_PATH:-/etc/nginx/templates/pcm-connectathon.conf.template}"
OUTPUT_PATH="${NGINX_OUTPUT_PATH:-/etc/nginx/nginx.conf}"
LOG_DIR="${DS_GATEWAY_LOG_DIR:-/runtime/logs/ds-gateway}"
mkdir -p "$LOG_DIR"
# NGINX's root master opens the files; the local Admin UID must also truncate them.
if [ -n "${DS_GATEWAY_LOG_OWNER:-}" ]; then
  touch "$LOG_DIR/current.log" "$LOG_DIR/error.log"
  chown "$DS_GATEWAY_LOG_OWNER" "$LOG_DIR/current.log" "$LOG_DIR/error.log"
fi

json_value() {
  key="$1"
  fallback="$2"
  if [ -f "$CONFIG_PATH" ]; then
    jq -r "$key // \"$fallback\"" "$CONFIG_PATH"
  else
    printf '%s\n' "$fallback"
  fi
}

runtime_revision() {
  if [ -f "$CONFIG_PATH" ]; then
    jq -r '[.runtime.revision // 0, .runtime.certificateRevision // 0, .conformance.mode // "", .security.dataSourceGateway.clientAuth // "", .security.dsGatewayToFhirServer.protocol // "", .security.dsGatewayToFhirServer.verifyServerCertificate // false, .security.dsGatewayToFhirServer.customUrl // "", .securitySimulation] | @json' "$CONFIG_PATH"
  else
    printf 'missing\n'
  fi
}

render_config() {
  PCM_CONFORMANCE_MODE="$(json_value '.conformance.mode' "${PCM_CONFORMANCE_MODE:-connectathon}")"
  if [ "$PCM_CONFORMANCE_MODE" != "strict" ] && [ "$PCM_CONFORMANCE_MODE" != "connectathon" ]; then
    echo "PCM_CONFORMANCE_MODE must be strict or connectathon" >&2
    exit 1
  fi
  DS_GATEWAY_CLIENT_AUTH_MODE="$(json_value '.security.dataSourceGateway.clientAuth' "${DS_GATEWAY_CLIENT_AUTH_MODE:-mtls}")"
  DS_FHIR_UPSTREAM_PROTOCOL="$(json_value '.security.dsGatewayToFhirServer.protocol' "${DS_FHIR_UPSTREAM_PROTOCOL:-http}")"
  DS_FHIR_UPSTREAM_VERIFY_SERVER_CERTIFICATE="$(json_value '.security.dsGatewayToFhirServer.verifyServerCertificate' "${DS_FHIR_UPSTREAM_VERIFY_SERVER_CERTIFICATE:-false}")"
  DS_FHIR_UPSTREAM_CUSTOM_URL="$(json_value '.security.dsGatewayToFhirServer.customUrl' "${DS_FHIR_UPSTREAM_CUSTOM_URL:-}")"

  # Existing custom URLs need explicit migration acknowledgement before their scope changes.
  if [ -n "$DS_FHIR_UPSTREAM_CUSTOM_URL" ] && [ "$(json_value '.security.dsGatewayToFhirServer.customUrlScope' '')" != "legacy-ds" ]; then
    echo "Custom upstream migration required: acknowledge legacy-ds-only scope with reconfigure-local-team.js --acknowledge-legacy-upstream" >&2
    exit 1
  fi
  case "${HO_ID:-legacy-ds}" in
    legacy-ds|reference) ;; # retained standalone facade identity
    *) DS_FHIR_UPSTREAM_CUSTOM_URL="" ;; # managed HOs always keep their own HAPI
  esac

  # Preserve explicit false overrides; jq's // treats false as missing.
  if [ -f "$CONFIG_PATH" ]; then
    simulation_control() {
      jq -r --arg source "${HO_ID:-legacy-ds}" --arg key "$1" --arg fallback "$2" '
        (.securitySimulation.perSource[$source] // {}) as $local |
        (.securitySimulation.global // {}) as $global |
        if $local | has($key) then $local[$key]
        elif $global | has($key) then $global[$key]
        else $fallback end' "$CONFIG_PATH"
    }
    if [ "$(simulation_control publicClientMtls false)" = "true" ]; then DS_GATEWAY_CLIENT_AUTH_MODE=mtls; else DS_GATEWAY_CLIENT_AUTH_MODE=tls; fi
    DS_FHIR_UPSTREAM_VERIFY_SERVER_CERTIFICATE="$(simulation_control serverCertificateVerification "$DS_FHIR_UPSTREAM_VERIFY_SERVER_CERTIFICATE")"
  fi
  DS_BODY_LIMIT_BYTES="$(json_value '.presence.batch.maxPayloadBytes' 65536)"
  if [ -f "$CONFIG_PATH" ]; then
    DS_BODY_LIMIT_BYTES="$(jq -r --arg source "${HO_ID:-legacy-ds}" '
      (if $source == "legacy-ds" or $source == "reference" then "legacy" else $source end) as $budget |
      .presence.sources[$budget].maxPayloadBytes // .presence.batch.maxPayloadBytes // 65536' "$CONFIG_PATH")"
  fi
  export DS_BODY_LIMIT_BYTES
  export DS_GATEWAY_SSL_VERIFY_CLIENT
  export DS_FHIR_PROXY_SSL_VERIFY
  export DS_FHIR_PROXY_PASS
  export DS_HEALTH_ORGANIZATION_ID
  export DS_GATEWAY_HTTP_PORT
  DS_GATEWAY_HTTP_PORT="${DS_GATEWAY_HTTP_PORT:-8081}"
  DS_HEALTH_ORGANIZATION_ID="${HO_ID:-reference}"
  export PCM_MODE_HEADER PCM_MODE_WARNING_HEADER
  if [ "$PCM_CONFORMANCE_MODE" = "connectathon" ]; then
    PCM_MODE_HEADER="connectathon"
    # The value is substituted inside a double-quoted nginx argument, so keep
    # the RFC Warning quoted-string escaped in the generated configuration.
    PCM_MODE_WARNING_HEADER='299 pcm-sandbox \"Connectathon compatibility profile; not strict conformance evidence\"'
  else
    PCM_MODE_HEADER=""
    PCM_MODE_WARNING_HEADER=""
    if [ "$DS_GATEWAY_CLIENT_AUTH_MODE" != "mtls" ] || [ "$DS_FHIR_UPSTREAM_PROTOCOL" != "https" ] || [ "$DS_FHIR_UPSTREAM_VERIFY_SERVER_CERTIFICATE" != "true" ]; then
      echo "Strict conformance policy rejected Data Source gateway transport overrides" >&2
      exit 1
    fi
  fi

  if [ "$DS_GATEWAY_CLIENT_AUTH_MODE" = "mtls" ]; then
    DS_GATEWAY_SSL_VERIFY_CLIENT="optional"

  else
    DS_GATEWAY_SSL_VERIFY_CLIENT="off"
  fi

  if [ "$DS_FHIR_UPSTREAM_VERIFY_SERVER_CERTIFICATE" = "true" ]; then
    DS_FHIR_PROXY_SSL_VERIFY="on"
  else
    DS_FHIR_PROXY_SSL_VERIFY="off"
  fi

  if [ -n "$DS_FHIR_UPSTREAM_CUSTOM_URL" ]; then
    DS_FHIR_PROXY_PASS="${DS_FHIR_UPSTREAM_CUSTOM_URL%/}"
  else
    DS_FHIR_PROXY_PASS="${DS_FHIR_UPSTREAM_PROTOCOL}://${DS_FHIR_SERVER_HOST}:${DS_FHIR_SERVER_PORT}/fhir"
  fi

  echo "[Conformance] DS gateway mode=$PCM_CONFORMANCE_MODE policy=pcm-sandbox-policy/1"
  envsubst '$DS_BODY_LIMIT_BYTES $DS_GATEWAY_PORT $DS_GATEWAY_HTTP_PORT $DS_GATEWAY_CERT $DS_GATEWAY_KEY $ROOT_CA_CERT $DS_GATEWAY_SSL_VERIFY_CLIENT $DS_AUTH_ADAPTER_HOST $DS_AUTH_ADAPTER_PORT $DS_FHIR_PROXY_PASS $DS_FHIR_PROXY_SSL_VERIFY $DS_HEALTH_ORGANIZATION_ID $PCM_MODE_HEADER $PCM_MODE_WARNING_HEADER' < "$TEMPLATE_PATH" > "$OUTPUT_PATH"
}

snapshot_config || exit 1
render_config
nginx -g 'daemon off;' &
nginx_pid="$!"
last_revision="$(runtime_revision)"

while kill -0 "$nginx_pid" 2>/dev/null; do
  sleep 1
  if ! snapshot_config; then continue; fi
  next_revision="$(runtime_revision)"
  if [ "$next_revision" != "$last_revision" ]; then
    last_revision="$next_revision"
    echo "[Runtime] Reloading NGINX for config revision $next_revision"
    render_config
    nginx -s reload || true
  fi
done

wait "$nginx_pid"
