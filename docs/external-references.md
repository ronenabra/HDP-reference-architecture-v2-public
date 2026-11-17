# External standards and test inputs

| Publication | Reference |
| --- | --- |
| PCM implementation guide and profiles | [PCM-IL](https://simplifier.net/pcm-il) |
| Israeli core FHIR profiles | [IL Core](https://simplifier.net/ilcore) |
| Health Data Portability profiles and guidance | [HDP-IL](https://simplifier.net/hdp-il) |
| PCM FHIR/OAuth API definitions | [MohGovIL/Swagger](https://github.com/MohGovIL/Swagger) |
| Legislation and certification resources | [FHIR IL](https://www.fhir-il-community.org/legislation) |

The sandbox implements PCM-IG 0.4.2. Its application version is independent.
Canonical requirements belong to these external publications. The locally maintained
[Admin API](openapi-admin.yaml) describes this application's private operations.

## Synthetic population datasets

[HDP-synthetic-dataset](https://github.com/ronenabra/HDP-synthetic-dataset) publishes the separate native
generator and ready-made FHIR R4 1k/10k populations. The [dataset guide](datasets.md)
pins release **4.2.2-2026-10-10** at commit `459ac3e28e8507df2eba82289a7e2deed9c073fd`,
with verified download instructions and explicit health-organization mapping.
Population archives are optional runtime inputs, not canonical standards or part
of the 66 contract-test inputs below. No generator installation is needed to use
the ready-made archives. Dataset limitations and terminology terms remain with
the [upstream release](https://github.com/ronenabra/HDP-synthetic-dataset/blob/459ac3e28e8507df2eba82289a7e2deed9c073fd/releases/synthetic-population/4.2.2-2026-10-10/README.md).

## Prepare the test dependencies

```sh
npm run prepare:contracts
npm run check:pcm-ig
```

The [input lock](external-contract-inputs.json) pins 66 files: three OpenAPI
documents from Swagger commit `c048db3bb8ed4eca563c60849cefc780ce115924`, plus 60
FHIR examples, two StructureDefinitions and one ValueSet from Simplifier PCM-IL.
Every file has an exact SHA-256 and size. No private repository or account is needed.

Downloaded files go only into ignored `docs/FHIR-examples/`,
`.contract-inputs/profiles/` and `docs/openapi*.yaml` locations. Verified bytes are
cached in `.contract-inputs/cache/`. Runtime startup does not require these inputs.
Do not commit or include them in a source release.

```sh
# Restore from this checkout's verified cache without networking.
npm run prepare:contracts -- --offline
# Or copy the pinned installed layout from another prepared checkout.
npm run prepare:contracts -- --from /absolute/path/to/prepared-checkout
```

Conflicting destination files, incorrect hashes/sizes, redirects and HTML login
responses fail. Missing downloads are checked before destination installation.
Retry after correcting the reported error; previously verified cache entries remain.
`check:pcm-ig` checks installed byte identities offline, not compilation of a guide.

Swagger URLs use an immutable commit. Simplifier raw URLs are mutable: hashes
prevent accepting changed content but cannot ensure old bytes remain downloadable.
Preserve the verified cache for offline use. The recorded resource revisions describe the downloaded content; they are not
permanent download URLs. A different PCM package or an arbitrary HL7 cache cannot
replace these exact files. Update the lock only after checking compatibility.
