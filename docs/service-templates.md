# Services, provider connections and consent

A service describes why an application wants health information and what access
it proposes. For example, a laboratory follow-up service can request Patient and
Observation reads and searches. It is a definition of requested access, not a
list of patients, an import job or permission to fetch data by itself.

The sandbox keeps four related things separate:

| Thing | What it means |
| --- | --- |
| Service definition / catalog entry | The purpose, proposed scope and maximum consent period. |
| Provider connection / registration | One registered application provider's association with that service. |
| Consent and its approval | The actual patient, approved sources, permission and validity. |
| Access token | Short-lived authority used for one source, subject to the current Consent and other checks. |

Services has two peer views: **Service catalog** for definitions and **Provider
assignments** for connections. Both are protected Admin inventory. Browsing them
does not perform ordinary provider discovery, enroll a provider or obtain a token.
A catalog entry does not prove that any source contains a patient's records.

## Create and connect a service

1. In Services, select **New service**. Choose Blank or a template and enter the
   name and purpose. A template only fills a draft; it creates nothing yet.
2. Review the data categories, resource actions, record history, sensitivity and
   maximum consent period. Hospital (35) is the service classification, while
   categories such as Laboratory tests describe the requested information.
3. Review **Final service scope**. Choose generated settings or exact manual text
   as explained below. Example queries are illustrative text and are not executed.
4. Select **Create service**. This creates one pending catalog definition with
   zero provider connections. Private sandbox creation is unavailable in Strict.
5. Approve the definition in **Service catalog**, then use **Connect providers**.
   A connection request starts Pending; its activation is another explicit action.
6. Use that provider's service in Doctor to request Consent. The patient approval
   remains separate from catalog approval and provider activation.

Back / Cancel and ordinary view navigation preserve the in-memory creation draft.
Changing a template with unsaved edits asks for confirmation. Refresh keeps the
live draft but may reveal changed catalog data; stale mutation requests are
rejected. After an uncertain action, inspect or refresh the exact record instead
of submitting the mutation again.

### Generated and manual scopes

**Generated from settings** builds the scope from the selected resources, actions,
categories, sensitivity and history. The preview shows the exact scope and the
instant used to calculate dates. Generated browser saves need a current signed
preview; an expired or changed draft must be previewed again.

**Edit exact scope manually** copies that text into Manual scope. The manual text
is then the complete permission expression. Generator controls remain visible but
inactive; they do not add hidden restrictions to the manual scope. Switching back
requires reviewing and accepting the replacement. Name, purpose and access-period
edits do not silently regenerate manual text.

Manual text is preserved exactly, up to 16,384 characters, including whitespace
and line breaks. Advice distinguishes syntax, applicability and known source
support. Experimental or malformed manual text can be saved with a warning;
saving it does not make it executable authority. Unsupported approval text is
denied at token/source use, rather than silently simplified. The current native
parser requires single spaces between scope alternatives; other whitespace can
remain saved but unsupported. Correct permissions with a new supported definition
and Consent decision, not by rewriting an existing approved snapshot.

## Consent duration and record history

These answer different questions:

- **Consent period:** how long the application may access records.
- **Record history:** which dated records are in scope.

Six months of consent can allow records from the past two years. Generated
record-history dates are fixed when the service is created. Default approval
copies those saved dates; it does not recalculate "two years ago" whenever a token
is requested. An explicitly generated approval alternative can use its own fixed
approval-time date. Manual dates stay literal. A fixed lower cutoff continues to
admit newer matching records; it is not a moving time window.

The pending Consent approval screen offers four choices: the service-provided
scope, an automatic resource-based scope, an automatic category-based scope, or
exact custom scope. Generated/manual alternatives are explicit sandbox approval
features and can differ from the service default. They do not amend the external
PCM implementation guide's patient-portal rules. Review the displayed permission
before approving. A missing or unusable legacy default never becomes broad access.

Approval freezes the exact text, choice, origin, bound service versions and
validity in the private Consent record. Token issuance and active introspection
return that scope unchanged. The token request's well-formed unfiltered resource/
action scope is advisory in this sandbox; it does not intersect, expand or replace
the approval. Malformed OAuth/RAR/scope inputs still fail. Clients must use the
returned authority when choosing clinical queries.

Changing selected sources preserves the approved scope and existing usage
windows. Cancellation is terminal. Changed permissions require a **new Consent**;
editing a template, service, preset or current clock cannot rewrite old approvals.
For one-time access, the first qualifying source introspection starts the source's
one-hour window, bounded by other authority deadlines. Token reissue, retries and
Doctor's optional own-token inspection do not reset or extend it.

