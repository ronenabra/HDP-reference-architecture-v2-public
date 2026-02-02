#!/bin/bash

# 1. Test Valid Flow (mTLS via SP Client)
echo "--- 1. Testing Valid mTLS Flow (SP Client -> PCM/Gateway) ---"
bash verify_strict_auth.sh
STATUS=$?
if [ $STATUS -eq 0 ]; then
    echo "PASS: Valid mTLS flow works."
else
    echo "FAIL: Valid mTLS flow failed."
    exit 1
fi

# 2. Test Invalid Flow (Curl without Cert -> PCM Core)
echo "--- 2. Testing Access without Client Cert (Should Fail) ---"
# We try to hit PCM Core HTTPS endpoint without a cert.
# -k because we use self-signed CA, but we lack the CLIENT cert.
# Expected: TLS Handshake failure or 400 Bad Request (No Cert) depending on Node logic.
# Node requestCert: true, rejectUnauthorized: true -> Handshake error usually.

# Using curl with -k (insecure server cert) but NO client cert.
HTTP_CODE=$(curl -k -s -o /dev/null -w "%{http_code}" https://localhost:4001/r4/Organization)

# If connection is dropped/handshake fail, curl returns 35 or 60 etc.
# If connection succeeds but rejected by app, might be 401.
# Actually, Node `rejectUnauthorized: true` terminates the socket handshake.
# So curl should fail with exit code != 0.

curl -k -s https://localhost:4001/r4/Organization
CURL_EXIT=$?

if [ $CURL_EXIT -ne 0 ]; then
    echo "PASS: Connection rejected (Exit Code: $CURL_EXIT). mTLS is enforced."
else
    # If it returns a page or JSON, it failed enforcement
    echo "FAIL: Connection accepted without client cert."
    exit 1
fi

echo "All mTLS tests passed."
