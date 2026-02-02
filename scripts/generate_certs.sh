#!/bin/bash
set -e

# Directory for certs
CERTS_DIR="$(dirname "$0")/../certs"
mkdir -p "$CERTS_DIR"
cd "$CERTS_DIR"

echo "Generating Certificates in $CERTS_DIR..."

# 1. Create a Self-Signed CA
if [ ! -f rootCA.key ]; then
    echo "Creating Root CA..."
    openssl genrsa -out rootCA.key 2048
    openssl req -x509 -new -nodes -key rootCA.key -sha256 -days 1024 -out rootCA.crt -subj "/C=IL/ST=TelAviv/L=TelAviv/O=HDP-POC-Net/CN=HDP-Root-CA"
fi

# Function to generate certs for a service
generate_cert() {
    local SERVICE=$1
    local CN=$2
    
    if [ ! -f "$SERVICE.key" ]; then
        echo "Generating cert for $SERVICE ($CN)..."
        openssl genrsa -out "$SERVICE.key" 2048
        openssl req -new -key "$SERVICE.key" -out "$SERVICE.csr" -subj "/C=IL/ST=TelAviv/L=TelAviv/O=HDP-POC/CN=$CN"
        
        # Create extfile for SAN (Subject Alternative Name) - important for docker networking
        echo "subjectAltName=DNS:$CN,DNS:localhost,IP:127.0.0.1" > "$SERVICE.ext"
        
        openssl x509 -req -in "$SERVICE.csr" -CA rootCA.crt -CAkey rootCA.key -CAcreateserial -out "$SERVICE.crt" -days 500 -sha256 -extfile "$SERVICE.ext"
        
        rm "$SERVICE.csr" "$SERVICE.ext"
    else
        echo "Cert for $SERVICE already exists."
    fi
}

# 2. Generate Certs for Services
generate_cert "pcm-core" "pcm-core"
generate_cert "ds-gateway" "ds-gateway"
generate_cert "sp-client" "sp-client"

echo "Certificates generated successfully!"
# --- Hospital B SP (Trusted) ---
echo "Generating Hospital B SP (Trusted) Cert..."
openssl genrsa -out hospital-b-sp.key 2048
openssl req -new -key hospital-b-sp.key -out hospital-b-sp.csr -subj "/C=IL/ST=TelAviv/L=TelAviv/O=Hospital B/CN=hospital-b-sp"
openssl x509 -req -in hospital-b-sp.csr -CA rootCA.crt -CAkey rootCA.key -CAcreateserial -out hospital-b-sp.crt -days 365 -sha256

# --- Untrusted Client (Untrusted CA) ---
echo "Generating Untrusted CA and Client..."
# 1. Untrusted CA
openssl genrsa -out untrustedCA.key 2048
openssl req -x509 -new -nodes -key untrustedCA.key -sha256 -days 365 -out untrustedCA.crt -subj "/C=IL/ST=Nowhere/L=Nowhere/O=Evil Corp/CN=Untrusted Root CA"
# 2. Untrusted Client Cert
openssl genrsa -out untrusted-client.key 2048
openssl req -new -key untrusted-client.key -out untrusted-client.csr -subj "/C=IL/ST=Nowhere/L=Nowhere/O=Evil Corp/CN=untrusted-client"
openssl x509 -req -in untrusted-client.csr -CA untrustedCA.crt -CAkey untrustedCA.key -CAcreateserial -out untrusted-client.crt -days 365 -sha256

echo "Certificate generation complete."
