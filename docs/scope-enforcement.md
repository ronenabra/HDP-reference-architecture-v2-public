# Profiles and supported access

An operating profile is a starting set of security checks for a sandbox team.
It lets you begin with a simpler local setup, then test certificates and signed
requests as your integration develops. **Strict** fixes the checks to the supported
protocol behavior; the three **connectathon** profiles let you vary named checks
for demonstrations and interoperability testing.

Two separate questions matter on every request:

1. **Who is making the request, and can the connection be trusted?** Certificates
   and signed client assertions answer this. Profiles can change some of these
   checks in the sandbox.
2. **What may this application access for this patient?** The approved Consent,
   service, source and permissions answer this. Every profile enforces them.

For example, a Consent that allows laboratory Observations does not allow medication
records simply because you switch to Easy. Easy still uses the Consent and token
flow. To test broader access, request and approve an explicit broader permission.

## Choose a profile

Start with **Balanced** for the README walkthrough. Choose Easy when you need to
isolate workflow or query behavior from certificate/assertion setup. Use mTLS to
test the full set of local certificate checks, and Strict when testing a client
against the fixed supported protocol behavior.

| Profile | Default behavior | What you can change |
| --- | --- | --- |
| `connectathon-easy` | Relaxes the six checks below for local synthetic-data tests. | The six checks, globally or for a selected source. |
| `connectathon-balanced` | Verifies server certificates and signed client assertions, without requiring public client mTLS. | The same six checks. |
| `connectathon-mtls` | Enables all six checks using the team's registered certificate material. | The same six checks. |
| `strict` | Enables and fixes all six checks; excludes compatibility adapters, the source sampler and legacy clinical source. | No relaxation of these checks. |

These are defaults. Admin shows the effective settings, including per-source
overrides. Doctor's **Configured checks and compatibility** disclosure is a
configuration summary, not a live source check. Choosing Strict does not establish
production readiness or independent certification; every profile remains a
synthetic sandbox with the [documented release limits](releases/0.2.0.md).

### What the six checks mean

TLS protects the connection and lets a client verify the server. **Mutual TLS
(mTLS)** also asks the client to present its registered certificate. A **client
assertion** is a short-lived signed proof sent to an OAuth endpoint; it is distinct
from the access token used to fetch clinical records.

| Check | What it verifies | Easy | Balanced | mTLS / Strict |
| --- | --- | --- | --- | --- |
| Client mTLS | The caller presents its registered transport certificate. | Relaxed | Relaxed | Enabled |
| Server certificate | The destination is trusted by the configured client. | Relaxed | Enabled | Enabled |
| Assertion signature | The proof was signed by an approved client key. | Relaxed | Enabled | Enabled |
| Assertion audience | The proof names the endpoint receiving it. | Relaxed | Enabled | Enabled |
| Assertion replay | The same proof has not already been used. | Relaxed | Enabled | Enabled |
| Assertion expiry | The proof is within its allowed time interval. | Relaxed | Enabled | Enabled |

Relaxing **assertion expiry** does not disable **access-token expiry**. Token,
Consent, service and source status, patient context, approved scope and returned
resource checks remain required. Internal adapter-to-HAPI signatures and AWS
credential isolation also remain required. Diagnostic and system workflows can
require their own authentication even in Easy; the token-inspection section below
explains one such case.

### Select or change a profile

For a new team, choose `--preset` on the bootstrap command:

```sh
node pcm-connectathon/scripts/bootstrap-local-team.js --team-id profile-demo --teams-root tmp/connectathon-teams --preset connectathon-balanced
```

For an existing compatible team, preview the controlled change first:

```sh
node pcm-connectathon/scripts/reconfigure-local-team.js --team-id profile-demo --teams-root tmp/connectathon-teams --preset connectathon-mtls --print-plan
```

After reviewing it, running the same command **without `--print-plan` applies the
change**: it stops the team, updates its configuration and recreates its containers. This tool does not use an
`--apply` switch. It preserves the team's volumes, certificates, identity and
import ledger, but a process restart still affects uncheckpointed PCM state.
Read [backup and migration](migration.md) before changing a team you need to keep.
Selecting a preset does not convert older stored approvals or configuration schemas.

## How clinical permissions work

A **scope** is the text describing allowed resources, actions and optional filters.
For example, `patient/Observation.rs` describes reading and searching Observations
within the authorized patient context: `r` means a direct read and `s` means a
search. The actual approved scope may also restrict dates, data categories or
sensitivity labels. A **grant** is that permission together with its patient,
source, client and lifetime context.

The service describes proposed access. Approval chooses and freezes the Consent's
actual permission. The token carries the resulting authority, and the source
checks the request and the returned records against it. Changing a service
template later does not expand an existing approval or token. Changed permissions
need a new Consent decision. See [Services and approval choices](service-templates.md).

Within one scope alternative, all its restrictions apply together. Separate
alternatives provide separate ways to authorize a resource; their restrictions
are not mixed to invent a broader permission. A narrower FHIR query can reduce
results, but it cannot enlarge the grant. For example, requesting more rows with
`_count` changes the page size, not which records are authorized.

