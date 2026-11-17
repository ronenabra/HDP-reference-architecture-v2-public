# Logs and request investigation

Logs helps you answer **what happened to this request?** It brings together PCM,
Doctor, the health-organization gateways/adapters, HAPI and registered local
extensions. Start with the source and request identifiers, then inspect the
recorded events. A healthy log source or a group of related rows does not prove
that every step of a journey was recorded.

Open central **Logs** from Doctor or PCM. Doctor also has a local viewer for its
own service; use **Open central Logs** for retained searches, cross-source
investigation, full downloads and built-in log clearing.

## Read the live view

**Following latest** means the viewer has caught up through the captured interval.
Selecting an event or scrolling into history holds your position while background
checks notice newer events. **Jump to latest** catches up without discarding the
intervening history. **Updates unavailable** is a read failure, not an empty log.

Timeline orders the loaded events by time. Group related events uses recorded IDs
and display heuristics within the loaded page; it may reorder rows and is not a
complete trace. Coverage shows which sources contributed and which failed. Click
a source, role or organization there to filter that dimension. An empty result
may reflect combined filters, retention, missing instrumentation or an unavailable
file; it is not proof that no request ran.

Select a row to open Event detail. The tabs provide different views of the same
record:

| View | Use it for |
| --- | --- |
| JSON | The complete normalized event object. |
| Structured record | Recorded HTTP, authorization and other fields, with object navigation and field search. |
| FHIR exchange | Recognized FHIR request/response evidence in the selected record; absent when the record does not contain it. |
| Raw text | The source text, or an explicitly labelled AWS-safe projection. |

Event metadata shows source identity, timestamps, recorded IDs and provenance.
Derived means the reader calculated a fact from another recorded event; it is not
a newly observed request. Historical gateway completions may have a derived
arrival time. Current gateways emit separate arrival and completion events with
`arrivalId`; a missing completion in a bounded view leaves the outcome unknown.

Resize the detail pane with its divider; keyboard arrows also resize it. Wrap
lines changes display only. Copy JSON/raw/value copies the selected complete
format, not the visible preview. If clipboard access fails, Manual copy text
provides selectable text. Field previews and FHIR projections have visible bounds;
the generic JSON/raw views remain available. No selected payload is saved in
browser storage. Native records above the 256-KiB detail limit require full export.

## Search retained files

1. Open Filters and select exact event fields, such as Source ID, method, status,
   URL path or a recorded Correlation/Trace/Flow ID.
2. Optionally enter **Literal message / payload text** and UTC time bounds.
3. Select **Search retained files**. Ordinary **Apply filters** only changes
   bounded browsing; the literal text and time fields belong to retained search.
4. Read progress and the completeness result before interpreting matches.

Exact filters are case-sensitive and combine with AND. Source ID is a configured
ID such as `ho-b-adapter`, not a label or filesystem path. UTC bounds are inclusive
ISO timestamps ending in `Z`; records without a usable timestamp cannot match an
active bound. Literal text is case-insensitive plain text, not a regex or Boolean
expression. It searches messages and individual string values under details,
including payloads, without matching across two values or searching JSON syntax.

A search captures current files and the five newest rotations per configured
source. Later appends are outside that snapshot. The result is complete only
within those captured files. Missing/unreadable sources, oversized records,
the 1,000-result cap or the 30-second deadline produce an explicit partial result.
Zero matches while the job is running is not a completed result.

Pages contain at most 200 summaries. Cancel retains accepted matches as cancelled;
Return to browsing restores the previous view. Jobs expire after five minutes.
At most two workers and eight retained jobs are allowed; 429 means the reader is
busy. Retry retained search captures a new scope. Clear, truncation or detected
file replacement invalidates old results. Producers must append and rotate by
rename; arbitrary in-place rewrites are outside the snapshot guarantee.

Use the Correlation, Trace or Flow inspection action on a selected event to search
that exact recorded ID across sources. Other filters are set aside for that
investigation; Return/Back restores them. Lookup does not invent missing IDs,
network hops or causal links. A cache hit can legitimately have no outgoing call.

## Diagnostics and HAPI observations

Diagnostics controls which recorded events are displayed. It does not start or
extend native data collection. With diagnostics hidden, a notice can report that
diagnostic errors exist; switch it on to inspect their actual records.

Each HO has a distinct `<ho>-hapi-runtime` source for native requests, admission,
permission/filter observations and selected errors. `<ho>-hapi` is the separate
private-import source. Request receipt does not establish completion. Timeout is
not proof that a transaction rolled back. Native matcher details describe what
was actually observed; they do not run another query to explain a result.

