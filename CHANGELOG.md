# Changelog

## 0.2.0 — 18 November 2026

- Three isolated HAPI/PostgreSQL health organizations with authorization gateways.
- Doctor, Consent, Services, Admin and centralized Logs interfaces.
- Approved clinical permissions in every profile, with bounded GET/form POST
  search, counts, Patient paging and supported Patient operations.
- Explicit dataset import, recovery tools and fresh credentials for each team.
- Public PCM, IL Core and HDP references, with hash-checked test-input downloads.
  PCM FHIR/OAuth definitions link to [MohGovIL/Swagger](https://github.com/MohGovIL/Swagger).
  The sandbox's [Admin API](docs/openapi-admin.yaml) and
  [rendered reference](docs/admin-api-docs.html) remain local.
- Known dependency vulnerabilities accepted for this sandbox release; see the
  [security findings](docs/releases/0.2.0.md).

See [migration](docs/migration.md) before moving from the previous four-service
demonstration. Population datasets are distributed separately in
[HDP-synthetic-dataset](https://github.com/ronenabra/HDP-synthetic-dataset); the
[import guide](docs/datasets.md) pins release **4.2.2-2026-10-10** and records
the offline 1k compatibility check and its limits.
Seven Linux/amd64 sandbox images are available on GHCR with the tag
`0.2.0-rc.1-audit-20261117`. Full regression validation and follow-up fixes are planned for 0.2.1.
See [prebuilt installation](README.md#start-with-the-published-images).

## February 2026 demonstration

The earlier public version through `0ceed0c` used four services. Its image tags,
certificates and Compose instructions belong to that version.
