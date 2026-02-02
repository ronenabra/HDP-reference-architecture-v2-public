#!/bin/bash
set -euo pipefail

CERT_DIR="$(pwd)/certs"
CA_CERT="$CERT_DIR/rootCA.crt"
CLIENT_CERT="$CERT_DIR/sp-client.crt"
CLIENT_KEY="$CERT_DIR/sp-client.key"

PCM_TOKEN_URL="https://localhost:4001/token"
PCM_FHIR_BASE="https://localhost:4001/r4"
PCM_UI_BASE="http://localhost:4000"

TOKEN_ENDPOINT_AUD="$PCM_TOKEN_URL"

if [ ! -f "$CLIENT_CERT" ] || [ ! -f "$CLIENT_KEY" ] || [ ! -f "$CA_CERT" ]; then
  echo "Missing certs. Run scripts/generate_certs.sh first."
  exit 1
fi

get_assertion() {
  TOKEN_AUD="$TOKEN_ENDPOINT_AUD" node tests/manual/test_gen_token.js
}

get_token() {
  local scope="$1"
  local resource="$2"
  local assertion
  assertion=$(get_assertion)

  curl -s \
    --cert "$CLIENT_CERT" \
    --key "$CLIENT_KEY" \
    --cacert "$CA_CERT" \
    -X POST "$PCM_TOKEN_URL" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "grant_type=client_credentials" \
    --data-urlencode "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
    --data-urlencode "client_assertion=$assertion" \
    --data-urlencode "scope=$scope" \
    --data-urlencode "resource=$resource"
}

extract_json_value() {
  local json="$1"
  local key="$2"

  if command -v jq >/dev/null 2>&1; then
    echo "$json" | jq -r --arg key "$key" '.[$key] // empty'
    return
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - <<PY
import json
import sys
try:
    data = json.loads(sys.stdin.read())
    print(data.get("$key",""))
except Exception:
    print("")
PY
    return
  fi

  echo "Missing jq or python3 for JSON parsing." >&2
  exit 1
}

echo "--- 1. Request access token (mTLS + client_assertion) ---"
TOKEN_RESPONSE=$(get_token "system/*.cruds" "$PCM_FHIR_BASE")
ACCESS_TOKEN=$(extract_json_value "$TOKEN_RESPONSE" "access_token")

if [ -z "$ACCESS_TOKEN" ]; then
  echo "Failed to obtain access token. Response:"
  echo "$TOKEN_RESPONSE"
  exit 1
fi

echo "--- 2. Create Consent (mTLS + Bearer) ---"
CONSENT_RESPONSE=$(curl -s \
  --cert "$CLIENT_CERT" \
  --key "$CLIENT_KEY" \
  --cacert "$CA_CERT" \
  -X POST "$PCM_FHIR_BASE/Consent" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/fhir+json" \
  -H "Accept: application/fhir+json" \
  -d '{
    "resourceType":"Consent",
    "status":"proposed",
    "patient":{"identifier":{"system":"http://fhir.health.gov.il/identifier/il-national-id","value":"99887766"}},
    "extension":[{"url":"http://pcm.fhir.health.gov.il/StructureDefinition/ext-pcm-service","valueReference":{"reference":"HealthcareService/service-1"}}]
  }')

CONSENT_ID=$(extract_json_value "$CONSENT_RESPONSE" "id")

if [ -z "$CONSENT_ID" ]; then
  echo "Failed to create consent. Response:"
  echo "$CONSENT_RESPONSE"
  exit 1
fi

echo "Consent ID: $CONSENT_ID"

echo "--- 3. Approve Consent via UI (no mTLS) ---"
curl -s -X POST "$PCM_UI_BASE/ui/approve/$CONSENT_ID" > /dev/null
sleep 1

echo "--- 4. Read Consent by ID (mTLS + Bearer) ---"
READ_RESPONSE=$(curl -s \
  --cert "$CLIENT_CERT" \
  --key "$CLIENT_KEY" \
  --cacert "$CA_CERT" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Accept: application/fhir+json" \
  "$PCM_FHIR_BASE/Consent/$CONSENT_ID")

if ! echo "$READ_RESPONSE" | grep -q '"resourceType":"Consent"'; then
  echo "Failed to read consent. Response:"
  echo "$READ_RESPONSE"
  exit 1
fi

echo "--- 5. Search Consents with Includes (mTLS + Bearer) ---"
SEARCH_RESPONSE=$(curl -s \
  --cert "$CLIENT_CERT" \
  --key "$CLIENT_KEY" \
  --cacert "$CA_CERT" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Accept: application/fhir+json" \
  "$PCM_FHIR_BASE/Consent?_id=$CONSENT_ID&_include=Consent:actor&_include:iterate=Organization:endpoint&_include:iterate=Organization:partof")

if ! echo "$SEARCH_RESPONSE" | grep -q '"resourceType":"Bundle"'; then
  echo "Search did not return Bundle. Response:"
  echo "$SEARCH_RESPONSE"
  exit 1
fi

echo "--- 6. Search Organizations (mTLS + Bearer) ---"
ORG_RESPONSE=$(curl -s \
  --cert "$CLIENT_CERT" \
  --key "$CLIENT_KEY" \
  --cacert "$CA_CERT" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Accept: application/fhir+json" \
  "$PCM_FHIR_BASE/Organization")

if ! echo "$ORG_RESPONSE" | grep -q '"resourceType":"Bundle"'; then
  echo "Organization search failed. Response:"
  echo "$ORG_RESPONSE"
  exit 1
fi

echo "PASS: verify_standard_ops complete."
