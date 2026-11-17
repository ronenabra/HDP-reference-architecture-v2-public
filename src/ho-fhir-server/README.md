# PCM HAPI FHIR server

This custom HAPI JPA Starter 8.10.0 distribution provides the private clinical
origin for each health organization. The gateway is the published boundary;
FHIR/management ports and PostgreSQL stay on the team's private network.

The native module verifies a short-lived request-bound context from its adapter,
maps the approved SMART grant into HAPI authorization and Consent filtering, and
fails closed. HAPI owns persistence, supported query parsing and ordinary result
matching. Patient selection covers the resolved self and authorized links before
materialization; final current-body checks still apply.

Supported clinical GET/form POST searches, counts, paging and single-Patient
`$everything` have finite budgets and authority-bound continuation. Unsupported
query/scope shapes reject. Private maintenance/import uses separate credentials;
it never supplies Doctor clinical authority. See [scope behavior](../../docs/scope-enforcement.md)
and the [external standards](../../docs/external-references.md).

## Reads, searches and paging

Clinical clients use the selected source's gateway. HAPI resolves the patient,
runs the supported search and checks the current resource bodies against the
approved grant. A caller with read permission can retrieve an authorized record
by logical ID. Search requires search permission. Organization and Practitioner
master-data read permissions support a direct GET by known ID.

| Request | Result |
| --- | --- |
| Ordinary type search, GET or form POST to `[type]/_search` | One page of authorized matches. The ordinary page size defaults to 20 and is capped at 100. Doctor normally asks for up to 10. |
| `_summary=count` or `_count=0` | A Bundle containing the exact number of distinct authorized primary matches, without result entries or a next link. Included resources do not count. |
| `_total=accurate` on a page | A page with an exact total under the same query budget. Ordinary pages omit the total by default. |
| Patient `$everything` | One resolved patient. Supports `_type` and a positive `_count`. Returning related records requires search permission for their actual types. |

Follow the server's next link with fresh authority for the same request and
source. HTTP 410 means the retained search is no longer usable. Start a fresh
search. Accurate totals assume one HAPI writer per organization. A concurrent
write can interrupt the initial search, and a later write can invalidate its
cursor. After direct SQL or out-of-process maintenance, restart HAPI before
using its retained searches.

## Query limits and errors

In Admin, open **Sources & data → Request & processing limits → Clinical query
processing** for a managed source. A saved limit applies to newly admitted
requests. A running request keeps the limits it started with.

| Budget | Default per managed source |
| --- | --- |
| Time, concurrent queries, cumulative worker allocation | 10 seconds, 2 queries, 256 MiB per query |
| Work to fill one page | 5,000 candidate IDs, 5,000 resource bodies, 32 refill rounds |
| Page output | 100 includes and 100 outcomes, 2 MiB serialized |
| Exact counts | 100,000 candidates, 2,000,000 native ID visits |
| Retained searches | 128 searches, five-minute lifetime from creation |
| Request limits | 8,192 URI characters, 57,344 bytes of private authorization context |

When the server cannot finish an exact count, it returns an error. A failed
query has no usable partial total. Look for the measured setting, threshold and
stage in the [Logs guide](../../docs/logging-platform.md). The [shared limits](../shared/clinical-query-limits.js)
define the configuration keys, units and allowed ranges.

## Build and inspect the server

Run `./mvnw clean verify` here with JDK 17+ for the native module package checks.
The wrapper verifies its Maven distribution. The package includes a CycloneDX BOM
at `target/bom.json`; the runtime image carries it at `/app/sbom/pcm-ho-fhir.cdx.json`.
Normal team bootstrap builds the image using its selected version tag.

Upstream base identities are in [UPSTREAM-PINS](UPSTREAM-PINS.md); see
[notices](THIRD_PARTY_NOTICES.md). The build removes the known upstream test keystore
and records that operation; it does not imply that inherited dependencies have no
vulnerabilities. Review source/image scan findings for the exact distributed image.
