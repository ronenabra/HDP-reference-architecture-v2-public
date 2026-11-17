#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE=${SCRIPT_DIR}/compose.matrix.yaml
PROJECT_NAME=pcm-hapi-matrix-$$
BASE_URL=http://127.0.0.1:${PCM_HAPI_MATRIX_PORT:-19080}/fhir
RESULTS=${SCRIPT_DIR}/compatibility-results.txt

compose() {
  docker compose --project-name "${PROJECT_NAME}" --file "${COMPOSE_FILE}" "$@"
}

cleanup() {
  compose --profile baseline --profile secure down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

wait_for_status() {
  expected=$1
  attempts=0
  while [ "${attempts}" -lt 120 ]; do
    status=$(curl --silent --output /dev/null --write-out '%{http_code}' "${BASE_URL}/metadata" || true)
    if [ "${status}" = "${expected}" ]; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 2
  done
  compose logs --tail=200
  echo "Timed out waiting for HTTP ${expected}" >&2
  return 1
}

json_request() {
  method=$1
  path=$2
  body=$3
  curl --fail --silent --show-error \
    --request "${method}" \
    --header 'Content-Type: application/fhir+json' \
    --header 'Accept: application/fhir+json' \
    --data "${body}" \
    "${BASE_URL}${path}"
}

assert_json() {
  expression=$1
  value=$2
  printf '%s' "${value}" | jq --exit-status "${expression}" >/dev/null
}

: > "${RESULTS}"
compose --profile baseline up --detach postgres baseline
wait_for_status 200

patient='{"resourceType":"Patient","id":"p1","identifier":[{"system":"http://example.test/mrn","value":"123"}],"name":[{"family":"Sandbox"}]}'
practitioner='{"resourceType":"Practitioner","id":"pr1","name":[{"family":"Clinician"}]}'
observation1='{"resourceType":"Observation","id":"obs1","status":"final","code":{"coding":[{"system":"http://loinc.org","code":"718-7"}]},"subject":{"reference":"Patient/p1"},"performer":[{"reference":"Practitioner/pr1"}],"effectiveDateTime":"2026-01-02T00:00:00Z","meta":{"security":[{"system":"http://example.test/security","code":"normal"}]}}'
observation2='{"resourceType":"Observation","id":"obs2","status":"preliminary","code":{"coding":[{"system":"http://loinc.org","code":"8867-4"}]},"subject":{"reference":"Patient/p1"},"effectiveDateTime":"2026-02-03T00:00:00Z","meta":{"security":[{"system":"http://example.test/security","code":"restricted"}]}}'

json_request PUT /Patient/p1 "${patient}" >/dev/null
json_request PUT /Practitioner/pr1 "${practitioner}" >/dev/null
json_request PUT /Observation/obs1 "${observation1}" >/dev/null
json_request PUT /Observation/obs2 "${observation2}" >/dev/null

read_result=$(curl --fail --silent "${BASE_URL}/Patient/p1")
assert_json '.resourceType == "Patient" and .id == "p1"' "${read_result}"
echo 'PASS create/read' >> "${RESULTS}"

search_result=$(curl --fail --silent "${BASE_URL}/Observation?subject=Patient%2Fp1&status=final")
assert_json '.entry | length == 1' "${search_result}"
echo 'PASS conjunctive search' >> "${RESULTS}"

include_result=$(curl --fail --silent "${BASE_URL}/Observation?_id=obs1&_include=Observation%3Aperformer")
assert_json '[.entry[].resource.resourceType] | sort == ["Observation","Practitioner"]' "${include_result}"
revinclude_result=$(curl --fail --silent "${BASE_URL}/Patient?_id=p1&_revinclude=Observation%3Asubject")
assert_json '[.entry[].resource.resourceType] | index("Observation") != null' "${revinclude_result}"
echo 'PASS include/revinclude' >> "${RESULTS}"

updated=$(printf '%s' "${observation1}" | jq -c '.status="amended"')
json_request PUT /Observation/obs1 "${updated}" >/dev/null
history_result=$(curl --fail --silent "${BASE_URL}/Observation/obs1/_history")
assert_json '.entry | length >= 2' "${history_result}"
vread_result=$(curl --fail --silent "${BASE_URL}/Observation/obs1/_history/1")
assert_json '.status == "final"' "${vread_result}"
echo 'PASS history/vread' >> "${RESULTS}"

page_result=$(curl --fail --silent "${BASE_URL}/Observation?_count=1")
assert_json '.entry | length == 1' "${page_result}"
assert_json '[.link[] | select(.relation == "next")] | length == 1' "${page_result}"
assert_json '[.link[].url] | all(startswith("https://ho-a.example/fhir"))' "${page_result}"
echo 'PASS native paging/external base URLs' >> "${RESULTS}"

count_result=$(curl --fail --silent "${BASE_URL}/Observation?_summary=count")
assert_json '.total == 2 and ((.entry // []) | length == 0)' "${count_result}"
echo 'PASS count-only search' >> "${RESULTS}"

invalid='{"resourceType":"Observation","code":{"text":"missing mandatory status"}}'
invalid_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST --header 'Content-Type: application/fhir+json' --data "${invalid}" "${BASE_URL}/Observation")
case "${invalid_status}" in 400|422) ;; *) echo "validation expected 400/422, got ${invalid_status}" >&2; exit 1;; esac
echo 'PASS request validation' >> "${RESULTS}"

compose stop baseline
compose --profile baseline up --detach baseline
wait_for_status 200
persisted=$(curl --fail --silent "${BASE_URL}/Patient/p1")
assert_json '.id == "p1"' "${persisted}"
echo 'PASS PostgreSQL persistence across application restart' >> "${RESULTS}"

compose stop baseline
compose --profile secure up --detach --no-build secure
wait_for_status 200
deny_status=$(curl --silent --output /dev/null --write-out '%{http_code}' "${BASE_URL}/Patient/p1")
[ "${deny_status}" = 403 ]
echo 'PASS custom distribution default deny' >> "${RESULTS}"

echo 'STRICT FOUNDATION MATRIX PASS' >> "${RESULTS}"
cat "${RESULTS}"
