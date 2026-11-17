# Supplemental browser gates

Use the exact Node toolchain and pinned Playwright Dockerfile. Its fresh npm
installation explicitly disables audit metadata upload and funding queries;
Playwright, axe and browser assets remain locked. Run against an
owned disposable team, never a retained installation. Keep all artifacts private:
full local non-AWS diagnostics remain intentionally enabled.

Set `PCM_PLAYWRIGHT_IMAGE` to a unique owned tool-image tag for baseline runs.
The supplemental runner defaults to `pcm-connectathon-playwright:p0-ui-01` and
accepts `--image` for a different owned tag. Do not rebuild a retained helper.

The baseline runner handles real-team fixture verification and smoke:

```sh
node pcm-connectathon/ui/run-playwright.js --team-config <team>/team-config.json --artifacts <private>/runtime --require-clinical --max-failures 1 --grep 'critical pages|Chromium completes consent'
```

The supplemental gate explicitly provisions all inputs declared in
[supplemental-manifest.json](supplemental-manifest.json):

```sh
node pcm-connectathon/ui/run-supplemental.js --team-config <team>/team-config.json --artifacts <private>/supplemental
```

It renders empty/recovery Admin markup with the existing generator, owns the
existing operator (43180) and synthetic Admin HTTP (43182) fixture servers, mounts
the authored repository/assets/CI data and stages only this team's certificates.
Missing required files/certificates fail before launching jobs; unknown suite
names and unexpected test skips fail. Each suite uses all four configured browser
projects, with separate JSON results and a receipt binding tests, source inputs,
configuration, fixtures, environment, mounts and tool image ID. `--suite <name>`
runs one declared job; `--from <name>` resumes remaining jobs after retaining and
checking applicable earlier receipts. `--project <name>` is for focused repair,
not a replacement for the complete matrix. Firefox/WebKit projects retain their
smoke grep. Native Chromium CDP touch exclusions retain mouse/keyboard/browser
counterparts; the authenticated Admin-login/SMART helper runs on both desktop/mobile
Chromium with matching viewport settings and native mobile touch; shared help
cases run in all four profiles. The selected team must have an explicit nonempty private `TEAM_ADMIN_PASSWORD` in its canonical `.env` for the authenticated cases and walkthrough. The runners read it without command-line disclosure; a newly owned baseline team receives a fresh random value. Missing login setup fails before tool launch. Authentication or missing fixtures never justify
a skipped case. Fixture jobs do not establish live HAPI
or usability acceptance.

The real task walkthrough requires explicit disposable-team acknowledgment:

```sh
node pcm-connectathon/ui/run-ui-walkthrough.js --team-config <team>/team-config.json --disposable-team <team-id> --artifacts <private>/walkthrough
```

This uses a deterministic extension of the real CI transaction (16 ordinary
patient Observations and a DiagnosticReport), actual Admin upload/reload/reset,
ordinary explicit Consent review, bounded multi-type preview, enabled balanced
policy denial/cancellation, real owned HO A gateway stop/start, cross-tab stale
selection and navigation/help/zoom checks. It restores CI data and the original
profile on successful completion. A failure preserves evidence; inspect persisted
operations before retrying. The host wrapper restarts an owned stopped gateway
in its cleanup path; it checks the exact Compose project and never prunes data.
The complete disposable team must still be removed with the canonical scoped
stop command after qualification. On failure the selected balanced policy and
boundary fixture may remain in this disposable team for investigation.

Inspect actual desktop/mobile screenshots and complete the task walkthrough.
Automation and axe results support that review; they are not a human user study.

The default live-team Playwright config excludes standalone Logs/gateway suites
that need the servers and native-touch settings in their named configs. Those
remain maintained separate gates: `gateway-level`, `gateway-arrival`, `log-search`,
`log-search-benchmark`, `log-inspection`, `log-filter-layout`, `log-columns`,
`log-copy`, `log-coverage`, `log-structured`, `log-classification`, `log-status` and
`log-help` (`*.config.js` in this directory). Run them with their owned fixture
setup rather than collecting them in a live-team job without those prerequisites.
Runtime protocol tests and the full four-preset scenario requirements remain
unchanged. The Services supplemental job includes actual credentialed API calls,
provider-specific private target review, pending-parent cleanup and touch help.
