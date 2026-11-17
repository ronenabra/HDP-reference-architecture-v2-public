# Using the sandbox

Follow the [README](../README.md) to install and start the sandbox. Use the
addresses printed by `bootstrap-local-team.js` to open Doctor, PCM, Admin and
Logs. Each team has its own configuration, credentials and data.

## Try a clinical request

1. Import a [synthetic dataset](datasets.md) through Admin **Sources & data**.
   New clinical databases are empty.
2. In Doctor, choose a patient identifier present in that dataset and select a
   service. The built-in examples cover laboratory results, medications,
   summaries and other common uses.
3. Request Consent, review it in PCM, then refresh its status in Doctor.
4. Discover sources and fetch data from one source.

A service describes requested access; selecting it does not grant permission.
Every [profile](scope-enforcement.md) enforces the approved permissions. The
offline patient list is a convenience and does not prove that a source has data.

Generated requests show a first page of up to ten results per type and source.
The optional **FHIR GET path** field accepts a path such as `/Patient/1002` or
`/Observation?_summary=count`. The source still checks the approved grant.
Doctor does not automatically fetch all pages or follow redirects. An empty
result, denied request and unavailable source mean different things.

Use **Explain this page** for help with individual controls. See
[Services](service-templates.md) to customize service definitions and
[optional workflows](hmo-test-journey.md) for sign-in, dependents and SMART tests.

### Follow a request in Doctor

Choose the provider first. **Manage services** opens that provider's assignments
in Services. A service must be active for the selected provider before you can
use it. The [Services guide](service-templates.md) explains how to connect a
provider and approve a new definition.

For a first request with the published 1k population, use Balanced and choose
the synthetic `il-hdp-test-id` identifier with value `1` or `2`. Both occur at
all three sources. You can also enter an identifier from your imported bundle.
The offline patient list and the optional [source sampler](hmo-test-journey.md#find-sample-patients-at-a-source)
help you choose an identity. The source still checks the patient and grant.

In Consent, review the sources, scope and access period before approving. Back
in Doctor, refresh the status, select an approved source and fetch records.
Doctor obtains a token for that source. If the result is unexpected, compare
the requested FHIR path and returned scope in Logs. For example, a successful
search with zero matching Observations and a 403 refusal answer different
questions. Check the grant and source before changing your query.

## Stop, restart and remove a team

Use the stop and restart commands in the README. Stopping preserves database
volumes. Adding `--volumes` to `stop-local-team.js` deletes that team's database
volumes; generated files in the team directory remain. Use a different team ID
and port index for a second installation.

Changes to runtime services and registrations need an explicit saved checkpoint
to survive restart or reset. Clinical data and configuration have separate backup
requirements. See [migration](migration.md) before upgrading an existing team.

## Browser addresses and HTTPS

Trust only your team's generated CA in the browser used for testing. Keep its
private keys and credentials local. Use the printed listener addresses rather
than guessing ports; a remote host must allow access to those listeners.

Doctor and PCM have separate browser addresses. For a new team, use
`--doctor-base-url` to set Doctor's public browser address. A reverse proxy may
use paths such as `/doctor` and `/pcm`; it must strip the configured prefix before
forwarding requests. This project does not install that proxy.

SMART needs the exact Doctor address plus `/callback` registered with PCM.
Changing the hostname in your browser does not register a new callback. To
update an existing team's Doctor address, preview the changes, review the output,
then apply that same review:

```sh
node pcm-connectathon/scripts/configure-doctor-browser.js --config /path/to/team-config.json --doctor-base-url https://doctor.example/doctor --output /private/doctor-review.json
node pcm-connectathon/scripts/configure-doctor-browser.js --config /path/to/team-config.json --doctor-base-url https://doctor.example/doctor --apply --review /private/doctor-review.json
```

Configure DNS, proxy routing and TLS trust first. The command updates the managed
Doctor registrations and saves a private backup. It does not test connectivity.
Start pending SMART tests again after changing the address. Browser links do not
change OAuth issuers, FHIR audiences or source addresses.

When a team sits behind a proxy, use the same public Doctor address from SMART
launch through callback. The port and path are part of the registered address.
Reopen Admin login if its mount path changes. The deployment table distinguishes
browser URLs from internal endpoints. Token assertions and source audiences use
the configured protocol addresses even when a browser link reaches a different
hostname.

On WSL2, run Node and Docker commands inside the same amd64 Linux distribution.
If the printed address works there but fails from another machine, check the
listener, host firewall and proxy routing before changing the team's OAuth URLs.

## Logs and troubleshooting

Open Logs from Doctor or PCM. Filter by source, time or level, then inspect an
event's details and request identifiers. Missing events alone do not prove that
no request ran. Saved settings and settings loaded by a running service can
differ; check the service's reload status and active revision.

All profiles can log tokens, cookies and synthetic FHIR data. Protect team
directories and downloaded logs. Never commit these files or share them publicly.

For `QUERY_BUDGET_EXCEEDED`, inspect the reported limit, observed value and stage.
Time, memory and candidate-count limits are different. A failed or incomplete
query does not establish that a patient has no records.

Full-history log downloads require Admin access. HTTP 207 reports a partial
download because some sources failed; HTTP 409 means logs were cleared while
the download was being prepared. Browse limits do not limit the full download.
See the [Admin API](openapi-admin.yaml) for response details.

If an import times out, it may already have written data. Check its operation
status and follow [import recovery](../clinical-data/README.md) before retrying.


Admin shows each readiness phase separately. Successful metadata discovery
confirms that endpoint responded. Check whether token acquisition, introspection
and an authenticated FHIR request also ran before treating a source as ready.
The [Logs guide](logging-platform.md) explains how to search retained events,
trace a request across sources and interpret partial exports.
