#!/bin/bash

# Function to get latest logs
get_logs() {
    docker logs sp-client --tail 50
}

echo "--- 1. Reset Environment ---"
curl -s -X POST http://localhost:3000/reset > /dev/null

echo "--- 2. Verify Untrusted Identity (mTLS Failure) ---"
echo "Requesting Consent as 'untrusted'..."
curl -s -X POST http://localhost:3000/create-consent -d "patientId=123&identity=untrusted" > /dev/null
sleep 2

# Check logs
LOGS=$(get_logs)
if echo "$LOGS" | grep -q "socket hang up\|alert unknown ca\|self signed certificate\|ECONNRESET"; then
    echo "PASS: Untrusted identity failed connection as expected."
else
    echo "FAIL: Untrusted identity did not fail as expected."
    echo "$LOGS"
fi


echo "--- 3. Verify Cross-Org Access Denial (Actor Binding) ---"
echo "Step A: Create Consent as Hospital A"
curl -s -X POST http://localhost:3000/create-consent -d "patientId=111&identity=hospital-a" > /dev/null
sleep 2

# Get Consent ID
LOGS=$(get_logs)
CONSENT_A_LOG=$(echo "$LOGS" | grep "CREATED CONSENT ID:" | grep "hospital-a" | tail -n 1)
# Extract ID: CREATED CONSENT ID: <UUID> (Identity: ...)
CONSENT_A_ID=$(echo "$CONSENT_A_LOG" | awk '{print $4}')
echo "Consent A ID: $CONSENT_A_ID"

if [ -z "$CONSENT_A_ID" ]; then
    echo "FAIL: Could not extract Consent A ID."
    echo "Logs:"
    echo "$LOGS"
    exit 1
fi

echo "Step B: Approve Consent A"
curl -s -X POST http://localhost:4000/ui/approve/$CONSENT_A_ID > /dev/null
sleep 2

echo "Step C: Attempt to Fetch Data for Consent A using Hospital B Identity"
echo "Executing Fetch..."
curl -s -X POST http://localhost:3000/fetch-data -d "consentId=$CONSENT_A_ID&identity=hospital-b" > /dev/null
sleep 3

echo "Step D: Check Logs for Access Denial"
FETCH_LOGS=$(get_logs)

# We expect the Token Request to fail with 401/403 and message about Actor Binding
# Or "unauthorized_client"
if echo "$FETCH_LOGS" | grep -q "access_denied\|unauthorized_client\|401\|403"; then
    echo "PASS: PCM denied token request for Cross-Org access."
else 
    echo "FAIL: Did not find expected Access Denial error."
    echo "$FETCH_LOGS"
    exit 1
fi


echo "--- 4. Verify Valid Hospital B Flow ---"
echo "Step A: Create Consent as Hospital B"
curl -s -X POST http://localhost:3000/create-consent -d "patientId=222&identity=hospital-b" > /dev/null
sleep 2

# Get Consent ID
LOGS=$(get_logs)
CONSENT_B_LOG=$(echo "$LOGS" | grep "CREATED CONSENT ID:" | grep "hospital-b" | tail -n 1)
CONSENT_B_ID=$(echo "$CONSENT_B_LOG" | awk '{print $4}')
echo "Consent B ID: $CONSENT_B_ID"

if [ -z "$CONSENT_B_ID" ]; then
    echo "FAIL: Could not extract Consent B ID."
    exit 1
fi

echo "Step B: Approve Consent B"
curl -s -X POST http://localhost:4000/ui/approve/$CONSENT_B_ID > /dev/null
sleep 2

echo "Step C: Fetch Data as Hospital B"
curl -s -X POST http://localhost:3000/fetch-data -d "consentId=$CONSENT_B_ID&identity=hospital-b" > /dev/null
sleep 3

echo "Step D: Verify Success"
FETCH_B_LOGS=$(get_logs)
if echo "$FETCH_B_LOGS" | grep "OUTGOING RESPONSE: 200" | grep "Observation"; then
    echo "PASS: Hospital B successfully fetched data."
else
    echo "FAIL: Hospital B failed to fetch data."
    echo "$FETCH_B_LOGS"
    exit 1
fi

echo "ALL UDAP B2B TESTS PASSED."

echo "ALL UDAP B2B TESTS PASSED."
exit 0
