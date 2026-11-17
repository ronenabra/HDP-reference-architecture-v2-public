# Data Source implementation guide

The reference Data Source is a protected FHIR R4 HAPI origin behind one gateway
and one auth adapter per Health Organization (HO). In strict mode, the gateway
requires trusted mTLS. Connectathon uses the four presets and named simulation controls in
[operating profiles](../docs/scope-enforcement.md). Every preset, including Easy, enforces exact approved clinical scope and
Patient/source/current-authority boundaries. Only six named transport/assertion
simulations are configurable; AWS credential isolation stays on.

## Request pipeline

1. The gateway strips client-supplied internal headers and authenticates the
   public request through its colocated adapter.
2. The adapter introspects the opaque PCM token for the exact HO Endpoint and
   validates the closed PCM-IG 0.4.2 response variant and current authority.
3. The adapter signs a `pcm-ds-local-token/5` JWT with `pcm-ds-authorization-context/4` capped by the active PCM
   decision and bound to the current source policy fingerprint, HO,
   HAPI audience, token class, exact HTTP method, and exact request URI.
4. HAPI verifies that JWT with the configured pairwise certificate, resolves a
   Patient business identifier to exactly one local Patient when required, and
   applies the same deny-first pipeline to every protected result.

Callers cannot supply or override the adapter context. Missing, expired,
wrong-audience, cross-HO, wrong-class, malformed, or request-mismatched context
is denied.

## Supported clinical authorization subset

Every preset accepts supported `patient/<Resource>.<r|s|rs>` and
`system/<Resource>.<r|s|rs>` for declared R4 resource types. `r` permits read,
vread, and instance history; `s` permits type search, type history, and native
continuation pages. A search is never admitted by an `r`-only grant, and a
direct read is never admitted by an `s`-only grant.

Each independently granted scope is an alternative allow rule. Therefore two
scopes for the same resource type use standard OAuth/SMART union semantics.
All constraints within one scope remain conjunctive, including ordinary FHIR
multi-parameter and repeated-value behavior.

The bounded filter vocabulary is `_security`, `_security:not`, `identifier`,
status and ordinary token values, ordinary references, and tested date
prefixes. HAPI's native `AuthorizationSearchParamMatcher` evaluates these
filters. `RuleFilteringConsentService` filters primary results, direct reads,
`_include`, `_revinclude`, referenced resources, history, and every page.
Authorized queries with no visible resources return a successful empty Bundle.

Default ordinary clinical Bundles and `_total=none` omit `Bundle.total`.
The completed COUNT/PAGE/TOTAL/EVERYTHING capabilities add these bounded paths:

- Clinical type searches accept `_summary=count` and its `_count=0` alias under
  search authority, returning exact distinct authorized totals without entries or
  paging links. Incomplete/interrupted work fails; it never returns a partial total.
- Authorized continuation pages bind source, Patient, query, operation and effective
  authority and recheck current resource bodies. They are not a clinical snapshot.
- Explicit `_total=accurate` combines an exact authorized count and bounded page
  under a common deadline and source-local mutation fence. Concurrent mutation can
  refuse the request; changed generations invalidate accurate cursors. Unsupported
  estimate/duplicate/malformed controls reject.
- Single-target Patient `$everything` accepts the instance and no-ID GET forms,
  with only `_type` and positive `_count`. The verified Patient and per-type search
  grants constrain every page; unsupported operation controls fail closed.

See the [native implementation boundary](../src/ho-fhir-server/README.md) and
[architecture](../system-architecture.md)
for budgets, mutation/writer limits and exact accepted evidence. These capabilities
do not widen the distinct presence and projected workflow grants below.

## Patient presence

Online presence is a separate count-only grant. An active `online-presence`
decision with exactly one Patient context admits only the same exact Patient
identifier in a GET search containing exactly `_summary=count&_count=0`.
After that pre-authorization, the response is a searchset with `total` zero or
one and no entries, links, Patient demographics, or clinical resources.

Batch presence uses POST at the exact Data Source FHIR root. The gateway mints
a root-POST binding only for `batch-presence`; HAPI's custom provider requires
`Bundle.type=batch`, GET entries with the same exact count-only shape, and an
identifier present in the constrained scope. It returns `batch-response` with
one isolated status/searchset or safe OperationOutcome per entry. Transactions,
entry resources, conditional headers, mixed operations, and extra query fields
are rejected and never reach generic HAPI transaction execution.

`presence.batch.maxPatients`, `maxPayloadBytes`, and `timeoutMilliseconds` in
team config are local operational controls. The pinned PCM-IG 0.4.2 leaves national
values, discovery/agreement, retry policy, and exact oversize policy unresolved;
the sandbox example values make no normative claim.

## Fail-closed boundary

The public clinical gateway and HAPI deny writes, transactions, generic batch,
bulk/admin routes, unadvertised operations, undeclared resources and unsupported
Binary/Attachment delivery. General advanced filter-scope forms (`_has`, `_filter`,
`_lastUpdated`, arbitrary chains/composites and unselected modifiers) are unsupported. They reject rather than
being ignored or approximated. The documented bounded count/page/total/$everything paths remain supported.

