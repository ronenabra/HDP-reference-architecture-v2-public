# Application regression fixtures

These inputs are required by current implementation tests:

- `admin/form-parity.json`: Admin form ownership expectations.
- `log-viewer/native-rotation-sample.jsonl`: gateway log-reader/rotation input.
- `log-viewer/search-targets.json`: log search benchmark targets.

Small clinical and workflow fixtures live under `clinical-data/`. They test imports,
authorization and migration; they are not a population dataset release. Canonical
FHIR examples and profiles are downloaded into ignored paths with
`npm run prepare:contracts`. Archived verifier runs are not fixture dependencies.
