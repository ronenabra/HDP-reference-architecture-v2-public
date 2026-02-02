#!/bin/bash

# Clear logs first? No, just tail carefully or handle it.
# Ideally restart sp-client cleanly, but let's just grep reliably.

echo "--- 1. Reset Environment ---"
curl -s -X POST http://localhost:3000/reset > /dev/null

echo "--- 2. Create Consent (Should use Aud: http://pcm-core:3000) ---"
curl -s -X POST http://localhost:3000/create-consent -d "patientId=99887766" > /dev/null
sleep 3

echo "--- 3. Verify Actor Injection via Internal Logs ---"
# Read internal log file which has full JSON
LOGS=$(docker exec sp-client cat /app/logs/current.log)

# Extract the response for the Consent Creation
# We look for "OUTGOING RESPONSE: 201" and ensure it is for "/Consent"
# JSON structure: { ..., "message": "...", "details": { "data": { "provision": { "actor": [ ... ] } } } }
# We grep for "Doctor's Consultation" in the lines that contain "OUTGOING RESPONSE" and "201"
MATCH=$(echo "$LOGS" | grep "OUTGOING RESPONSE: 201" | grep "/Consent" | grep "Doctor's Consultation")

if [ -n "$MATCH" ]; then
    echo "PASS: Consent created with 'Doctor's Consultation' actor injected."
else
    echo "FAIL: Doctor's Consultation actor not found in 201 response log."
    # Debug: show last few logs
    echo "Last relevant logs:"
    echo "$LOGS" | grep "OUTGOING RESPONSE: 201" | tail -n 3
    exit 1
fi

# Extract Consent ID
# From $MATCH, find id.
CONSENT_ID=$(echo "$MATCH" | grep -o '\\"id\\":\\"[^\\"]*\\"' | head -n 1 | cut -d'\' -f4)
# JSON stringify escapes quotes? "details": { ... "id":"..." } typically in file it's raw JSON object per line.
# If it's valid JSON per line: {"id":"UUID"...}
# Let's try simpler cut.
CONSENT_ID=$(echo "$MATCH" | grep -o '"id":"[^"]*"' | head -n 1 | cut -d'"' -f4)
echo "Consent ID: $CONSENT_ID"

if [ -z "$CONSENT_ID" ]; then
    echo "FAIL: Could not extract Consent ID"
    exit 1
fi

echo "--- 4. Approve Consent ---"
curl -s -X POST http://localhost:4000/ui/approve/$CONSENT_ID > /dev/null
sleep 2

echo "--- 5. Fetch Data (Should use Aud: <Discovered_Endpoint>) ---"
curl -s -X POST http://localhost:3000/fetch-data > /dev/null
sleep 3

echo "--- 6. Verify Fetch Success ---"
FETCH_LOG=$(docker exec sp-client cat /app/logs/current.log | grep "OUTGOING RESPONSE: 200" | grep "ds-gateway")

if [ -n "$FETCH_LOG" ]; then
    echo "PASS: Successfully fetched data from DS Gateway."
else
    echo "FAIL: No successful fetch log found."
    exit 1
fi
