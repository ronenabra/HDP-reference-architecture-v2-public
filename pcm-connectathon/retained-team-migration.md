# Preserve or migrate an existing team

Use this guide when an existing team's configuration or stored PCM authority must
survive a change. If you only want to try the current sandbox, creating a fresh
team with the [README](../README.md) is simpler. These tools are not a sequence to
run on every upgrade: select the operation that matches the actual source format.

A team has several independent kinds of state. Configuration/credentials describe
how it runs. PCM stores Organizations, Endpoints, Services, Contracts and Consents,
including private approval history. Separate files track replay protection and
one-time usage. HAPI/PostgreSQL owns clinical records. Backing up one does not back
up the others. Uncheckpointed PCM state can be lost when its process restarts.

| Need | Use |
| --- | --- |
| Back up or restore unchanged current configuration/credentials | [Ordinary backup and live restore](#ordinary-configuration-backup-and-live-restore); this resets PCM runtime resources rather than recovering old Consents. |
| Change a current team's preset or renew leaf certificates | The preview commands in the ordinary-backup section; preserve needed PCM authority before recreation. |
| Convert exact retained PCM-IG 0.4.0 state to 0.4.2 | The legacy handoff and `--pcm-ig-041` procedure below. Requires complete old authority, not reconstructed seeds. |
| Convert the former permission-simulation model | [Scope model cutover](#scope-model-cutover). |
| Move retained authority into the current public/private metadata model | [Public/private metadata cutover](#publicprivate-metadata-cutover). |
| Adopt the current built-in full-access definition in a retained team | [Full-access definition cutover](#full-access-definition-cutover). |
| Recover an interrupted write | The recovery command for that exact journal; migration recovery and per-mutation recovery are different operations. |

The examples below use `/TEAM`, `/PRIVATE`, digest and timestamp placeholders.
Replace them with reviewed values for the selected team. Keep reviews, checkpoints,
credentials and backups private. Do not run apply/recovery against an active team.
The tool checks recorded inputs, but the operator must also account for remote
workers and confirm that the recorded artifact is the one actually running.

## Legacy 0.4.0 to 0.4.2 conversion

This converter handles exact retained 0.4.0 metadata and system Contract/service
pairs. Current startup does not perform that conversion. It preserves supported
old decisions rather than deriving authority from current templates. Some older
permission models require a subsequent separately reviewed scope/metadata operation.

## Prerequisites and downtime

Historical PCM FHIR state is in memory. An ordinary Admin config/certificate
backup cannot preserve its grants or Consent decisions across restart. Before
cutover the operator must package the historical runtime with the private
`src/pcm-core/src/migration-legacy-bridge.js` preload and its component source
and dependencies, without changing the historical authority implementation:

```sh
export PCM_MIGRATION_LEGACY_ROOT=/opt/historical-runtime
export PCM_MIGRATION_RUNTIME_ID=sha256:ACTUAL_IMMUTABLE_RUNTIME_ARTIFACT_DIGEST
export NODE_OPTIONS=--require=/opt/pcm041-bridge/src/pcm-core/src/migration-legacy-bridge.js
```

The preload starts a replacement process. It cannot capture the memory of a
running unbridged process. Bridge startup now **refuses missing, malformed,
partial, unapproved or hash/runtime/config-mismatched handoffs before bootstrap**;
it never falls back to seeds. Fresh teams outside this explicit bridge retain
their ordinary documented bootstrap. An existing complete checkpoint can use
the freeze command below. An unbridged historical process must use the explicit
reviewed reconciliation procedure below **before replacement**.

### First handoff from an unbridged historical process

`reconcile-pcm-handoff.js` implements an explicit reviewed reconciliation import.
It adds no route, inspector, hot injection or public capture interface. Its GETs
use the historical HTTPS management API and a current PCM-owner management token
obtained through existing registered credentials. They preserve returned JSON
including terminal decisions and server timestamps/versions, following every
page twice. Historical visibility filters hide some sampling/custom records;
these reads are deliberately labelled **visible-only**, never a complete export.

1. Keep the original PCM alive. Stop Doctor/SP, adapters, external import and
   maintenance/configuration workers. Isolate all PCM API/UI ingress at the
   existing deployment/network boundary; permit only the local capture operator's
   management GETs. Drain in-flight handlers and wait at least 31 seconds. Record
   the process/container identity, immutable runtime identity and the exact network
   isolation/worker-stop evidence. The script cannot enforce this historical
   ingress boundary or discover remote writers; the review must attest it.
2. Obtain an **independent complete authoritative inventory** for all five types
   (Organization, Endpoint, HealthcareService, Contract, Consent), including hidden
   resources, terminal states, non-seed decisions and original metadata. Use
   reviewed contemporaneous authority records, not bootstrap/config/defaults or
   assumptions about which seeds exist. Preserve exact JSON in a private
   `full-inventory.json` object with all five keys and arrays (empty arrays are
   explicit). A filtered search count cannot prove completeness. If independent
   completeness or exact hidden bytes cannot be established, **leave the original
   isolated process alive and do not restart it**; obtain/reconcile authoritative
   records and repeat review. The tool has no seed-based recovery option.
3. Write a private observation specification (all paths absolute):

```json
{
  "schema": "pcm-handoff-observation/1",
  "configPath": "/TEAM/team-config.json",
  "stateDirectory": "/TEAM/state",
  "runtimeId": "sha256:ACTUAL_HISTORICAL_SOURCE_PLUS_BRIDGE_DESCRIPTOR_HASH",
  "runtimeDescriptor": "/PRIVATE/historical-runtime-descriptor.json",
  "bridgeRoot": "/opt/pcm041-bridge",
  "apiBase": "https://PRIVATE_PCM_HOST:PORT/api/fhir-service/r4",
  "caFile": "/TEAM/certs/rootCA.crt",
  "certFile": "/PRIVATE/operator-mtls.crt",
  "keyFile": "/PRIVATE/operator-mtls.key",
  "tokenFile": "/PRIVATE/current-pcm-owner-management-token",
  "writersIsolatedAt": "ACTUAL_UTC_TIME",
  "isolationEvidence": "REVIEWED_NETWORK_RULE_AND_STOPPED_WORKER_RECORD",
  "processIdentity": "ACTUAL_ORIGINAL_CONTAINER_OR_PROCESS_ID"
}
```

`certFile`/`keyFile` are optional only when the selected existing transport does
not require client TLS. TLS server verification remains mandatory. The runtime
descriptor is `{root,id,artifact}` in the format of the retained runtime evidence:
`id = sha256:` plus SHA256 of recursively key-sorted compact artifact JSON;
`artifact.files` maps every historical artifact file to its SHA256;
`bridgeSourceFiles` maps packaged bridge dependencies. The tool rehashes them
and config plus assertion-replay, first-use-windows and data-operation files.
The operator separately verifies this is the running process's actual artifact
and image (including dependencies); local file hashes cannot attest a remote PID.
Keep token/private-key files out of evidence and backups.

```sh
node pcm-connectathon/scripts/reconcile-pcm-handoff.js observe \
  --spec /PRIVATE/observation-spec.json --output /PRIVATE/visible-observation.json
```

4. Review the entire independent inventory against the observation while isolation
   remains in force. Create `handoff-review.json` with explicit approval:

```json
{
  "schema": "pcm-handoff-review/1",
  "approved": true,
  "reviewedBy": "INDEPENDENT_REVIEWER_IDENTITY",
  "reviewedAt": "ACTUAL_UTC_TIME",
  "observationHash": "CANONICAL_JSON_SHA256_OF_OBSERVATION",
  "inventoryHash": "CANONICAL_JSON_SHA256_OF_FULL_INVENTORY",
  "completeFiveTypeInventory": true,
  "noSeedReconstruction": true,
  "inventoryProvenance": "INDEPENDENT_AUTHORITATIVE_RECORDS_AND_COMPLETENESS_REVIEW",
  "processIdentity": "SAME_ORIGINAL_PROCESS_ID",
  "isolationMaintainedUntilStopped": true,
  "hiddenResources": [
    {"identity":"TYPE/ID", "hash":"CANONICAL_JSON_SHA256_OF_EXACT_RESOURCE", "provenance":"EXACT_INDEPENDENT_RECORD_AND_REVIEW"}
  ]
}
```

Use the exported `hash` from `src/shared/migration-hash.js` to compute these
canonical JSON hashes. Include exactly one hiddenResources entry for each full
inventory resource absent from the visible observation; use `[]` only when the
independent review establishes there are none. Approval/completeness/provenance
are explicit human attestations, not inferred from empty results or file presence.
The importer machine-checks exact visible decisions, complete five-key shape,
unique identities, hidden-resource hashes/provenance entries, approval hashes,
runtime/config/reservation stability and the stopped-worker timestamp.

5. Only after that review, stop the original PCM, keeping isolation in force.
   Record its actual UTC exit timestamp, wait 31 seconds, and import:

```sh
node pcm-connectathon/scripts/reconcile-pcm-handoff.js import \
  --spec /PRIVATE/observation-spec.json --observation /PRIVATE/visible-observation.json \
  --inventory /PRIVATE/full-inventory.json --review /PRIVATE/handoff-review.json \
  --workers-stopped --stopped-at ACTUAL_UTC_EXIT_TIMESTAMP
```

The importer writes private checkpoint/provenance files and a matching historical
runtime manifest, fenced until publication completes. It never overwrites existing
migration state. Missing approval, changed/omitted decisions, incomplete paging,
configuration/reservation drift or runtime hash mismatch refuses before writing.
For pre-stop failures keep the original alive and re-isolate/review. For post-stop
failures retain the inventory/observation/review and state bytes; correct only the
identified independently reviewed discrepancy and retry import. Never restart
unbridged or delete state to bypass a refusal. Interrupted initial import retains
a fence: preserve its files and independently reconcile the exact reviewed bytes;
there is no automatic partial-handoff restart or seed fallback.

Start the matching **historical bridged** artifact against the imported state,
then use the existing online freeze, stop, preview/apply procedure. This separate
restart proves the old runtime still interprets the captured old authority. The independent inventory must come from authoritative retained records; a test
fixture or a fresh seed is not a production extraction route.

Set `PCM_MIGRATION_RUNTIME_ID` to the actual reviewed immutable image or complete
source-plus-bridge artifact SHA256 on each side. The runtime verifies this
operator-provided identity against the checkpoint manifest; it cannot attest a
Docker host's image identity itself. The artifact must include the bridge's
shared dependencies. Normal current startup contains the checkpoint owner;
it does not use the legacy preload. Restore the historical runtime with its
matching bridge on rollback, so legacy policy is interpreted by legacy code.

Freeze with the existing authenticated Admin boundary:

```sh
curl --fail -X POST -H "x-admin-password: $TEAM_ADMIN_PASSWORD" \
  http://127.0.0.1:PCM_UI_PORT/admin/migration/checkpoint
```

The Admin **Freeze migration checkpoint** control performs the same explicit
operation. It captures PCM Organization, Endpoint, HealthcareService, Contract
and Consent JSON, and fences new requests/configuration/import operations.
It is separate from the no-write CLI preview. Active, initializing, uncertain
or unreconciled imports/maintenance and configuration publication block it.
Use existing read-only data-operation reconciliation; never replay a saved POST.

Then stop **all** team PCM, Doctor/SP, adapter/gateway and import/maintenance
workers, including external workers. Record the actual UTC stop timestamp.
`--workers-stopped` is an operator attestation; the CLI cannot discover remote
workers. Keep the team unavailable for at least 31 seconds after the final
worker stopped so the existing 30-second private JWTs expire. Restart/recreate
the team's processes against the chosen immutable runtime only after a completed
publication. Recreate containers that bind-mount a config file so they see its
new inode. Publication uses same-filesystem rename and rejects direct-overwrite
fallbacks; mounting the config's parent directory is preferable.

## Review file and no-write preview

Write a team-local review file with this shape, replacing every placeholder:

```json
{
  "schema": "pcm-migration-review/1",
  "runtime": {
    "before": "sha256:ACTUAL_64_HEX_DIGEST",
    "after": "sha256:ACTUAL_64_HEX_DIGEST"
  },
  "sourceMembership": {
    "policy-presence": ["EXISTING_SOURCE_ORGANIZATION_ID"],
    "policy-patient-authentication": [],
    "policy-dependent-discovery": []
  },
  "approvedKeys": [
    {
      "clientId": "EXISTING_REGISTERED_CLIENT_ID",
      "file": "EXISTING_APPROVED_PUBLIC_CERTIFICATE.crt",
      "sha256": "ACTUAL_FILE_SHA256",
      "algorithm": "ES256",
      "kid": "ACTUAL_RFC7638_PUBLIC_KEY_THUMBPRINT"
    }
  ],
  "catalogReconciliation": true,
  "serviceTypes": []
}
```

Membership entries are required for each exact normative Contract logical ID.
Use reviewed **existing eligibility**, with Data Source Organization IDs; never
copy all host names or enroll future sources. An empty array deliberately grants
no sources. Authentication/discovery targets must already be participating HMOs.
A retained self-contained Contract must already have exactly the reviewed list.
Unknown/duplicate/ambiguous sources or recipients fail before publication.

Each registered client needs explicit approval of actual existing registered
public material. Derive `algorithm` and `kid` with
`src/shared/assertion-keys.js` (`signingAlgorithm` and `jwkThumbprint`) and the
file digest with SHA256. P-256 maps to ES256 and P-384 to ES384. Read public
certificates/keys only, independently verify their approval and ownership, then
record the metadata. The tool checks the real bytes and registration; it never
generates a replacement, guesses a key or copies private keys into its backup.
Existing unrelated compatibility registrations are preserved.

`catalogReconciliation: true` explicitly permits an unambiguous retained
singular/object sensitivity field to become the plural `taggedDetails` array,
and a retained FHIR `taggedDetail` part to become `taggedDetails`. Every coding
is validated. Coexisting old/new fields remain ambiguous and fail. A service
whose type needs reconciliation requires an exact reviewed entry:
`{"id":"SERVICE_ID","before":[...],"after":[...]}`. The result must be the
pinned v3 ActCode INFA information-access type. The tool does not infer types
from titles. Logical/business identity collisions and typed Patient mappings
that collapse distinct system/value identities fail for explicit resolution.

```sh
node pcm-connectathon/scripts/migrate-team-config.js --pcm-ig-041 \
  --config /TEAM/team-config.json --state /TEAM/state \
  --certs /TEAM/certs --review /TEAM/migration-review.json
```

Preview writes nothing, including no saved plan file. It reports its digest,
all semantic differences, service retirement/reference decisions, actual
approved metadata and unresolved conversions. Resolve all errors and review the
entire result before apply. Catalog files must be local regular team files.
Unknown configuration settings and invalid finite budgets are rejected.

Only the three normative pairs are converted through the accepted pure
converter. Identity, recipient, representable permissions, historical timestamps
and terminal states survive; unsupported permission content needs a new grant.
An unused normative service is removed only after scanning all remaining PCM
references. Shared/referenced services, clinical Consent services and compatible
custom labelled sampling survive. Unknown/incompatible local Contracts fail.

## Apply and restart

```sh
node pcm-connectathon/scripts/migrate-team-config.js --pcm-ig-041 \
  --config /TEAM/team-config.json --state /TEAM/state \
  --certs /TEAM/certs --review /TEAM/migration-review.json \
  --apply --expected-digest REVIEWED_PREVIEW_DIGEST \
  --workers-stopped --stopped-at ACTUAL_UTC_STOP_TIMESTAMP
```

Apply recomputes and hash-checks every preview input and the operation reservation
set. It preserves exact original config/catalog/checkpoint bytes in private
`state/pcm-ig-041/backup-DIGEST/` files, then publishes a durable write-ahead
journal. Runtime startup refuses a prepared or interrupted publication, so
multiple file renames cannot expose a partially converted authority graph.
Repeating the same accepted digest reports `no-further-work`.

The selected preset, environment/lifetime, supported configuration values,
certificates/client IDs, imports/clinical state,
ledger/reservations and the full non-AWS diagnostic exception are preserved.
Only missing finite global budget fields are materialized; source overrides stay
explicit and the `legacy` budget name remains distinct from `legacy-ds` security.
Test environment does not relax Strict. Normative browser authorization uses
certificate-free HTTPS while backend mTLS and the unrelated connectathon choices
retain their selected settings.

Restart all team processes against the **after** immutable artifact and the same
state mount. New opaque tokens and browser/workflow flows are required. Access
records, OAuth codes/grants and presence caches are cleared; process-local
sessions/cache/continuation codecs disappear on restart. Admin cookies use a new
migration epoch (legacy bridge requires the unchanged password/header instead
of old deterministic cookies). Assertion replay reservations and Consent
first-use windows survive: deleting them would enable assertion reuse or reset
one-time authority. No credentials are captured or restored by this migration.

For migrated teams, the existing FHIRStore owner durably writes its checkpoint
at every committed mutation/transaction. A checkpoint write failure restores the
in-memory data and private authority generations. Supported config saves update
the matching config hash under the shared configuration mutex. Thus a later
revocation, source removal or shortened validity survives stop/restart. External
file edits fail startup matching checks and need explicit reconciliation.
Generic Admin reset/config-certificate restore is blocked for migrated runtimes.

## Interrupted publication and rollback

Keep all workers stopped and use the journal's exact old/new file hashes:

```sh
node pcm-connectathon/scripts/migrate-team-config.js --pcm-ig-041 \
  --config /TEAM/team-config.json --state /TEAM/state --recover --workers-stopped
```

Recovery rolls the journal forward, invalidates transient credentials again and
releases maintenance only after complete publication. Unknown edited bytes block
recovery with the conflicting path and backup location. Preserve those bytes and
reconcile them against the protected backup; do not delete the fence, replay an
import, or start a partially published runtime. An abandoned
`configuration-mutation` directory also needs stopped-worker investigation and
explicit operator reconciliation; it is never reclaimed by age.

Rollback first needs a **fresh online checkpoint of the applied runtime**, then
the same stop/drain boundary:

```sh
node pcm-connectathon/scripts/migrate-team-config.js --pcm-ig-041 \
  --config /TEAM/team-config.json --state /TEAM/state --rollback \
  --workers-stopped --stopped-at ACTUAL_UTC_STOP_TIMESTAMP
```

When safe, rollback restores matching old config/catalog/policy bytes and the
historical bridged runtime identity; it retains the latest Consent decisions.
HO clinical data and import history are never restored/replayed. Obtain fresh
credentials and flows after restarting the matching old runtime.

Any post-apply authority graph or config change conservatively refuses rollback
with `UNSAFE RESTORE`, the changed paths and recovery steps. This includes each
later grant revocation, source removal and validity shortening. Old policy could
otherwise issue fresh unauthorized tokens even after old tokens were deleted.
A byte-exact backup is evidence, not permission to undo restrictions. Keep the
current restricted runtime/checkpoint, then resume it explicitly:

```sh
node pcm-connectathon/scripts/migrate-team-config.js --pcm-ig-041 \
  --config /TEAM/team-config.json --state /TEAM/state --resume-current --workers-stopped
```

Alternatively, review a compatible historical-runtime snapshot that retains every
newer restriction; the automatic tool intentionally does not translate such
changes into a broader legacy grant. Do not copy backup policy bytes over the
current checkpoint.

### Uncertain per-mutation checkpoint publication

Each committed migrated-store write journals its old/new checkpoint and manifest
before publication. A crash or disk error between checkpoint and manifest leaves
`checkpoint-mutation.json`; requests and restart fail closed. The caller's error
means the outcome is uncertain: do not assume rolled-back memory is durable.
Stop all workers, preserve/review the journal's exact before/after authority and
its canonical JSON hash, then explicitly roll forward the reviewed mutation:

```sh
node pcm-connectathon/scripts/reconcile-pcm-handoff.js recover-mutation \
  --spec /PRIVATE/observation-spec.json --workers-stopped \
  --expected-digest REVIEWED_CANONICAL_CHECKPOINT_MUTATION_JSON_HASH
```

This recovery requires the matching runtime/config and exact old-or-new bytes;
conflicts remain fenced for independent reconciliation. It preserves a restriction
that may already have reached disk. It must not be confused with migration
`--recover`, rollback or permission to restore older authority. No failed mutation
can silently leave a successful, hash-invalid restart.

<a id="scope-model-cutover"></a>

## Scope model cutover

This operation converts the earlier permission-simulation configuration to the
current model, where clinical permission and patient/source checks are always
required. It uses the existing checkpoint owner. Keep the original runtime
isolated until a complete authoritative checkpoint or reviewed historical handoff
is available. Do not reconstruct old authority from seeds, today's catalog or
sample tokens.

1. Use the existing authenticated checkpoint action on the actual source runtime.
   Stop PCM, Doctor/SP, adapters and all import/maintenance writers. Preserve the
   original source/config/artifact identity, all first-use/replay bytes and the
   complete five-type inventory. An old runtime without the existing bridge needs
   the documented complete reviewed handoff before this scope step.
2. Prepare a private JSON review with schema `pcm-scope-migration-review/1`,
   canonical `asOf` UTC instant, `runtime.before` matching the frozen manifest and
   immutable `runtime.after`. Set `restartAll:true`; attest actual immutable
   `artifacts.pcm`, `doctor`, `adapter`, `hapi` (`sha256:<64 hex>`), with PCM equal
   to `runtime.after`. Copy the exact complete `versions` object below. Optional
   `beforeVersions` can enable rollback only when it is exactly the same boundary,
   the source config/policy already matches, and no retired control is present.
   An attestation cannot relabel config4 as a compatible config5 rollback artifact.
   Artifact attestations are operator evidence, not automatic backend qualification.
3. Preview without writes:

   ```sh
   node pcm-connectathon/scripts/migrate-team-config.js --scope-model --config TEAM/team-config.json --state TEAM/runtime/state --review PRIVATE_REVIEW.json
   ```

   The first preview reports missing `records` and `retiredControls` review, plus
   `requiredReview`, the ordered retired-control inventory and every before/after
   resource/eligibility consequence. Review each; copy `requiredReview` to
   `records` and the exact retired inventory to `retiredControls`. Preview again
   and retain its digest. Do not insert inferred grants or additional mappings.
   Unknown review fields, malformed snapshots, stale hashes, unsupported config,
   escaping catalogs, unsafe state entries and incomplete artifacts refuse.
4. Apply only the reviewed digest after at least 31 seconds stopped:

   ```sh
   node pcm-connectathon/scripts/migrate-team-config.js --scope-model --config TEAM/team-config.json --state TEAM/runtime/state --review PRIVATE_REVIEW.json --apply --expected-digest REVIEWED_SHA256 --workers-stopped --stopped-at ACTUAL_STOP_UTC
   ```

   Existing scoped byte backups precede journal publication. Exact service and
   Consent records remain unchanged. Config4/policy3 only loses reviewed retired
   controls and gains invariant Patient mapping; current config5 is validated.
   Opaque tokens, OAuth authorization state and source-presence state invalidate;
   first-use/replay records are neither removed nor renamed. Restart **all**
   components using the attested artifacts and matching runtime/config hashes;
   this clears process caches and old signed contexts. Fresh clinical tokens
   still require current eligibility. Unknown/mixed versions deny explicitly.
5. Interrupted apply keeps startup fenced. Use `--recover --workers-stopped` on
   the same `--scope-model --config ... --state ...` command. Files must be exactly
   old or new; original preserved usage/replay hashes must still match. Conflicts
   keep the team stopped. Preserve/reconcile current bytes; never delete a consumed
   record to get recovery to proceed. A repeated apply with the same completed
   digest reports no further work.
6. A fresh checkpoint is required before rollback. Incompatible old scope models
   refuse even without later writes; use `--resume-current --workers-stopped` or
   review a compatible restriction-preserving artifact. Compatible rollback also
   refuses changed authority/config or any post-cutover Consent/source/cancellation
   decision. It retains current first-use/replay bytes, invalidates transient tokens
   and requires the same stopped drain/restart. Never manually copy an old policy,
   snapshot or first-use backup over current state. New tokens or new approval
   cannot make an older revoked token valid again.

The exact target `versions` object is:

```json
{"service":"pcm-service-grant/1","compiler":"pcm-service-scope/1","approval":"pcm-consent-scope/1","token":"pcm-data-grant/6","firstUse":"pcm-clinical-first-use/2","config":"pcm-team-config/5","policy":"pcm-sandbox-policy/4","context":"pcm-ds-authorization-context/4","localToken":"pcm-ds-local-token/5"}
```

Classification is deliberately conservative. Exact versioned service/approval
records are lossless copies, not automatic proof of current access. Legacy
Services lack an exact default; use a new definition or a deliberately selected
new approval alternative. Legacy generated/manual/missing Consent snapshots need
an explicitly requested and approved **new Consent**; their original historical
records remain unchanged and unusable. Issued tokens establish only their own
old grants and are invalidated. Hashed first-use filenames do not reveal client
ownership. Preserve known deadlines and all bytes; an old Consent/source record
continues denying new tuple use until a new explicit decision exists. Terminal,
expired or source-removed records never become active through migration. Literal
history dates, service-default provenance and access periods never refresh.

Fresh shipped demo definitions carry frozen grants. Template recipes compile only
at an explicit new-service creation event. Ordinary startup/reload/reconciliation
never assigns a version to retained legacy records. The labelled legacy Node
backend remains distributed but clinically unsupported. External/custom/native
scope subsets require source-specific proof.

## Public/private metadata cutover

This operation moves application-owned private metadata out of public FHIR
resources while preserving the exact authority records. It requires stopped
writers and an explicit review. Keep the original runtime running until its
complete checkpoint or reviewed handoff is available. Even a complete public FHIR export
cannot recover private decisions, generations, cancellation history or usage.

Use the existing authenticated **Freeze migration checkpoint** action. Its result
lists the five resource types, private/public schema and exact config/checkpoint
hashes. Then stop PCM, Doctor/SP, adapters and import/maintenance workers. Preserve
all source data and original first-use/replay/operation files in their owning state
mount. Observe the existing 31-second private-JWT drain before apply. The Admin
maintenance block reports observed checkpoint phase, exact PCM source artifact,
schemas and changed/unchanged/rejected counts; saving configuration is not evidence
of cutover. The location of the UI control does not change the checkpoint contract.

The current CLI mode is:

```sh
node pcm-connectathon/scripts/migrate-team-config.js --public-metadata \
  --config /owned/team-config.json --state /owned/state --certs /owned/certs \
  --review /owned/metadata-review.json
```

Preview writes nothing. It reports `pcm-public-metadata-plan/1`, exact record IDs,
versions and before/after hashes, changed/unchanged/rejected outcomes, findings,
`measuredComponents`, `measuredBindings`, `requiredReview`, and a digest. It omits
publication bytes and private snapshots. Errors identify the affected record/owner;
retain original bytes and resolve each disagreement before creating a fresh preview.
No winner is chosen between duplicate/contradictory legacy copies. Malformed audit,
missing active/terminal authority, conflicting existing private records, nested
private payloads and trust/config disagreement stop publication. A resource-only
legacy checkpoint must be reconciled against its original live authority owner;
no template, preset, seed marker or token sample can supply missing decisions.

The operator-authored review has these fields (values below describe inputs,
not hashes to copy):

| Field | Required value |
| --- | --- |
| `schema` | `pcm-public-metadata-review/1` |
| `optIn`, `restartAll` | explicit `true` |
| `action` | `relocate`, or separately reviewed `restore` |
| `repositoryRoot` | absolute root of the actual deployed source artifact |
| `runtime.before` | exact frozen manifest runtime ID |
| `runtime.after` | exact `measuredComponents.pcm` |
| `privateSchema` | `pcm-private-state/1` |
| `publicProjectionSchema` | `pcm-public-fhir/1` |
| `scopeVersions` | exact current `src/shared/scope-model-versions.js` `VERSIONS` |
| `components` | exact five-entry `measuredComponents` after reviewing actual inputs |
| `bindings` | exact `measuredBindings` after reviewing actual owner inventories |
| `records` | complete ordered `requiredReview`, including `_private` |

`pcm-component-source/1` measures complete fixed application source roots and
package/lock/config files using canonical SHA256 manifests. PCM owns
`src/pcm-core`, shared and config; Doctor owns `src/sp-client`, shared and config;
adapter owns `src/ds-auth-adapter`, `src/ds-gateway`, shared and config; native owns
`src/ho-fhir-server`, shared and config; CLI owns `pcm-connectathon/scripts`,
`src/pcm-core/src`, shared and config. Only `.git`, `node_modules` and `target`
are excluded. Symlinks, hardlinked files and nonregular files are refused. These
are measured **source artifacts**, not Docker image attestations. Bind runtime
engine/image/native compiled overlays independently for qualification. Every
restarted PCM must retain the same accessible absolute source root; packaging or
moving it requires another reviewed artifact set, never a guessed image digest.

Bindings cover exact validated config bytes, the complete certificate directory
(including private material by hash only), the selected team-local catalog, all
first-use keys/bytes and the operation ledger. Replay files are additionally
preserved. Missing configured certificate files, active/uncertain operations or
configuration publication block migration. Legacy Endpoint trust is compared to
its exact configured source, address and owner; the public normative certificate
inventory remains public. Legacy sampler/seed bookkeeping is moved into the
existing `seedTags`/`bookkeeping` private owner shape without deriving authority
from labels. Custom Contract authorization declarations and ordinary public fields,
profiles, third-party extensions and security/test labels remain unchanged.

After reviewing the second, complete error-free preview, add:

```sh
  --apply --expected-digest REVIEWED_DIGEST --workers-stopped \
  --stopped-at ACTUAL_CANONICAL_STOP_TIMESTAMP
```

Apply remeasures the complete inputs and directory memberships, retains exact
prepublication checkpoint/config/manifest backups in `backup-DIGEST/index.json`,
and writes `private-checkpoint.json` using `pcm-public-metadata-migration/1`.
The latter is the normalized complete public/private candidate bound to actual
components/config/certificates/catalog/usage/operations; raw original legacy bytes
remain in the index backups. It contains no tokens, codes, caches, keys, HO data or
usage-file copies. Preserve those separate owners and protected credential backups.
The existing journal publishes checkpoint/config/manifest atomically from the
operator's perspective. The result reports observed phase, digest, exact scope,
schemas, counts and private-backup hash/path. Old transient tokens/codes/presence
caches are invalidated; first-use and replay state are not reset or renamed.
Private authority epoch/generations, immutable decisions and event history survive.

An interrupted publication leaves the fence/journal in place. Restart refuses.
Use the existing `--public-metadata --config … --state … --recover
--workers-stopped` after reviewing the journal and original backup index. Recovery
remeasures component sources, private backup, certificates/catalog and original
usage/replay/operation directory memberships/bytes. Changed inputs stop recovery;
never delete consumed records to make it pass. Matching old/new publication bytes
are rolled forward. On normal restart, all five component source versions and the
original first-use bytes are checked before hydration. New legitimate first-use
keys may be added; original clocks may not disappear or change.

Rollback uses another fresh frozen checkpoint, stopped/drained workers and an
explicit metadata review with `action: "restore"`, `backupPath` pointing to the
protected private envelope, and `reviewedBackupHash` equal to that envelope's
`hash`. Review current measured components/bindings/records again. Restore requires
compatible schemas and exact external owner bindings and refuses any later
public/private restriction difference, lower revision/generation, changed immutable
decision or lost lifecycle event. This conservative boundary does not copy legacy
public payloads back or restart obsolete component artifacts. A later cancellation,
source edit, certificate/config change or usage binding change may require keeping
the current state and creating a new compatible backup. The generic `--rollback`
refuses metadata manifests with this actionable guidance. `--resume-current
--workers-stopped` remains the way to abandon a rejected preview safely; it cannot
resume an interrupted journal.

All-preset clinical scope/context/grant enforcement remains required. Strict
excludes the sandbox sampler and private source-simulation actions; legacy Node
clinical access remains unsupported. Functional qualification of the resulting
installation is separate from a completed migration command.

<a id="full-access-definition-cutover"></a>

## Full-access definition cutover

Use the preview, apply, recover and restore commands from the public/private
metadata procedure above. For the [current built-in service](../docs/service-templates.md#built-in-catalog-and-creation-templates),
explicitly install the new packaged built-in team-catalog entry while
stopped, binding original private checkpoint/usage owners and measuring all five
component artifacts. The review uses `action: "full-access"`, canonical `asOf`,
current scope versions and `fullAccessReview` from `requiredFullAccessReview.digest`.
Both the transition digest and full plan digest must be reviewed; first previews
with missing acknowledgment are intentionally rejected. Existing CLI arguments and
stopped/drained apply rules are unchanged. Copy the exact reviewed record hashes;
never invent grants from old token samples or public exports.

Apply appends a new stable built-in definition version only; old approvals remain
narrow and transient tokens are invalidated. New `patient/*.rs` approval is explicit.
Provider pause/disconnect preferences persist, and uninitialized historical absence
is conservatively disconnected. A newly registered provider uses the accepted
idempotent default-enrollment hook. Current compatible private backups restore via
the same journal; later revocation or owner/usage differences refuse rollback.
An uncheckpointed factory reset starts with fresh defaults.

## Ordinary configuration backup and live restore

Admin → Maintenance exports the existing complete `teamConfig`, certificate file map
(including private keys), public thumbprints and export metadata. It is an ordinary
configuration/credential JSON file, **not** a clinical database, full Consent/runtime,
log-history, volume or HA/DR backup. Keep it private. File selection and paste fill the
same ephemeral field; neither stores backup contents in browser storage or URLs.
Restore accepts at most 1 MiB, the exact current team/config version and a freshly
reviewed saved revision. API callers send the complete export plus current
`expectedRevision`, or wrap it as `backupJson` with `expectedRevision`.

Live compatible restore requires unchanged deployment/listener/contract/credential
bindings, preset and exact credential file names/bytes. It validates the complete
configuration and retained source-removal history before writing. Within the existing
configuration mutex and exact-byte `source-publication.json` owner it publishes the
compatible config, clears PCM resources/private runtime authority and issued tokens,
and bootstraps the configured catalog/resources. It does not recover old runtime
Consents or catalog choices. Clinical source databases and log files are untouched;
other components' adoption remains unobserved. An ordinary error restores exact
prior config/public/private graph; an uncertain rollback preserves the journal/mutex
and blocks requests until stopped-worker exact-digest recovery. Never delete that
mutex to make the runtime available.

For changed material, the live route returns HTTP 409 **before any write**. The existing
controlled operator owners are:

- Preset/listener changes: preview `node pcm-connectathon/scripts/reconfigure-local-team.js
  --team-id TEAM --preset PRESET --print-plan`. After review, remove `--print-plan`
  to stop the team, write the settings and recreate its containers; this command
  does not use `--apply`. Keep volumes and original identity.
- Team-owned leaf renewal: preview `node pcm-connectathon/scripts/rotate-team-certificates.js
  --team-id TEAM`, then use its explicit `--apply` only after reviewing scope and private
  backup. Roots and participant-owned leaves stay protected. `--rotate-keys` is a
  separate explicit decision; obtain fresh tokens after key changes.
- Older/different credential or deployment backups: preserve the JSON and current
  full private team directory; reconcile exact team, config version, certificate
  ownership/pairs and environment bindings with the original operator while all
  PCM/SP/adapters/import workers are stopped. Stage and validate using the current
  credential/config owners before any publication or listener recreation. The browser
  offers no arbitrary old-key/root replacement or automated JSON-to-deployment restore.
  Existing `backup-team.js`/`restore-team.js` ZIP directory portability is a different
  operation and is **not** a safe substitute for retained authority recovery. Do not
  unzip over a running or retained migrated team, replace roots, or overwrite later
  restrictions with old bytes.

Any runtime with a migration checkpoint refuses ordinary restore/reset. Use the
[public/private metadata workflow](#publicprivate-metadata-cutover)
for the separately versioned `pcm-public-metadata-migration/1` backup. That envelope
contains public/private checkpoint authority and binds all five component source
artifacts plus config/certificate/catalog/original-usage/operation owners. It does
not contain clinical databases, transient tokens/codes/caches or external usage-file
contents. Keep original artifact roots available at restart. Preview never freezes;
Freeze is explicitly confirmed, then all workers must stop and private tokens drain
for 31 seconds. A reviewed compatible restore refuses later restrictions or changed
external bindings.
