# Supported limits

- This is a synthetic local sandbox. No production identity assurance, independent
  certification, hosted AWS/NLB acceptance or universal FHIR support is claimed.
- Native search has finite time, candidate, page and memory budgets. Unsupported
  advanced query/scope shapes reject; exhausted queries do not return partial totals.
- The legacy Node source provides compatibility identity/health only, not clinical data.
- Import timeouts and abandoned operations require ledger inspection and explicit
  reconciliation. Automatic replay of uncertain writes is not supported.
- Metadata connectivity and offline patient choices do not establish clinical readiness.
- Simplifier test-input URLs are mutable; exact hashes prevent silent substitution,
  and a verified local cache is needed if pinned bytes disappear upstream.
- Teams start empty. The [dataset guide](../docs/datasets.md) links the external population, checksums and known identity limitations.

Full regression validation is planned for 0.2.1. The [release notes](../docs/releases/0.2.0.md) record the accepted dependency findings for the published images.
See [testing](../CONTRIBUTING.md) and [third-party notices](../THIRD_PARTY_NOTICES.md).
