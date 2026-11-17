# Sandbox import and recovery tooling

This directory owns the application's FHIR transaction import, source mapping,
verification and uncertain-operation recovery. Synthetic population datasets and
generators are published separately in
[HDP-synthetic-dataset](https://github.com/ronenabra/HDP-synthetic-dataset); see
[dataset ownership and import](../docs/datasets.md) for the pinned release,
checksums, explicit HO mapping and identity limitations.
No population dataset release is bundled here.

`ci/`, `demo/`, `demo-qualification/` and `pcm-ig-040/` are small,
deliberate regression inputs. Current tests and runtime verification consume these exact inputs. They do not imply production patient data, a populated
installation, clinical approval or a general-purpose synthetic population release.

## Input contract

The importer accepts a nonempty FHIR R4 transaction Bundle in one JSON file.
Entries need unique `urn:uuid:` fullUrl values and supported POST/PUT requests.
Resources must have consistent synthetic dataset-version and source tags; local
references must resolve. `transaction-bundle.js` owns the accepted resource set,
shape/tag/reference checks and limits. Every HO mapping is explicit; a filename
or source label never silently chooses a target.

Admin/CLI use a private maintenance credential and inspect the bundle before
mutation. Completion depends on the operation ledger, per-entry responses and
verified source/dataset counts. A timeout does not prove no mutation happened.
Inspect an uncertain operation and use supported reconciliation before retrying.
Target replacement deletes that target's data/history and requires deliberate review.

`workflow.js`, `operation-owner.js`, `reconciliation.js` and the loader entry points
share this application boundary. Dataset clinical assumptions and qualification
belong to the external publication, not this importer. Default bootstrap is empty;
explicit import instructions are in [the dataset guide](../docs/datasets.md).

## Choose an import policy

| Policy | Effect on the selected organization |
| --- | --- |
| `disabled` | Skip the bootstrap import. New managed databases start empty. |
| `if-empty` | Load the selected bundle only when the target is eligible for an empty-target import. Inspect the operation if it reports a conflict. |
| `replace` | Reset this target, including resource history, then load the selected bundle. Confirm the target and preserve any data you need first. |

For example, after extracting the verified 1k dataset, import just its HMO
bundle into HO A of the team created in the README:

```sh
node pcm-connectathon/scripts/run-clinical-import.js --team-id public-demo \
  --teams-root tmp/connectathon-teams --ho ho-a --policy if-empty \
  --bundle-root "$PWD/tmp/external-datasets/4.2.2-2026-10-10/1k/bundles" \
  --bundle hmo.source.transaction.json
```

## If an import stops

1. Open the operation in Admin **Sources & data**. HTTP 202 means the upload was
   accepted. Use the operation ID to follow validation, loading and verification.
   Admin and the CLI share reservations for the same target.
2. If the worker stopped or timed out, preserve the original bundle and operation
   record. A transaction can finish after the caller loses its connection.
3. Confirm the worker has stopped before requesting recovery. The protected
   recover operation compares the saved upload with live contents, references,
   counts and history. It can release an abandoned pre-submission reservation
   or record a verified success. An unresolved operation keeps the target blocked.
4. If recovery cannot prove completion, inspect the evidence before choosing
   a target reset. Reset requires confirmation of the exact target and that
   the worker and its HAPI transaction have stopped. The database must be
   reachable for recovery and verification.

The [Admin API](../docs/openapi-admin.yaml) documents the recover and reset
requests. Neither operation resubmits the saved transaction.
