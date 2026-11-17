# Moving from the previous version

The previous four-service demonstration and this three-HO HAPI/PostgreSQL sandbox
use different configuration and storage models. Create a fresh isolated team to
try the new version.

1. Back up the old configuration and any data you need. Keep the old version
   available until you have checked the new installation.
2. Follow the [README](../README.md) to create a new team. Use a different team ID
   and port index if both installations will run at once.
3. Let bootstrap generate fresh credentials. Do not reuse keys from an older
   public release.
4. Import the selected synthetic dataset and configure services and providers.
   Do not copy old tokens, patient approvals or database volumes into the new team.
5. Test the new setup, then remove the old team when you no longer need it.

Current configuration uses `pcm-team-config/5` and policy `pcm-sandbox-policy/4`.
Older permission-bypass settings are unsupported. All profiles require approved
clinical permissions; see [profiles and access](scope-enforcement.md).

There is no automatic upgrade that preserves every older configuration and
approval. If existing state must be retained, use the [migration tools](../pcm-connectathon/retained-team-migration.md)
only with their supported input versions. Stop writers, keep complete backups and
review the preview before applying changes. Do not restart after an uncertain
conversion until its result has been checked. Reloading settings does not migrate data.
