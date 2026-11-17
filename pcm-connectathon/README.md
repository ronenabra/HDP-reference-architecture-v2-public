# Local team lifecycle and verification

Use the root [README](../README.md) for installation and tests.
`scripts/bootstrap-local-team.js` creates and starts the complete stack with fresh
credentials, optional explicit imports and startup sanity checks.

Teams are isolated under the selected teams root. `create-local-team.js`,
`start-local-team.js` and `stop-local-team.js` provide lower-level lifecycle control.
Stopping preserves state; `--volumes` deliberately deletes the selected database
volumes. Protect generated configuration, keys, logs and backups.

Every preset enforces clinical grants, filters and patient-context restrictions.
Only named transport/assertion checks vary; see [profiles](../docs/scope-enforcement.md).
The legacy Node source is a labelled compatibility component with no ordinary
clinical access, and is omitted by Strict.

See [team use](team-quickstart.md), [data-source integration](data-source-implementation-guide.md),
[datasets](../docs/datasets.md), [migration](retained-team-migration.md) and the
[private Admin API](../docs/openapi-admin.yaml).
Run `npm run verify:full` for a fresh disposable four-preset qualification.

## Team lifecycle

Run team commands from the repository root. Pass the same `--team-id` and
`--teams-root` each time. Bootstrap selects a free port set. Pass
`--port-index` to choose one explicitly when running several teams side by side.
Doctor, PCM and the three gateways have team-specific listeners. Each HAPI
origin and database stays on the private Compose network.

| What you want to do | Command or option |
| --- | --- |
| Prepare configuration and credentials before starting containers | `create-local-team.js`, then `start-local-team.js` with the same team arguments. |
| Start from local images | `start-local-team.js --no-build` checks the Compose image names and reports any missing image. See the [published-image setup](../README.md#start-with-the-published-images) for pulls and the local HAPI tag. |
| Rebuild while allowing Compose to pull | `start-local-team.js --pull`. Use this separately from `--no-build`. |
| Watch containers in the terminal | `start-local-team.js --foreground`. |
| Stop and resume | `stop-local-team.js` preserves database volumes. Then use `start-local-team.js`. Preserve required PCM runtime state before stopping. |
| Recreate an existing team | Bootstrap with `--force` stops the existing project and recreates its configuration. Adding `--volumes` also deletes the selected team's database volumes. See [backup and migration](retained-team-migration.md) first. |

The optional [AWS tooling](aws) provisions the earlier ECS connectathon
deployment. Its shared baseline owns networking, load balancers, storage and
image repositories. Team configuration selects the per-team service. It uses
its own container definitions. The local three-HAPI installation in the README
uses Docker Compose. Keep Terraform state, credentials, generated configuration
and team backups private.