PCM-IG 0.4.2 authentication/dependent-discovery workflows separately admit their
exact projected Patient/RelatedPerson queries, representative reverse-chain and
bounded batch forms. Those Contract-owned exceptions do not enable arbitrary
clinical reverse-chain searches or generic HAPI batch execution. Private maintenance
uses its own protected boundary and is not application clinical authority.

Denial responses contain a generic, identifier-free OperationOutcome. The
external CapabilityStatement is filtered to the supported gateway surface and
does not advertise HAPI's wider native behavior.

## Local verification

`pcm-connectathon/scripts/run-sanity-check.js` verifies the local consent,
token, and three-HO data path. The generated strict matrix additionally checks
resource and interaction grants, exact Patient mapping, bucket and sensitivity
filters, union/conjunction, includes/revincludes, history, paging, safe empty
results, unsupported forms, and pairwise cross-HO denial.

The active non-strict deployment includes a separately labelled Node compatibility
source for identity/health/logs; clinical access denies because it has no qualified
matcher. It is excluded from managed-HAPI operations and strict results.

This implementation can earn `STRICT SANDBOX PASS` only through the independent PCM-Tester; local runtime
qualification alone does not confer that verdict. That phrase is not a production, national certification, or
security-completeness claim.


Sandbox grant and limit behavior
------------------------------------------------------

Normative presence/authentication/discovery context contains the Contract and
Patient or representative, without HealthcareService or organization_id. Consent
retains its service and PCM-derived organization_id. Every workflow alternative
carries the patientDemographics security predicate; discovery RelatedPerson also
carries hmo-dependent-discovery, while Patient retains the representative reverse
chain. Authentication is patient/Patient.s with only the demographics predicate;
its Patient comes from enriched context. Labelled local sampling keeps its
Contract/service pair, HTEST restriction, independent expiry/audience enforcement
and distinct scope; it cannot validate as a normative workflow.

The initial 100-patient count is configurable. presence.batch supplies global
maxPatients, maxPayloadBytes and timeoutMilliseconds plus optional maxRarBytes
(default 32768), maxFormBytes (65536), maxEncodedFormBytes (196608) and
maxResponseBytes (262144). presence.sources can override any of these for ho-a,
ho-b, ho-c, registered custom source IDs or legacy. Unspecified fields inherit the global value, then the shared
finite default. maxPatients supports 2 through 10000; byte ceilings are 16 MiB
(and 48 MiB for encoded forms), timeout at most 300000 ms. These are sandbox
operational ceilings, not national defaults. Admin Sources & data exposes shared
and selected-source budget editors with Inherit/custom values and explicit adoption
status. The existing validated CLI/config-backup paths remain available. A save is
not proof that each running consumer adopted it. Preset changes retain the budgets.
No retained team is migrated automatically.

RAR limits count the decoded authorization_details UTF-8 JSON string, including
whitespace. Form limits count decoded names, '=', values and '&' separators in
UTF-8; encoded transport bytes are bounded independently before URL decoding.
Distinct supported (system,value) identities count once; duplicate identities
are rejected. Token and active-introspection response budgets count compact UTF-8
JSON bodies independently. The transport envelope is the largest configured source
limit; each resolved target is checked against its own limits before assertion
verification. Response projection precedes assertion replay consumption and token
creation. The source workflow client uses the same selected-source limits.

Workflow errors remain OAuth errors: missing/unknown/duplicate singleton form
fields, encoded/decoded size limits and over-budget decoded RAR return
invalid_request (400); duplicate resource returns invalid_target (400);
invalid/duplicate/unsupported RAR context, over-limit patient cardinality or an
over-budget effective token response return invalid_authorization_details (400).
Invalid resource is invalid_target (400), invalid scope is invalid_scope (400),
invalid assertion is invalid_client (401), and an ineligible token role is
unauthorized_client (401). Authorization-code failures retain invalid_grant
(400); malformed code forms retain invalid_request (400). Inactive introspection
returns exactly {"active":false}, including an over-budget active projection.

Issued authority is frozen. Contract/source removals, dependency changes and
accepted entitlement/eligibility removals irreversibly invalidate old grants;
restoration requires a new token. New authority cannot widen an issued grant.
The private authority store's fresh epoch invalidates persisted data tokens after
process/store reconstruction. Revocation markers live beside opaque tokens until
their retained availability ends and are reclaimed with them. A wrong caller
cannot revoke another token. Active introspection expires within 30 seconds and
all known authorization deadlines, preserving the existing positive-cache delay.
A Contract applies inclusively at its end, but issuance still needs at least one
whole positive second: no rounded-up lifetime crosses its deadline. Contracts
without an end remain bounded by the configured 30-second production or
86400-second test maximum. Existing shorter positive lifetimes, Consent first-use
windows and named simulation controls remain authoritative.