Detailed native collection is operator-configured per HO, for example with
`HO_A_HAPI_DETAIL_STARTED_AT` and optional `HO_A_HAPI_DETAIL_EXPIRES_AT` in the
Compose environment. The default interval is 15 minutes, with a maximum of 60.
Recreate only the intended service to adopt this setting. Restart does not extend
its absolute expiry, and client headers cannot enable it. Full SQL/bind logging
is not supplied. Collection is bounded and can report dropped events; it is not
a guaranteed-lossless audit log.

For `QUERY_BUDGET_EXCEEDED`, inspect `budgetFailure.setting`, `threshold`,
`observed`, `unit` and `budgetFailureStage` on the native terminal error. Allocation
is cumulative worker allocation, not whole-JVM memory; candidate visits are not
returned-record counts. The first terminating cause is retained. Authority expiry,
client abort, cursor expiry and a generic 503 are not automatically query-budget
failures. See the [HAPI query guide](../src/ho-fhir-server/README.md).

Admin command summaries and import diagnostics can link to an exact correlation
or operation investigation. HTTP 202 means accepted, not completed. A summary is
local diagnostic evidence, not an exhaustive durable audit trail.

## Download or clear logs

Full-history downloads require Admin access and include all actually retained
rotations. They are not restricted by the visible filters or browse/detail caps.
The server captures file boundaries, prepares JSON in private temporary storage,
then transfers it. Later appends are not included; this is not a transactionally
consistent snapshot across all sources.

| HTTP result | Meaning |
| --- | --- |
| 200 | All configured sources completed successfully within the export's captured scope. |
| 207 | Partial export: inspect `failures`; a failed source is omitted, not represented as a successful empty stream. |
| 409 | Logs were cleared during preparation; retry with a fresh snapshot. |
| 500 | Export staging failed; no complete or partial success is claimed. |

A large export needs temporary disk approximately equal to its encoded size and
may take time before its first byte is sent. Normal completion/disconnect cleans
up staging; abrupt process termination can leave private OS-temp files. Clearing
after preparation does not revoke a transfer already underway.

**Clear built-in logs** truncates owned current/error files and removes their
history. Read-only extension files are retained and named in the result. Active
writers may immediately append new events. Partial clear failures remain visible.
See the [Admin API](openapi-admin.yaml) for endpoint contracts.

## Protect diagnostic data

All profiles intentionally retain non-AWS tokens, cookies, synthetic identifiers
and FHIR bodies. Keep team directories, downloads and copied events private.
AWS operational credentials are blocked at the shared logging boundary. If this
changes a source record, the viewer labels its raw view as a projection. An opaque
token shown in a log is the recorded value; a decoded JWT view does not verify its
signature, and an issuance-time record is not a current authorization decision.

## Add a local log source

Operators can register at most 16 extension sources in team configuration:

```json
{"observability":{"sources":[{"id":"demo-security","label":"Demo security tool","role":"security","format":"hdp-jsonl"}]}}
```

The path is fixed beneath the shared team log root:
`extensions/demo-security/current.log`, optionally with
`history/<rotation>/app.log`. Registration does not create a mount. Use ordinary
append-only files; symlinks and caller-supplied paths are rejected. IDs are
lowercase alphanumeric/hyphen slugs starting with a letter. Supported roles are
`application`, `middleware`, `security` and `addon`. Host permissions must enforce
the extension's read-only boundary independently of the viewer.

Supported formats are `hdp-jsonl` and `otel-log-record`. The latter accepts one
OpenTelemetry LogRecord per line, not an OTLP `resourceLogs` envelope or a network
ingestion request. Extensions are opt-in diagnostics regardless of claimed
severity. Invalid records show parse errors; unsafe raw text is withheld when
AWS credential safety cannot be established. No dynamic code/plugin is loaded.

### Event fields for developers

Existing JSONL fields remain compatible. Shared writers add versioned event
metadata, for example:

```json
{
  "timestamp": "2026-11-17T12:00:00.000Z",
  "level": "INFO",
  "message": "Introspection completed",
  "details": {"type": "OUTGOING_RESPONSE", "status": 200},
  "event": {
    "schemaVersion": "1.0",
    "eventName": "OUTGOING_RESPONSE",
    "source": {"componentId": "ho-a-adapter", "role": "adapter", "healthOrganizationId": "ho-a"},
    "correlation": {"flowId": "example-flow", "correlationId": "example-request"},
    "provenance": {"kind": "emitted"}
  }
}
```

Trusted runtime/file registration owns source identity; a payload cannot impersonate
another source. Provenance can be `emitted`, `derived`, `imported` or `unparsed`.
Trace metadata uses actual recorded W3C trace/span/parent IDs where available.
No span is manufactured for a cache hit, missing hop or failed observation.
Process-local monotonic ticks do not establish a shared wall clock. These are
OpenTelemetry-compatible metadata, not an OTLP collector or SDK implementation.
