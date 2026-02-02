# Changelog

## [Unreleased] - 2026-01-28
### Added
- PCM API split into HTTPS (FHIR + OAuth2) and HTTP (UI/logs/docs) servers with mTLS enforced on API.
- FHIR API surface completion for Organization, Endpoint, HealthcareService (catalog/instance), Consent, and VerificationResult.
- x5t#S256 thumbprint calculation (base64url SHA-256 of DER) and cnf claim in tokens.
- DS identity mapping and local JWT minting with patient claim; Observation responses keyed by patient context.
- Node test coverage for crypto, store, mapper, observation, and constants.
- Manual mTLS+OAuth2 verification harness (`tests/manual/verify_standard_ops.sh`).
- PCM admin Organization (type `pcm`) bootstrapped and authorized for full FHIR REST access.
- PCM system org/endpoint identifiers standardized (`org-pcm-system`, `endpoint-pcm-system`).
- Split OpenAPI specs into `openapi-fhir.yaml` and `openapi-oauth.yaml`, with a combined `openapi.yaml`.
- HealthcareService fhirContext helper for deriving catalog identifiers with canonical fallback.

### Changed
- PCM FHIR base aligned to `/r4` with SMART discovery and CapabilityStatement under the same base.
- OAuth2 flow updated to require RFC 8707 resource parameter and validate requested resource against Consent/Endpoint.
- Introspection response expanded to include `fhirContext` and `cnf` fields; adapter preserves context.
- DS components (ds-gateway/ds-auth-adapter/ds-fhir-server) share a single certificate.
- Documentation refreshed: openapi, PCM process flow, FHIR examples, README, and architecture notes.
- Consent update via FHIR now restricted to requestor setting `status=inactive` only.
- fhirContext HealthcareService now emits catalog identifier only (no reference).
- PCM logs warning when client_assertion cert and mTLS peer cert differ; continues.
- DS auth adapter logs warning when mTLS peer cert and introspected cnf differ; continues.

### Fixed
- Applicable certificate thumbprints aligned to `x5t#S256` (base64url SHA-256).
- Manual token generator scripts consolidated to a single source of truth.
