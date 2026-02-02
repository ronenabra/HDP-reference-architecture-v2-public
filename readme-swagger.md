# Swagger (OpenAPI) Notes

This repository hosts the OpenAPI definitions and generated documentation for the PCM FHIR and OAuth2 APIs. It is intended as a self-contained reference for API consumers and implementers, with both split and combined specifications.

## API Docs
* **📘 PCM API Docs (Redoc HTML)**: https://htmlpreview.github.io/?https://github.com/ronenabra/HDP-reference-architecture-v2/blob/main/docs/api-docs.html

## OpenAPI Specs
* `docs/openapi-fhir.yaml`: FHIR REST OpenAPI spec.
* `docs/openapi-oauth.yaml`: OAuth2 token/introspection OpenAPI spec.
* `docs/openapi.yaml`: Combined FHIR + OAuth2 OpenAPI spec (single entry point).
* `docs/FHIR-examples/`: Example FHIR resources referenced by the specs and docs.

## Regenerate the HTML Docs
If you update any `openapi*.yaml`, regenerate the HTML docs using Redocly CLI:

```bash
npx @redocly/cli build-docs docs/openapi.yaml -o docs/api-docs.html
```

If you want separate docs, you can build them from the split specs:

```bash
npx @redocly/cli build-docs docs/openapi-fhir.yaml -o docs/api-docs-fhir.html
npx @redocly/cli build-docs docs/openapi-oauth.yaml -o docs/api-docs-oauth.html
```
