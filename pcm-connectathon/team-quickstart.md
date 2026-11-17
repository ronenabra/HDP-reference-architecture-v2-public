# PCM Connectathon Team Quickstart

Use this guide if an organizer has already provided a running team, its URLs
and its Admin password. To install your own team, start with the [project README](../README.md).

## What is deployed for your team

Each team gets one isolated deployment with these visible entry points:

- Doctor's Portal: the demo service-provider application used to create consent requests and fetch FHIR data.
- PCM Admin/UI: the operational console for consent approval, data-source configuration, logs, backups, certificates, and sanity checks.
- PCM FHIR/OAuth API: the HTTPS API used by service providers and data sources for FHIR, token, and introspection calls.
- PCM OAuth metadata: a TLS-only discovery endpoint for OAuth authorization-server metadata; no public PCM JWKS.
- Reference Data Source FHIR endpoints: each managed organization exposes its own gateway backed by HAPI and PostgreSQL. Check the deployment table for the sources available in your environment.
- Reference Data Source discovery: the configured gateway FHIR/SMART metadata surface. Adapter-to-HAPI signing trust is private and pairwise; no public adapter JWKS.

Open PCM Admin first. The top table lists every configured public and internal URL, including host and port, for your specific deployment. Use that table as the source of truth instead of copying examples from this document.

## First login

1. Open the PCM Admin/UI URL from your team assignment.
2. Enter the team admin password when prompted.
3. Confirm the team badge at the top of the page matches your assigned team.
4. Confirm the Deployment URLs and ports table shows the services listed above.
5. Open the Doctor's Portal link from the admin header.
6. Keep the GitHub link in the admin header available for public docs and issue references.

## Run the built-in flow

1. In Doctor's Portal, create a consent request for the test patient provided by the organizers.
2. Return to PCM Admin and open the consent dashboard.
3. Approve the new consent.
4. In the approval page, choose the data source and scope requested for the exercise.
5. Return to Doctor's Portal, discover approved sources, then fetch data from the selected source.
6. In PCM Admin, open logs to inspect the request, token, introspection, and data-source calls.

## Add your own data source

Use PCM Admin, not local files:

1. Go to Consent approval data sources.
2. Add a source name and your FHIR base URL.
3. Set the PCM OAuth client ID your data source will use for introspection.
4. Choose the Service Provider trust mode:
   - Team root CA: use when your server certificate chains to the team CA.
   - System CA: use when your endpoint uses a public CA.
   - Custom CA path: upload your CA certificate in the same form.
   - Pinned thumbprint: upload your server certificate or paste the `x5t#S256` value.
   - Skip verification: only for debugging.
5. Leave Generate PCM client certificate enabled unless you already have agreed certificate material with the organizers.
6. Save the source.

After saving, download the data-source client bundle:

- JSON bundle: easy to inspect or feed into tools.
- ZIP bundle: contains `bundle.json` plus regular `.crt` and `.key` files.

The bundle includes the PCM token/introspection endpoints, the client ID, the root CA, and the generated client certificate/key material for your data source. Private keys are included because this is a connectathon/demo workflow.

## Update trust material

For an existing custom source, the admin table provides upload actions:

- Upload custom CA: stores the uploaded CA under the deployment certificate directory and switches the source to custom-CA trust.
- Upload server cert: calculates and stores the server certificate `x5t#S256` thumbprint automatically.
- Generate cert: regenerates the data source's PCM client certificate/key and updates PCM registration thumbprints.

After changing trust material, retry discovery and data fetch from Doctor's Portal, then inspect logs in PCM Admin.

## Operations available in PCM Admin

- Deployment URLs and ports: source of truth for your team environment.
- Consent approval data sources: add, remove, trust, and bundle custom data sources.
- Certificates: view current thumbprints, download private demo bundles, and review the controlled certificate-renewal handoff. Admin does not rotate roots or pretend to hot-reload managed listeners. See [renewal preview/apply](admin-api.md).
- Logs: inspect and clear current service logs.
- Backup: download or restore the current team config and certificates.
- Reset runtime: clear in-memory PCM data and re-bootstrap the demo catalog.
- Run sanity check: execute the deployed end-to-end flow from the admin process.
  The result appears on the same Admin page with an OK/error summary and expandable details.

## Recommended next steps

1. Run the built-in sanity check.
2. Create and approve one consent against the reference data source.
3. Add your own data source and download its ZIP bundle.
4. Configure your data source to use the bundle's PCM client certificate/key for introspection.
5. Upload your server CA or certificate thumbprint in PCM Admin.
6. Run the Doctor's Portal discovery and fetch flow against your source.
7. Use logs to confirm the flow and capture any failures for the organizers.

### Doctor certificate profiles and retained teams

New teams use one P-256 certificate/key pair for the primary Doctor client's TLS
and ES256 assertion roles. Hospital B has a separate transport pair and P-384
assertion signer (ES384). `kid` identifies the signing public key; `cnf` identifies
the certificate presented by the actual backend TLS client. These are independent
identities. The optional primary ES384 rollover registration does not change its
default ES256 profile. Private adapter-to-HAPI RS256 is unchanged.

For an existing team, preview `node pcm-connectathon/scripts/migrate-doctor-profiles.js
--team-id TEAM --teams-root ROOT`. Inspect the role changes, then add `--apply` to
back up and recreate only that team. This keeps root CAs, IDs, exact callbacks,
source configuration and clinical volumes. It changes the primary transport alias
and replaces a retained Hospital B P-256 signer with P-384. Ordinary provisioning
refuses incompatible retained material without publishing files. Missing/invalid
or externally issued credentials require operator review; no silent repair occurs.
Recovery follows the certificate renewal procedure in [Admin API](admin-api.md).

Strict rejects missing/foreign transport roles, unregistered or expired signers,
wrong transport `cnf`, wrong audience and replay. Non-strict simulation skips only
its configured checks and reports missing evidence truthfully. Wrong supplied
`cnf` is rejected even when public client-certificate checking is simulated.
The negative assertion choice uses trusted primary transport with an unregistered
P-256 signer; the negative transport choice retains its separate untrusted CA.
An explicitly registered public RS256 exception warns and is available only via
its configured non-strict compatibility adapter.
