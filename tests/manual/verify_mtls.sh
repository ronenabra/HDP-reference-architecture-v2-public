#!/usr/bin/env bash

# Verify the strict PCM transport boundary against a locally running stack.
# TLS handshake failures are checked through curl's process status; they are
# deliberately not converted into HTTP status assertions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CERTS_DIR="${PCM_TEST_CERTS_DIR:-${REPO_ROOT}/certs}"
API_URL="${PCM_API_URL:-https://localhost:4001}"
METADATA_URL="${PCM_METADATA_URL:-https://localhost:4002}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pcm-mtls-manual.XXXXXX")"
trap 'rm -rf "${TMP_DIR}"' EXIT

CA_CERT="${CERTS_DIR}/rootCA.crt"
CA_KEY="${CERTS_DIR}/rootCA.key"
TRUSTED_CERT="${CERTS_DIR}/sp-client.crt"
TRUSTED_KEY="${CERTS_DIR}/sp-client.key"
UNTRUSTED_CERT="${CERTS_DIR}/untrusted-client.crt"
UNTRUSTED_KEY="${CERTS_DIR}/untrusted-client.key"

require_file() {
    if [[ ! -r "$1" ]]; then
        echo "FAIL: required local fixture is not readable: $1" >&2
        exit 1
    fi
}

for required in "$CA_CERT" "$CA_KEY" "$TRUSTED_CERT" "$TRUSTED_KEY" \
    "$UNTRUSTED_CERT" "$UNTRUSTED_KEY"; do
    require_file "$required"
done

assert_transport_rejected() {
    local label="$1"
    shift
    local exit_code
    set +e
    curl --silent --show-error --output /dev/null --cacert "$CA_CERT" "$@"
    exit_code=$?
    set -e
    if [[ $exit_code -eq 0 ]]; then
        echo "FAIL: ${label} reached an HTTP handler" >&2
        exit 1
    fi
    echo "PASS: ${label} failed at the TLS transport boundary (curl ${exit_code})"
}

assert_http_reached() {
    local label="$1"
    local url="$2"
    local status
    status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
        --cacert "$CA_CERT" --cert "$TRUSTED_CERT" --key "$TRUSTED_KEY" "$url")"
    if [[ "$status" == "000" ]]; then
        echo "FAIL: ${label} did not reach the HTTPS handler" >&2
        exit 1
    fi
    echo "PASS: ${label} reached the HTTPS handler (HTTP ${status})"
}

openssl req -newkey rsa:2048 -nodes -keyout "${TMP_DIR}/expired.key" \
    -out "${TMP_DIR}/expired.csr" -subj '/CN=expired-client' >/dev/null 2>&1
openssl x509 -req -in "${TMP_DIR}/expired.csr" -CA "$CA_CERT" -CAkey "$CA_KEY" \
    -set_serial 9003 -days -1 -out "${TMP_DIR}/expired.crt" >/dev/null 2>&1

assert_transport_rejected "missing client certificate" "${API_URL}/r4/metadata"
assert_transport_rejected "spoofed forwarded certificate header without a certificate" \
    --header 'X-Forwarded-Client-Cert: trusted=true' "${API_URL}/r4/metadata"
assert_transport_rejected "certificate from an untrusted CA" --cert "$UNTRUSTED_CERT" \
    --key "$UNTRUSTED_KEY" "${API_URL}/r4/metadata"
assert_transport_rejected "expired trusted-CA certificate" --cert "${TMP_DIR}/expired.crt" \
    --key "${TMP_DIR}/expired.key" "${API_URL}/r4/metadata"
assert_http_reached "valid certificate on PCM FHIR listener" "${API_URL}/r4/metadata"

assert_transport_rejected "missing certificate on PCM metadata listener" \
    "${METADATA_URL}/.well-known/oauth-authorization-server"
assert_http_reached "valid certificate on PCM metadata listener" \
    "${METADATA_URL}/.well-known/oauth-authorization-server"

echo "Strict local PCM mTLS verification passed."
