# Named fixture setup

`run-sanity-check.js` and `ui/run-playwright.js` use `scripts/fixture-patients.js`
for read-only setup. Select the exact fixture directory with `--fixture-root`;
configured bootstrap references take precedence, otherwise the explicit directory
selects `ho-a.source.transaction.json`, `ho-b.source.transaction.json` and
`ho-c.source.transaction.json` for those named sources. Without a selection,
setup is explicitly not applicable. Backend sanity resolves configured references
under the mounted team `bundles` directory; provision those selected fixture files
explicitly before using that mode. A missing selected file fails immediately.
This lookup does not import, reset or reconcile anything. Supply the same explicit
fixture directory to both runners after the approved Admin/CLI import has succeeded.

```bash
node pcm-connectathon/scripts/run-sanity-check.js \
  --config tmp/owned-team/team-config.json --fixture-root clinical-data/ci \
  --require-clinical --output tmp/owned-team/sanity.json
node pcm-connectathon/ui/run-playwright.js \
  --team-config tmp/owned-team/team-config.json --fixture-root clinical-data/ci \
  --require-clinical --grep 'consent approval|negative identities|all three Admin upload'
```

The host runner sends only selected fixture identities to its team's private PCM
container. Backend sanity uses `--private-fixture-runner` directly; no Docker
socket is mounted in PCM or the browser. The backend uses each HO's existing
`X-PCM-Import-Credential`, named configured private URL and verified team CA.
It reads at most ten named Patient resources per selected HO; each response has
an absolute ten-second deadline and 128-KiB byte cap. Redirects are prohibited,
including redirects to another resource on the same host. Exact resource/typed
identities and unambiguous dataset/source tags must match. Empty, missing,
replaced and unavailable fixtures produce explicit states, never fallback
enumeration or an assertion of absence. `--no-fixture-setup` is reserved for the
explicit fresh-empty sanity stage, whose separate live counts establish emptiness.

Browsers receive only bounded `fixture-facts.json`, including fixture hashes and
observation time. Missing facts under `--require-clinical`, failed source checks,
wrong-team facts or observations older than thirty minutes fail. Long-running
qualification should refresh setup. Maintenance headers and secrets are absent
from browser environment/page JavaScript/URLs/traces. Keep normal OAuth client
certificate staging within the existing private runner boundary.

The consent journey and negative-identity matrix independently exercise actual
Doctor-to-PCM authorization and source requests. Setup success is not PCM token,
introspection or clinical-access evidence. The Admin upload test uses its existing
authenticated completion status, live exact source counts and the protected ledger
for the exact uploaded fixture identity. Required clinical execution gates remain.
The desktop/mobile consent journey runs on both Chromium projects and the
required full gate rejects either missing execution. The full runner passes its
selected dataset root explicitly. Separate demo and system-workflow suites use
their own established setup; `--no-fixture-setup` never satisfies a required
ordinary clinical prerequisite.
