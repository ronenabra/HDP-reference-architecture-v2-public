# HDP Reference Architecture

This repository contains the Reference Architecture Proof of Concept (POC) for the Health Data Portability (HDP) ecosystem. It demonstrates a secure, federated architecture where Service Providers (e.g., Doctors) access Patient Health Data from Data Sources (e.g., Hospitals) with patient consent, mediated by a centralized Policy & Consent Manager (PCM).

**Note that this project is provided for demonstration purposes only and is not meant to be used as official guidlines!**

## 🚀 Features
*   **Federated Identity**: Simulates a central authority (PCM) handling Consent and Authorization.
*   **Opaque Tokens**: Uses secure, opaque identifiers for external access, translated to internal JWTs by the Data Source Auth Adapter.
*   **Security Standards**: Implements `private_key_jwt` client authentication and OIDC-style introspection.
*   **SMART on FHIR Discovery**: Dynamic configuration via `/.well-known/smart-configuration` for flexible deployment.
*   **Organization Management**: Self-service management for Service Providers to view and update their Organization and Endpoint details.
*   **Identity Isolation**: Strict enforcement of identity-based access control (Service Providers can only access their own resources).
*   **Full Observability**: Centralized, unified logging dashboard visualizing the flow across all 4 microservices in real-time.
*   **Smart Client**: Optimized "Doctor App" with caching to minimize redundant API calls.
*   **Token Context**: Introspection includes Consent identifier plus HealthcareService catalog identifier (for downstream policy checks).
*   **Certificate Consistency Warnings**: PCM and DS adapter log warnings when `client_assertion`/`cnf` cert and mTLS peer cert differ (non-blocking).

## Swagger
*   **📘 PCM API Docs (Redoc HTML)**: [https://ronenabra.github.io/HDP-reference-architecture-v2-public/api-docs.html](https://ronenabra.github.io/HDP-reference-architecture-v2-public/api-docs.html)

## 🏗️ Architecture
The system consists of 4 main Dockerized services:
1.  **PCM Core**: The central "Government" server (Identity Provider, Consent Repository, Portal).
2.  **Service Provider Client ("Doctor App")**: The consumer application requesting data.
3.  **Data Source Adapter (`ds-auth-adapter`)**: Security Gateway that validates PCM tokens and mints internal tokens.
4.  **FHIR Server (`ds-fhir-server`)**: Internal resource server hosting the health data.

## 🛠️ Prerequisites
*   [Docker Desktop](https://www.docker.com/products/docker-desktop) (or Docker Engine + Compose)
*   *Optional*: Node.js v18+ (if running scripts manually)

## 🏁 Getting Started

### 1. Setup Certificates
The system uses mTLS and signed JWTs for security. There are pre-generated demo certificates provided or you can generate your own certificates first.

```bash
chmod +x scripts/generate_certs.sh
./scripts/generate_certs.sh
```
*This will create a `certs/` directory with self-signed keys.*

### 2. Build for Docker (from source)
Build and start all services using Docker Compose:

```bash
docker compose up --build
```

### 2b. Run from Published Images (no build)
If you want to run prebuilt images from GHCR, use the following flow:

1) Download the `docker-compose.yml` from this repo (or copy it into a new folder).

2) Pull the images:

```bash
# Optional: pin a specific version
VERSION=0.1.1 docker compose pull
```

3) Start the stack without building:

```bash
VERSION=0.1.1 docker compose up --no-build
```

Without `VERSION`, Docker Compose defaults to `latest` tags.

### 3. Access the Applications
Once the containers are running:

*   **👨‍⚕️ Doctor's Portal (SP Client)**: [http://localhost:3000](http://localhost:3000)
    *   *Start here to create a consent request.*
*   **🏥 PCM Patient Portal**: [http://localhost:4000/ui](http://localhost:4000/ui)
    *   *Go here to Approve consent requests.*
*   **📊 Unified Logs Dashboard**: [http://localhost:4000/logs-view](http://localhost:4000/logs-view)
    *   *Watch the system interactions in real-time.*
*   **🔐 PCM FHIR API (mTLS + OAuth2)**: https://localhost:4001/r4
*   **📘 PCM API Docs (Redoc HTML)**: [http://localhost:4000/docs/api](http://localhost:4000/docs/api)

## 🧪 How to Verify the Flow
1.  Open the **Doctor's Portal** ([localhost:3000](http://localhost:3000)).
2.  Click **"Create Consent Request"**.
3.  Open the **PCM Portal** ([localhost:4000/ui](http://localhost:4000/ui)).
4.  Review and **Approve** the pending request.
5.  Return to the **Doctor's Portal** and click **"Fetch Patient Data"**.
6.  You should see the mock FHIR data (Observation) displayed.
7.  Check the **Logs Dashboard** ([localhost:4000/logs-view](http://localhost:4000/logs-view)) to see the full trace of the request!

## 🔍 Debugging & Logs
The project features a custom logging system.
*   **File Logs**: All logs are written to `./logs/<service>/current.log` on your host machine.
*   **Docker Logs**: You can also use standard Docker commands:
    ```bash
    docker logs -f sp-client
    docker logs -f pcm-core
    docker logs -f ds-auth-adapter
    ```
*   **Clean Reset**: If the system gets into a weird state, run:
    ```bash
    docker compose down
    # Optionally remove logs
    rm -rf logs/*
    docker compose up --build
    ```

## 📂 Project Structure
*   `src/pcm-core`: The central authority logic.
*   `src/sp-client`: The consumer web app.
*   `src/ds-auth-adapter`: The security proxy (PEP).
*   `src/ds-fhir-server`: The internal data server.
*   `src/ds-gateway`: NGINX configuration.
*   `scripts/`: Utility scripts.
*   `docs/openapi-fhir.yaml`: FHIR REST OpenAPI spec.
*   `docs/openapi-oauth.yaml`: OAuth2 token/introspection OpenAPI spec.
*   `docs/openapi.yaml`: Combined FHIR + OAuth2 OpenAPI spec (single entry point).