## What the sources support

| Source | Supported role |
| --- | --- |
| Three managed HAPI sources | Clinical storage and requests with patient and grant checks. |
| Legacy Node source | Identity, health, logs and compatibility testing; no ordinary clinical requests and excluded from Strict. |
| External source | Its operator implements the required checks and rejects unsupported requests. There is no fallback clinical backend. |

Managed HAPI sources support bounded GET and form POST searches, count-only
queries, paging and single-Patient `$everything`. Known Organization and
Practitioner records can be read by ID when authorized; this does not provide
unrestricted master-data search. Clinical writes and unsupported advanced
query/scope shapes are rejected. The [HAPI guide](../src/ho-fhir-server/README.md)
describes exact query controls, limits and continuation behavior.

Query budgets limit time, memory and work. An exhausted query is an error, not
proof that the patient has no records. Raising a budget grants no additional
permission and does not guarantee capacity. Expired paging state needs a new
search. Doctor's normal preview does not fetch every page.

Data import and maintenance use separate private credentials; they do not supply
Doctor clinical authority. Sign-in, source discovery, dependent lookup and SMART
launch have their own requirements, explained in [optional workflows](hmo-test-journey.md).

## Technical reference

The sections below are for integrating clients or operating existing teams.
They name the exact configuration fields and protocol behavior behind the
concepts above. Most first-time users can continue with the [sandbox guide](public-quickstart.md).

## Configuration and compatibility

Team configuration selects `conformance.mode` (`strict` or `connectathon`) and
one of the four presets above. If `PCM_CONFORMANCE_MODE` is supplied, it must
match the configuration; unknown values or conflicts stop startup. The current
formats are `pcm-team-config/5` and `pcm-sandbox-policy/4`. Unknown configuration
keys and retired permission/context bypass controls are rejected. Changing a
preset does not migrate stored approvals or start a new authorization window.

Explicit compatibility adapters accept a small set of older client formats.
Select them in `conformance.compatibilityAdapters`; they normalize the named
input before ordinary validation. Unknown adapters and ambiguous input are
rejected. Strict prohibits adapters, including the obsolete ES384 setting.

| Adapter | What it accepts or changes | How to stop needing it |
| --- | --- | --- |
| `legacy-rs256-assertion` | RS256 with the registered RSA assertion certificate. | Use a registered P-256/ES256 or P-384/ES384 signing key. |
| `legacy-es384-assertion` | A retained migration setting; approved ES384 already works without it. | Remove the obsolete setting during reviewed migration. |
| `legacy-jose-kid` | A legacy non-thumbprint `kid` when registered-key selection is unambiguous. | Use the signing key's RFC7638 thumbprint. |
| `legacy-introspection-token-audience` | The token endpoint as audience for an introspection assertion. | Sign for the exact introspection endpoint. |
| `legacy-organization-url-client-id` | An allowlisted Organization URL mapped to its assigned opaque client ID. | Send the assigned opaque ID. |
| `legacy-management-scope-cruds` | Exact `system/*.cruds`, normalized to `system/*.crus`. | Use the PCM-IG scope spelling. |

Compatibility acceptance emits `PCM-COMPAT-AUTHN-*` audit codes. Doctor's
**Configured checks and compatibility** disclosure shows enabled settings;
it does not prove that a request used an adapter or that a source is available.

Strict assertions use registered ES256/P-256 or ES384/P-384 keys, matching
issuer/subject, the exact endpoint audience, bounded lifetime and replay checks.
A normative `kid` is the signing key's RFC7638 thumbprint. SMART requires it;
other callers may omit it only when approved-key selection is unambiguous.
Signature failure does not try another key. External key-selection headers such
as `jku`, `jwk` and `x5*` are not accepted in the strict contract. A signing key
and a transport certificate have distinct roles: supplied payload `cnf` must
match the verified request certificate. A mismatch is rejected, not downgraded
to a warning. Neither profile publishes a PCM JWKS.

Token and direct-introspection assertions share an expiring replay store under
`runtime.stateDir/assertion-replay`, mounted on the configured runtime volume.
Restarting PCM does not clear accepted `jti` values. OAuth/SMART metadata describes
the selected policy; connectathon metadata is not strict conformance evidence.

### Older deployment settings

Use [reviewed migration](migration.md) for existing teams. The main mappings are:

