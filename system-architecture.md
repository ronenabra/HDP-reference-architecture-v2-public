# PCM sandbox architecture

This document describes the public implementation. PCM-IG, HDP and IL Core own
the canonical protocol, profiles and implementation guidance; use the
[external references](docs/external-references.md). This repository does not
publish another normative specification.

## Runtime topology

The Doctor (`src/sp-client`) obtains patient-context authority from PCM
(`src/pcm-core`). Each of three health organizations has an NGINX gateway,
DS authorization adapter, native HAPI FHIR server and isolated PostgreSQL data.
PCM hosts consent review, service management, administration and central Logs.
The legacy Node source is a labelled connectathon compatibility component and
is excluded from Strict. Private import/maintenance uses a separate credential
and private network boundary; it is never Doctor clinical authority.

## Authority and query behavior

All four presets enforce the effective clinical grant, resource/action rules,
patient context, filters and final returned-resource authorization. Presets may
simulate parts of authentication and transport; they do not turn clinical
permissions off. Service definitions and explicit approval choices determine
immutable approved grants. Tokens cannot gain authority from later template edits.

PCM exposes no public JWKS. Adapter signing/JWKS material belongs to the internal
source boundary. Within authorization, independently granted scopes form a union;
each alternative retains its own complete restrictions. Unsupported advanced
expressions fail closed instead of silently dropping predicates.

Native HAPI owns supported GET/form POST searches, bounded PAGE/COUNT/TOTAL and
single-target Patient `$everything`. Fresh authority and request-bound continuation
remain part of that boundary. Patient searches select the authorized patient and permitted linked patients
before loading their contents. Query budgets and final resource checks still
apply; search support and capacity are bounded. See [supported behavior](docs/scope-enforcement.md).

Doctor's generated fetch is a first-page preview, ordinarily up to ten results
per type/source. The optional exact FHIR GET path override may return other shapes
and counts; the source still enforces authority. Doctor does not automatically
traverse arbitrary continuation links or infer clinical absence from a failed query.

## Where authorization decisions live

The public FHIR records describe participants, services and consent. PCM keeps
the exact approved scope, service version and timing in private approval state.
Clients receive their usable authority in the token response. The source
adapter checks the opaque token with PCM and passes request-bound authority
to its HAPI server. Clinical records stay in that organization's database.

Patient consent governs Doctor's clinical fetch. Separate system Contracts
govern tasks such as checking patient presence or discovering dependents. A
SMART launch asks the user to authorize a particular application. Completing
one flow supplies only the authority granted for that flow.

## Operations and data ownership

`bootstrap-local-team.js` creates one isolated team's configuration, credentials
and runtime. Managed databases start empty unless an explicit import is selected.
Population datasets and their clinical assumptions belong to
[HDP-synthetic-dataset](https://github.com/ronenabra/HDP-synthetic-dataset). The
[import guide](docs/datasets.md) pins external release 4.2.2-2026-10-10; the
sandbox owns import, explicit source mapping and recovery. Dataset release labels
and embedded resource tags are distinct provenance fields. Import acceptance does
not establish clinical validation or patient eligibility under every preset.
Small checked-in regression fixtures are implementation test inputs only.

Generated keys, credentials, logs, backups and state remain local and ignored.
Every preset intentionally retains full non-AWS runtime diagnostics. Scope local
access accordingly. AWS credentials must not enter the sandbox.

## Publication boundary

Runtime source, sandbox-owned documentation and test tooling are published here.
Canonical guides, FSH/profile payloads and PCM public OpenAPI documents are not
vendored in the publication. Contract tests prepare 66 hash-pinned public Swagger/Simplifier inputs with
`npm run prepare:contracts`; runtime startup does not require them. Swagger uses
an immutable public commit; Simplifier uses byte hashes and a verified content cache.
The public API page links outward; the sandbox Admin API is generated locally.

The full verifier runs fresh disposable teams and requires every supported
scenario. It includes application migration fixtures and runtime regression tests.
Test reports identify the source and images used. See [testing](CONTRIBUTING.md).
