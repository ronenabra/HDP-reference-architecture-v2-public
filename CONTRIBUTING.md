# Contributing and testing

Read the [architecture](system-architecture.md) and the relevant
[external standards](docs/external-references.md). Use Node 24.22.1, `npm ci` and
`npm run prepare:contracts` before testing. Add unit tests for behavior changes
and explain non-obvious decisions in code comments.

## Test commands

| Command | Scope |
| --- | --- |
| `npm test` | Import, command-line and Node workspace unit tests. |
| `npm run verify:fast` | Node and Java tests, contract input hashes, schemas, OpenAPI, Compose and documentation checks. Requires JDK 17+ and Docker. |
| `npm run verify:full -- --wait-timeout 600` | Fast checks plus fresh runtime and browser tests across all four profiles. Creates and removes its own test teams. |
| `npm run verify:ui -- --team-config PATH --artifacts PATH` | Browser tests against the selected team. Use a disposable team. |

The full verifier requires every supported scenario to run; missing or skipped
required tests are not passes. See [browser tests](pcm-connectathon/ui/SUPPLEMENTAL.md)
for supplemental workflows. Small fixtures in `clinical-data/` and `test-support/`
exercise import, authorization and migration cases. They are separate from the
population datasets used for demonstrations.

License-package checks need Python 3 and its standard library:

```sh
python3 -m unittest discover -s scripts -p 'test_package_release_licenses.py'
```

Optional contract-schema helper tests need Python 3, PyYAML and jsonschema:

```sh
python3 -m venv .venv
.venv/bin/pip install PyYAML jsonschema
.venv/bin/python -m unittest discover -s scripts -p 'test_validate_public_contracts.py'
```

For HMO browser tests, `clinical-data/hmo-ui-fixtures.js` exports
`ordinaryHmoFixtures()`. Import those bundles into a disposable team and use the
supplemental browser runner's `--hmo-journey`, `--browser-ip`, `--team-config` and
`--artifacts` options. That test changes the selected team's workflow configuration
temporarily; do not run it against an installation you need to preserve.

## Documentation and build inputs

Edit `docs/openapi-admin.yaml` for Admin API changes and run
`node scripts/generate-api-docs.js`. Update the README and changelog when API usage changes. Edit `docs/ui-explanation-catalog.md` for application
help and run `node scripts/generate-ui-help.js` to update its generated copy.

Canonical profiles and API definitions are downloaded by `prepare:contracts`;
see [external inputs](docs/external-references.md). Do not add those downloaded
files, credentials, logs or population datasets to Git.

`scripts/public-release.js` packages a selected committed source and its images.
Use the source manifest and image digests to identify the artifacts you test.
Include the matching license/source companion with image downloads; see
[third-party notices](THIRD_PARTY_NOTICES.md).
Keep test output under ignored `tmp/` and report failures and skipped checks.
The [known security findings](docs/releases/0.2.0.md) describe the dependency vulnerabilities accepted for 0.2.0.

## Container distribution through GHCR

GHCR can host the sandbox's built images. HAPI FHIR 8.10.0 and the pinned JPA
Starter are Apache-2.0 licensed; section 4 permits source and binary
redistribution, including modified container images, with the license, applicable
notices and modification notices preserved. See the exact
[HAPI license](https://github.com/hapifhir/hapi-fhir/blob/v8.10.0/LICENSE.txt),
[Starter license](https://github.com/hapifhir/hapi-fhir-jpaserver-starter/blob/4d12a3fe9e17fd19b7b446cf8c99c2f1632602eb/LICENSE)
and [runtime dependency notices](src/ho-fhir-server/THIRD_PARTY_NOTICES.md).
Dependencies retain their separate terms; HAPI's license does not cover the
whole image. Keep the exact matching notices, corresponding sources and build
instructions available with each image, and link that companion from its package
page and release. Include the [accepted scan limitation](docs/releases/0.2.0.md#accepted-source-companion-scan-limitation).

GitHub Actions can publish with `GITHUB_TOKEN` and `packages: write`; a local push
uses a suitable package credential. Set each intended public package's visibility
to Public and verify anonymous pulls. Link packages to this source repository,
publish versioned tags and record registry digests alongside the source manifest.
See [GitHub's Container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

The current `public-release.js` tool exports source and offline image bundles;
it does not push to GHCR. The current verification workflow does not publish
packages either. The [release inventory](docs/releases/0.2.0.md#published-images)
records the published build and its companion. The matching companion is
publicly accessible on GHCR alongside the images.

The checked-in 0.2.0 source manifest covers every tracked file except the
manifest itself. To reproduce its input tree ID from the public release tag:

```sh
git ls-tree 0.2.0 | sed '/[[:space:]]PUBLIC_SOURCE_MANIFEST\.json$/d' | git mktree
```

For a source-only export, choose a commit and a new output directory:

```sh
node scripts/public-release.js export --ref HEAD --output tmp/release-source
node scripts/public-release.js archive --source tmp/release-source --output tmp/release-source.tar.gz
```

## Editing the browser interfaces

Doctor and PCM share [UI styles, controls and help](src/shared/ui). Reuse their
existing buttons, disclosure controls, status labels and keyboard behavior.
Use the help catalog for control-specific explanations. Keep the consequence
of a destructive action beside its button so it is visible with Help closed.