## Provider connection and catalog actions

Catalog actions affect the definition for all connected providers. Provider
actions affect only the named registration and use that provider's own credentials.

| Action | Meaning |
| --- | --- |
| Approve catalog | Make a complete pending definition active. It needs no provider connection to be approved. |
| Disable / Enable catalog | Change global availability; preserve provider pauses, cancellations and historical records. |
| Connect | Submit a new provider request. It starts Pending, not Active. |
| Activate · Admin | Explicitly activate a pending connection when the catalog/provider prerequisites hold. |
| Pause / Resume | Suspend or resume an eligible owning-provider registration. |
| Withdraw request | Terminal cancellation of a pending request. |
| Disconnect | End the connection. An active connection is paused and then ended in separate checked operations, not one atomic call. |
| Delete | Permanently remove one eligible inactive record, without cascading into other records or clinical data. |

Reconnecting after terminal cancellation creates a new request and does not revive
old approvals. Stored connection status and current availability are different:
an active registration may be unusable because its catalog or provider is disabled.
Missing credentials mean the ordinary provider action is unavailable; the sandbox
does not borrow another provider's identity. Configuration still owns the runtime
OAuth clients and certificate roles; merely listing an Organization does not onboard
an executable client. Private create/validate/lifecycle actions are excluded in Strict.

Deletion is blocked by registrations, Consents including terminal history,
Contracts, retained private approvals, seed references and the protected built-in
full-access identity. Removing a display name or seed entry does not remove that
protection. Resolve a reference through its owner; deletion is not a reset shortcut.

Uncheckpointed runtime changes are lost on restart/reset. An explicit retained
checkpoint can preserve services and registrations. Deleting a service or provider
registration does not delete clinical records or the files used to seed the
catalog. See [backup and migration](migration.md).

### Reading provider pages correctly

Provider assignments groups actual registered providers under each service,
including inactive providers and those without configured runtime credentials.
Pending, rejected, frozen, suspended and cancelled states stay distinct.
**Not connected** is meaningful only for a loaded, complete provider/service pair.
An unloaded page or failed request is not evidence of zero connections.

Inventory pages carry a revision. Stale continuation returns 409; Refresh starts
a new snapshot. Reaching the last page does not prove that earlier pages were
loaded. Credential capability means the needed configuration/files are present,
not that a live OAuth request succeeded.

## Built-in catalog and creation templates

These are separate inputs. `config/demo-services.json` seeds the team's catalog
and its provider bindings. `config/service-templates.json` supplies editable
starting points for creating **new** definitions. Changing a template does not
update a seeded definition, provider registration or existing approval.