| Older setting | Current configuration or rule |
| --- | --- |
| `PCM_API_CLIENT_AUTH_MODE` | `security.pcmApi.clientAuth`; Strict requires `mtls`. |
| `DS_GATEWAY_CLIENT_AUTH_MODE` | `security.dataSourceGateway.clientAuth`, subject to effective simulation controls; Strict requires `mtls`. |
| `SP_DS_VERIFY_SERVER_CERTIFICATE` | `security.serviceProviderToDataSource.verifyServerCertificate`, subject to effective simulation controls; Strict requires verification. |
| `DS_FHIR_UPSTREAM_PROTOCOL` / `DS_FHIR_UPSTREAM_VERIFY_SERVER_CERTIFICATE` | `security.dsGatewayToFhirServer.protocol` / `verifyServerCertificate`; Strict requires verified HTTPS. |
| `PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS` | Validated `security.pcmApi.accessTokenExpiresInSeconds`: production at most 30 seconds, test at most 86,400; earlier authority deadlines still apply. |
| `PCM_ALLOW_ANY_TOKEN_RESOURCE` / old full-access controls | No permission-bypass replacement; use an explicit approved clinical scope. |
| `PCM_INTROSPECTION_RETURNS_EXPIRED_TOKENS` | Do not retain expired-token acceptance; configure a bounded token lifetime. |
| `ENFORCE_CNF_MATCH` | Retired switch; a supplied certificate-binding mismatch is rejected. |
| `DS_FHIR_ENFORCE_MAPPED_PATIENTS` | Patient mapping and authority are required, not optional simulations. |

These are migration mappings, not instructions to edit environment variables on
an active team. Effective policy and schema validation determine the accepted
settings. Coordinate PCM, Doctor, adapters, HAPI and configuration changes; old
internal contexts are rejected. See [retained-state tools](../pcm-connectathon/retained-team-migration.md).

## Certificates and reloads

Use the supported leaf-certificate renewal tool to preview changes for a team:

```sh
node pcm-connectathon/scripts/rotate-team-certificates.js --team-id public-demo --teams-root tmp/connectathon-teams
```

After reviewing the preview, `--apply` performs the controlled backup and team
recreation; `--rotate-keys` also changes leaf keys. Root replacement is not
supported by this command. Do not partially replace a CA or manually combine
trust roots. See [certificate renewal and recovery](../pcm-connectathon/admin-api.md)
and [Doctor certificate roles](../pcm-connectathon/team-quickstart.md#doctor-certificate-profiles-and-retained-teams).

A saved configuration or successful preview does not establish runtime adoption.
Compare process sessions and active revisions. For the legacy Node source,
`PROCESS_BOOT` describes a restart, while `PROCESS_RELOAD_COMPLETE` records a
successful reload. Invalid configuration produces `DS FHIR config reload rejected`
and retains the last active revision. Listener failures can produce
`PROCESS_RELOAD_ROLLBACK`; inspect the outcome and retry through the supported
configuration workflow. A health response or successful bind does not verify
protected requests. National trust-anchor distribution, revocation and emergency
root rollover remain outside this local sandbox's qualification.

## Optional Service Provider token inspection

Doctor's explicit **Check token status** is a sandbox diagnostic capability.
`security.pcmApi.allowServiceProviderOwnTokenIntrospection` defaults to true in
Easy, Balanced and mTLS; false disables it. Strict disables it and rejects true.
Entering Strict through controlled preset recreation removes an override;
connectathon-to-connectathon changes preserve explicit overrides. Admin's
Sandbox capabilities form shows the saved origin and effective value. The
protected `POST /admin/config/own-token-introspection` accepts
`{ "allowServiceProviderOwnTokenIntrospection": false }`, true, or `"default"`
to remove the override. A save does not prove remote runtime adoption.

The check uses the Service Provider's own registered mTLS and `private_key_jwt`
credentials at the discovered `/introspect` endpoint. Signature, exact assertion
audience, expiry and replay checks still apply in Easy. It does not borrow Data
Source credentials. Unknown, foreign, expired, revoked or inconsistent tokens
return only `active:false`; disabled inspection returns 403 `access_denied`,
and invalid caller authentication returns 401 `invalid_client`.

An active result preserves the original token's issuer, client, source audience
and approved scope/context. Its observation lasts at most 30 seconds and never
beyond the token or current authority. Inspection rechecks registrations,
certificate roles, source and approval authority. It does not issue a new token,
call a clinical source, start an unused first-use window or extend an existing
window. Source introspection keeps its separate first-use duties.

Doctor's original validated token receipt remains usable if the optional check
is disabled, refused or unavailable. An authoritative inactive or inconsistent
result blocks use of that exact credential; delayed responses cannot erase a
newer replacement. Passive token details, copy and Help do not check status.
An active result is an observation at a particular time, not a production PCM
entitlement or a promise that the next clinical request will succeed.

## Diagnostics and further reading

All profiles retain sensitive non-AWS diagnostics, including tokens, cookies,
synthetic identifiers and FHIR bodies. AWS operational credentials are blocked
at the shared logging boundary. Protect Admin access, team directories and log
downloads. Central Logs includes native HAPI sources alongside gateways and
adapters; see [Logs and troubleshooting](public-quickstart.md#logs-and-troubleshooting).

For an initial team and consent journey, use the [README](../README.md). For
SMART sign-in, dependent lookup and bounded source sampling, use
[optional workflows](hmo-test-journey.md). A smoke test or selected profile does
not establish independent conformance; release validation scope is recorded
in the [release notes](releases/0.2.0.md).