The seeded examples cover laboratory follow-up, medication/allergy review,
cross-organization summaries, procedure/immunization review and full clinical
access. The built-in full-access example uses exact `patient/*.rs`: supported
patient-context reads/searches, including R and V confidentiality labels. It
still needs explicit approval and all patient/source/lifecycle checks. It does
not promise unsupported resource operations or unrestricted master-data search.
New registered providers receive the default connection through provisioning;
browsing a page never enrolls them. Saved pause/disconnect preferences survive
compatible checkpoint restore. Older catalogs need the reviewed
[full-access migration](../pcm-connectathon/retained-team-migration.md#full-access-definition-cutover).

The five creation templates currently provide:

| Template | Clinical resources and history, in addition to Patient read/search | Other rules | Consent period |
| --- | --- | --- | --- |
| Laboratory result follow-up | Observation, 2 years | Ordinary sensitivity; R/V excluded | 3 months |
| Diabetes follow-up | Condition and AllergyIntolerance, 5 years; Observation, 2 years; MedicationRequest, 1 year | HIV-tagged diagnoses/labs included within their rules; R/V excluded | 6 months |
| Cardiovascular follow-up | Condition, 3 years; Encounter, 6 months; Observation and MedicationRequest, 1 year | Mental-health-tagged diagnoses/encounters included within their rules; R/V excluded | 6 months |
| Post-discharge review | Encounter and Observation, 3 months; Condition and MedicationRequest, 1 year; AllergyIntolerance, 5 years | Adds Organization/Practitioner direct reads; R/V excluded | 1 month |
| Basic patient data | Exact Patient, Observation and Condition read/search scope | Manual scope: V excluded, R allowed; no history, category, sensitivity or master-data predicates | 3 months |

Titles do not add diagnosis or medication-name filters. Selecting a medication
category does not automatically select every Medication resource type. Ordinary
and tagged scope alternatives each retain their own complete history and
confidentiality restrictions. An allowed sensitivity tag does not override an R/V
exclusion. Unknown or mixed labels can be refused by the current native matcher.

For Basic patient data, inactive generator settings are descriptive inputs, not
hidden restrictions on its manual scope. Its exact scope is:

```text
patient/Patient.rs?_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V patient/Observation.rs?_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V patient/Condition.rs?_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V
```

## Customize the template file

The file is read and validated when templates are loaded or used to create a
service. A valid replacement is available on the next request without restart.
A missing or invalid file disables templates with an explanation; manual service
creation remains available. Existing services and Consents are unchanged.

Copy a complete existing template and give it a unique key and name. The file
uses `schemaVersion: "pcm-service-templates/1"`, contains 1–50 entries and has a
maximum size of 256 KiB. See the [maintained file](../config/service-templates.json)
for complete examples.

| Field | Meaning |
| --- | --- |
| `key` | Unique lowercase template key; not a PCM service identifier. |
| `summary`, `dataDescription` | Purpose and data descriptions shown to the author. |
| `definition` | `name`, `purpose`, `category`, `accessMode`, `duration`, `durationUnit`, `allowChanges`, `buckets`, `permissions`, and applicable scope/confidentiality options. |
| `definition.buckets` | Each category's `code`, `history`, `historyUnit` and `sensitivity` choices. |
| `definition.permissions` | Resource `type` and `actions` (`r`, `s` or `rs`); Patient `rs` is required. |
| `definition.includeMasterData` | Optional, default false; adds supported Organization/Practitioner direct-read scopes and examples. |
| `definition.scopeOrigin`, `definition.approvalScope` | Generated scope or the complete exact custom expression. |
| `definition.confidentialityPolicy` | Includes the declared `allowRestricted` choice; it must agree with the final scope. |
| `exampleQueries` | One `{type, query}` example per selected permission; displayed, never automatically executed. |

Search examples require one `_count` between 1 and 100. Read examples use a
known logical ID or `[record-id]`. Do not add master-data query entries; those are
appended by the builder. Examples must agree with their declared operation and
grant. Duplicate/unknown fields, unsupported types, category/permission mismatches,
invalid durations and unsafe/unbounded template query examples are rejected.
The authoring form's editable query metadata is illustrative text; changing it
does not change authority. A stale template hint requires refreshing the picker
or deliberate manual creation; it never silently replaces an existing draft.

## Technical integration reference

Use the selected team's public URLs and the exact **provider instance** reference
and official instance identifier returned for that provider. The shared catalog
definition has a different identity. A provider cannot reuse another provider's
registration or credentials. The browser supplies action targets, not ownership.

Public FHIR resources retain the standard contract. Runtime service grants and
Consent snapshots are private versioned records, not custom authority extensions
to read from public FHIR. Clients obtain usable scope through the normal Consent,
token and introspection flows. See [architecture](../system-architecture.md).

| Protected Admin interface | Important input/result behavior |
| --- | --- |
| `GET /admin/services/inventory`, `/providers`, `/inventory/:id/providers` | `pcm-admin-services/1`, no-store; offset 0 by default, limit 1–50 (default 25), nonzero offset requires exact revision; stale revision returns 409. |
| `POST /admin/services/preview` | `{csrf, definition}`; legacy providerRole envelope also accepted. At most 32,768 JSON bytes. Generated output includes exact scope, date anchor and a signed proof valid for 15 minutes. Manual advice is advisory. No source or patient lookup. |
| `POST /admin/services/catalog` | `{definition, expectedRevision, csrf, previewProof?}`; creates one pending definition and zero connections. Browser-generated saves require their matching proof; direct creation without proof calculates at creation and must inspect returned readback. |
| Catalog validate/lifecycle actions | Exact record version and target-bound CSRF; validation does not approve or grant access. |
| Provider assignment/status actions | The owning provider's actual credentials and fresh record state; no cross-provider substitution. |

Private service definitions retain exact scope/origin, authoring inputs, compiler
version and fixed history anchor separately from diagnostics. Private approval
snapshots retain the selected text, service versions, actor, approval time and
validity. Diagnostics do not rewrite either record. Mutation, lifecycle history
and checkpoint publication share the store transaction; an uncertain checkpoint
requires the [recovery procedure](../pcm-connectathon/retained-team-migration.md).

The [Admin API](openapi-admin.yaml) describes management endpoints. Canonical
protocol requirements remain in the [external references](external-references.md).
