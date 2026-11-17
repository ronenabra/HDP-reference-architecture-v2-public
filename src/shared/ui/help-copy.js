'use strict';
// Generated from docs/ui-explanation-catalog.md by scripts/generate-ui-help.js.
window.PCM_HELP_COPY = {
  "common.explain": {
    "title": "Explain this page",
    "body": "Use the upper-right control, which stays visible while you scroll. Turn it on to explore what the page's controls and information mean. Point to an item or focus it with the keyboard to see an explanation and an outline. On touchscreens, focus an ordinary field or tap a disabled control for help. Keyboard users can focus the help proxy for an action without activating it. This changes only the help display; it does not change data or settings.",
    "technical": "The preference belongs to this team and browser tab on this address. Other app addresses may need their own toggle."
  },
  "common.team": {
    "title": "Team badge / Team value",
    "body": "This is the sandbox team whose page you are using. Its configuration, consent records, certificates and clinical sources belong to that environment. Check this name before changing settings or running an operation, especially when you have several teams open.",
    "technical": "A team label identifies the environment, not a signed-in patient or clinician."
  },
  "common.mode": {
    "title": "Conformance/preset banner and version",
    "body": "This banner shows which profile the team uses. The connectathon profiles let you change how clients prove their identity and how connections are verified. Every profile checks the approved patient, source and permissions before returning clinical records.",
    "technical": "The displayed version identifies the effective policy. Unsupported scope expressions are rejected."
  },
  "common.feedback": {
    "title": "Success / information / error message",
    "body": "This reports the outcome or current condition of the action you just attempted. Read the message before repeating an action; a request error does not always prove that a remote operation made no changes. For imports, also inspect the saved operation status and diagnostics.",
    "technical": "Existing status codes and detailed errors remain the source for troubleshooting."
  },
  "common.details": {
    "title": "Details disclosure and structured result",
    "body": "Open this to see the supporting information behind the summary, such as failed checks, affected targets or validation errors. Expanding it only reveals information already returned to this page; it does not retry the action or change the result.",
    "technical": "JSON is a structured text format used by the application."
  },
  "common.nav-admin": {
    "title": "Admin UI / Back to Admin",
    "body": "Open the team's administration page to inspect deployment settings, clinical data operations, sources, certificates and diagnostics. These controls can affect other pages in the same team. If an Admin password is configured, you will need it to continue.",
    "technical": "Uses the separate Admin/UI surface rather than the public PCM FHIR API."
  },
  "common.nav-doctor": {
    "title": "Doctor / Return to Doctor",
    "body": "Open the synthetic requesting application to choose a patient and clinical service, request Consent, discover sources and fetch a bounded preview. Review ordinary requests in Consents.",
    "technical": "Navigation follows the reachable browser hostname without changing OAuth or FHIR identities."
  },
  "common.nav-consents": {
    "title": "Consents",
    "body": "Open the stored Consent registry. Review a pending ordinary request and explicitly approve it or leave it pending. The owning provider can cancel as shown. This navigation does not grant access.",
    "technical": "The exact HTEST 1/2 exception remains labelled separately."
  },
  "common.nav-logs": {
    "title": "Logs",
    "body": "Investigate recorded events across the team. Use the page links to return to Doctor, Consents or Admin. An absent event does not prove an action never happened.",
    "technical": "Full non-AWS diagnostic payloads are sensitive local artifacts."
  },
  "common.nav-api": {
    "title": "API Docs / Admin API Docs",
    "body": "Open the API reference for the selected interface. It describes machine-readable requests and responses for developers who want to automate or troubleshoot actions. The Admin reference covers local management operations; the PCM reference describes the public PCM contract.",
    "technical": "A reference page is documentation, not a live service-health check."
  },
  "common.nav-repository": {
    "title": "GitHub",
    "body": "Open the project's source repository and documentation in another tab. This can help you look up setup instructions or report an issue. Navigating there does not save pending edits on this page.",
    "technical": ""
  },
  "common.working": {
    "title": "Working / submitting / temporarily disabled action",
    "body": "The page is waiting for an action or status update. A disabled button helps prevent repeated submissions while that wait is in progress. Read the operation's own status before deciding what to do next; closing this page does not necessarily stop server work.",
    "technical": "Help must remain available for disabled controls without enabling them."
  },
  "admin.password": {
    "title": "Admin password",
    "body": "Enter the administration password configured for this team. It protects the management page when password protection is enabled; it is separate from a patient's identity and from the Doctor app's simulated client selection.",
    "technical": "The password is submitted in the login form, not placed in the navigation URL."
  },
  "admin.login": {
    "title": "Open Admin",
    "body": "Submit the password and open the team's management page if it is accepted. This establishes an Admin browser session; it does not change the security preset, approve consent or grant the Doctor app clinical-data access.",
    "technical": "The browser receives an HTTP-only Admin session cookie."
  },
  "admin.deployment-url": {
    "title": "URL column / diagnostic link",
    "body": "Copy the exact displayed base address when configuring clients. Public services also show a separate application, metadata or health link when an appropriate browser destination exists. Disabled sources remain labelled and do not offer a live diagnostic link.",
    "technical": "Loopback application links follow this browser’s reachable hostname while keeping their listener and configured path. Copied bases stay as displayed; explicit external destinations stay unchanged. Internal addresses are for containers; public TLS diagnostics may require a client certificate."
  },
  "admin.data-section": {
    "title": "Managed HAPI clinical data heading",
    "body": "Manage synthetic clinical data stored by the team's HAPI servers. Each card addresses one separate healthcare organization's database. Verification publishes only the private Admin inventory; Doctor samples ordinary public source data independently; the legacy compatibility source is not managed through these import and delete controls.",
    "technical": "HAPI is the FHIR server implementation used for managed clinical storage."
  },
  "admin.data-target": {
    "title": "Server name, ID and gateway address",
    "body": "This identifies the exact managed server affected by the controls in this card. Check it before importing, replacing or deleting data. The displayed gateway address is the clinical source address. Maintenance uses its separately configured private target; this does not grant Doctor access.",
    "technical": "Repeated cards retain distinct server IDs, locks and operation histories."
  },
  "admin.data-counts": {
    "title": "Target counts and history (JSON)",
    "body": "Read the server's current resource counts and whether historical versions exist. These counts cover the managed target, which may include data from an unfinished or unverified import. Opening this read-only report does not certify the data or publish patients to the Doctor app.",
    "technical": "Bundle verification separately checks the uploaded source and dataset tags."
  },
  "admin.data-inventory": {
    "title": "Verified Admin inventory",
    "body": "This is the saved private ledger for verified imports across managed sources. It is separate from current target counts and may be invalidated by a later reset or uncertain mutation. Doctor samples the ordinary public source independently; importing does not populate a Doctor patient picker.",
    "technical": "The protected inventory JSON contains every managed source; inspect each row’s source and serverId before using it."
  },
  "admin.data-bootstrap-summary": {
    "title": "Bootstrap summary",
    "body": "This shows the saved startup import policy and, when configured, the bundle-to-source mapping. It describes what an explicit bootstrap run should do. It is not evidence that a bundle has already loaded; check the operation result and actual server counts separately.",
    "technical": ""
  },
  "admin.data-file": {
    "title": "Synthetic transaction Bundle file picker",
    "body": "Select the synthetic data file to load into this server. The file must describe a supported FHIR R4 transaction and carry the expected synthetic source information. Choosing a file only prepares the form; importing starts when you press “Check bundle and import.” The filename must end in .source.transaction.json. A refused filename is rejected before import; choose a correctly named transaction file and retry.",
    "technical": "The filename must end in `.source.transaction.json`; structure, references, tags, allowed types and limits are checked."
  },
  "admin.data-replace": {
    "title": "Replace checkbox",
    "body": "Choose this when you intentionally want to replace this server's existing clinical dataset. The import workflow checks the bundle and target, then clears this target before loading the replacement. That clearing can succeed even if the later load fails, so this is not an undoable dataset swap.",
    "technical": "Other HOs, PCM consent records and the legacy source are outside this target operation."
  },
  "admin.data-import": {
    "title": "Check bundle and import",
    "body": "Submit the selected file for bundle checks and loading into this server. After HAPI confirms that every entry was accepted, fast checks compare the stored source and dataset counts with the file before recording the private Admin inventory. This does not publish a Doctor picker inventory. Follow the operation status below, and do not resubmit an uncertain operation simply because the browser stopped waiting.",
    "technical": "Bundle-contract checks are not full FHIR profile validation."
  },
  "admin.data-validation": {
    "title": "Import validation explanation",
    "body": "These are the checks performed before and after loading. The initial checks establish that the file follows the supported import contract, not that every resource satisfies every healthcare profile. HAPI's response and the later persisted-data verification are separate stages with different evidence.",
    "technical": "No full profile-conformance claim follows from a successful bundle check."
  },
  "admin.data-confirmation": {
    "title": "Deletion acknowledgement",
    "body": "Check the initially unchecked box naming this server only if you understand that all its data and saved versions will be deleted. This applies to Delete all data and Clear server recovery. Cancelling, submitting or reloading clears the selection; select it again for another request. Checking this box does not stop an import.",
    "technical": "The checkbox names the exact team and target and supplies their existing confirmation. No confirmation text needs to be typed."
  },
  "admin.deletion-disabled": {
    "title": "Deletion is unavailable",
    "body": "Check the deletion acknowledgement naming this server to enable this button. If an import or deletion is still running here, wait for its result first. Recovery also requires confirmation that the earlier import has stopped. Checking a box does not stop running work.",
    "technical": "Confirmation applies only to this server and this request."
  },
  "admin.data-delete": {
    "title": "Delete all data",
    "body": "Delete all FHIR resources and historical versions from this selected HAPI server. Its private Admin verified inventory is invalidated. Doctor samples ordinary public source data separately; this does not publish a patient picker inventory. Other HAPI servers and PCM records remain separate. Review the target and confirmation before submitting.",
    "technical": "This is a target-wide maintenance operation, not deletion of only the last uploaded bundle."
  },
  "admin.bootstrap-policy": {
    "title": "Bootstrap policy select",
    "body": "Choose how this server should handle its configured bundle during bootstrap. “Disabled” performs no automatic load; “if-empty” loads only when current data and history are empty; “replace” clears the target before loading. Saving the policy does not immediately run that import.",
    "technical": "The selected policy and bundle/source mapping are validated together."
  },
  "admin.bootstrap-reference": {
    "title": "Relative bundle reference",
    "body": "Enter the portable location of the bundle that bootstrap should use for this server. This is a reference to a file available to the configured runtime, not the file you selected in the manual upload form. Pair it with the expected source tag.",
    "technical": "Do not use a personal workstation's absolute path as deployed configuration."
  },
  "admin.bootstrap-source": {
    "title": "Expected source tag",
    "body": "Enter the source identity that the configured bundle is expected to carry. This explicit match prevents a bundle for one organization from being loaded into another by accident. A similar filename or display name is not enough to establish the match.",
    "technical": "Compared with the synthetic source tag in the bundle."
  },
  "admin.bootstrap-save": {
    "title": "Save bootstrap mapping",
    "body": "Save this server's startup policy, bundle reference and expected source together. Future bootstrap operations use that mapping after validation. This action changes configuration; use the manual import controls if you want to load a file now.",
    "technical": "Invalid configuration is rejected rather than partially applied."
  },
  "admin.refresh": {
    "title": "Refresh saved server details",
    "body": "Reload Admin to show saved server details and recovery controls after reviewing each result. Unsaved file selections and form changes will be discarded. This button waits until every upload request and saved-operation status check has finished, so one server cannot interrupt another server’s pending submission.",
    "technical": "A normal successful import refreshes automatically only after all work finishes and there are no unsaved edits or failed results to review."
  },
  "admin.refresh-status": {
    "title": "Waiting to refresh / request needs attention",
    "body": "While any server is sending a request or waiting for a saved operation, refresh is unavailable. Status updates continue for each server. If a request fails or its result needs attention, automatic refresh stops so you can review it. Use Refresh saved server details when available to see recovery controls; refreshing does not import a file again.",
    "technical": "Interrupted polling keeps its navigation guard while reconnecting. Unsaved edits also prevent automatic refresh."
  },
  "admin.operation-status": {
    "title": "Import or deletion result",
    "body": "Read what happened on this named server and what to do next. Import in progress, import complete, deletion complete, failed work and an unknown result are different states. Check this import checks the saved file without importing it again; Clear server deletes all data and saved versions. Open Technical details for operation IDs, raw states, timing and diagnostics.",
    "technical": "Recorded status is not a live view of each database write. A lost browser connection does not prove work stopped."
  },
  "admin.operation-time": {
    "title": "Elapsed time / stage time / response wait / deadline",
    "body": "These times show how long the operation or current stage has been waiting and any recorded deadline. A longer wait does not prove that the transaction failed or stopped. After HAPI responds, later verification has its own timing and must finish before the dataset is treated as verified.",
    "technical": "No entry-completion percentage can be inferred from a single pending transaction."
  },
  "admin.operation-bundle": {
    "title": "Progress target, bundle, entry and byte counts",
    "body": "These values identify the submitted file and its size so you can confirm that you are following the right operation. Entry and byte counts describe the upload, not how many records have already committed to HAPI. Compare the target and bundle before investigating diagnostics.",
    "technical": "A file hash, when shown in details, identifies the exact uploaded contents."
  },
  "admin.operation-verification": {
    "title": "HAPI acceptance / post-load type checks",
    "body": "HAPI acceptance means the server confirmed that every transaction entry was accepted. The later checks compare exact stored counts for the uploaded source and dataset without downloading all resources. Patients become available after these checks and the saved result both succeed.",
    "technical": "Type-check progress counts verification steps, not transaction commit progress."
  },
  "admin.operation-events": {
    "title": "Recorded stages / last completed stage",
    "body": "This sequence shows confirmed milestones, helping you locate where work last progressed. If an operation fails, the last completed stage narrows the investigation. Missing later milestones do not establish whether a submitted HAPI transaction eventually completed after the client lost contact.",
    "technical": "Use the operation ID to correlate import diagnostics."
  },
  "admin.operation-uncertain": {
    "title": "Import needs attention / status updates interrupted",
    "body": "If the import result is unknown, do not upload it again. Review this server’s result and recovery controls. Ask the local operator to confirm that the earlier import process and database transaction have stopped before checking or clearing the server. Interrupted status updates reconnect automatically and show the last confirmed result.",
    "technical": "An expired wait or missing response does not establish stopped work or an empty server. Technical details retain the original error."
  },
  "admin.recovery-stopped": {
    "title": "Earlier import has stopped",
    "body": "Ask the local operator to confirm that the earlier import process and database transaction have both stopped. Use import diagnostics to investigate; missing updates alone are not proof. Check this box only after confirmation. If this cannot be confirmed, leave the data unchanged. Checking the box does not stop work.",
    "technical": "The server still rejects a known running import. Verification and clearing have separate stopped-processing acknowledgements."
  },
  "admin.recovery-verify": {
    "title": "Check this import",
    "body": "Check whether the stopped import completed without uploading the file again. If HAPI already confirmed success on an empty target, repeat the fast source, dataset and target count checks and check that history exists. If HAPI’s response was lost or unsuccessful, compare the stored contents, references and history with the saved file. Failed checks keep the target blocked.",
    "technical": "Both paths verify the saved file and target identity before updating the private Admin inventory. Neither replays the transaction POST."
  },
  "admin.recovery-reset": {
    "title": "Clear server and allow another import",
    "body": "After the earlier import has stopped, delete all data and saved versions in this named server. Check both the stopped-processing box and the deletion acknowledgement. Other servers are unaffected. This removes its verified patient availability and allows another import; it does not upload a replacement file automatically.",
    "technical": "The existing exact team-and-target confirmation is supplied by the deletion checkbox. The server retains its stopped-processing, target-identity and recovery checks."
  },
  "admin.operation-logs": {
    "title": "Open related diagnostics",
    "body": "Open the one Logs application with Diagnostics shown and the exact recorded operation, registered source or readiness correlation ID. Only records carrying that ID match; absence does not prove the work never occurred.",
    "technical": "No unrelated event is selected. Readiness is not conformance certification."
  },
  "admin.data-empty": {
    "title": "No managed HAPI servers configured",
    "body": "There are no managed servers available for these maintenance controls in the current configuration. This does not mean PCM has no consent records or that every external source is unavailable. Managed import targets must be configured explicitly.",
    "technical": "Legacy and consent-only external sources are not automatically promoted to managed HAPI targets."
  },
  "admin.simulation-preset": {
    "title": "Security preset",
    "body": "Preview the six default controls and every saved source override that would be replaced. Selecting a preset changes only the preview. Use previewed defaults updates the draft; Save publishes it. Strict/connectathon transitions require controlled team recreation and reject here before mutation.",
    "technical": "The saved preset and policy remain visible while editing. Managed listener adoption needs operator verification."
  },
  "admin.presence-limits": {
    "title": "Request and processing limits",
    "body": "The groups separate PCM patient checks, PCM OAuth messages and managed-source imports. Managed sources also enforce the presence settings. External servers keep their own settings. Larger limits do not grant more access or increase server capacity.",
    "technical": "presence.batch supplies shared defaults; presence.sources holds per-source overrides. Source authorization and current Contract, Consent and Patient checks remain unchanged. Saved configuration does not prove that running services have loaded it."
  },
  "admin.simulation-native": {
    "title": "Required authorization notice",
    "body": "Scope, Patient context, authority, actions, filters, references, includes, pages, counts and result authorization are always enforced. These checks cannot be disabled.",
    "technical": "Retired global/per-source authorization controls are rejected."
  },
  "admin.security-invariants": {
    "title": "Required transport and authority facts",
    "body": "These status rows describe deployment transport and always-required safeguards. Approved scope, exact Patient/source context, current authority and token expiry are enforced in every preset. Patient mapping grants no access. AWS credential isolation is always on.",
    "technical": "These are facts with no editable bypass. PCM transport comes from its preset; gateway requirements follow the six-control policy."
  },
  "admin.simulation-overrides": {
    "title": "Global or source controls",
    "body": "Choose Global controls or one exact registered source. A source choice of Inherit uses the global value; On and Off are explicit overrides for that source only. Open its HTTPS trust view to select trusted CA or pin material; this verification policy decides whether verification is enforced.",
    "technical": "Managed sources use their stable policy identity; display names never resolve authority. No JSON override editor is required."
  },
  "admin.simulation-apply": {
    "title": "Save controls",
    "body": "Save only this global or selected source form after validation against the current saved revision. All unchecked global controls explicitly mean Off. Source Inherit removes only that override. A save confirms configuration, not runtime enforcement.",
    "technical": "Preset replacement requires using the previewed defaults. Other source overrides remain unless that explicit replacement is saved."
  },
  "admin.simulation-defaults": {
    "title": "Preview selected preset defaults",
    "body": "Inspect each global before/after value and every source override that would return to Inherit. Use previewed defaults replaces the draft; it does not save. Save then publishes the reviewed replacement.",
    "technical": "Strict/connectathon mode changes require controlled recreation and cannot be applied by this form."
  },
  "admin.simulation-effective": {
    "title": "Saved policy and draft",
    "body": "Saved and effective values come from the current saved configuration and its global or source origin. Unsaved controls and preset previews do not update those facts. PCM reads current configuration on new requests; mounted source consumers and listeners still need operator adoption checks.",
    "technical": "A saved revision is not an observed authentication or clinical request result."
  },
  "admin.simulation-locked": {
    "title": "Disabled strict-mode check",
    "body": "This check is fixed on by strict mode, so it cannot be relaxed with this checkbox. Its enabled state is part of the sandbox's strict contract. Help explains the setting, but does not unlock it or change the selected mode.",
    "technical": ""
  },
  "admin.aws-isolation": {
    "title": "AWS credential isolation / full-log notice",
    "body": "The sandbox intentionally records detailed non-AWS requests and responses for learning and troubleshooting. AWS operational credentials remain protected in every preset and cannot be exposed by turning simulations off. Handle downloaded logs and backups according to the information they contain.",
    "technical": "Help must not add sensitive runtime values to its own text or browser storage."
  },
  "simulation.publicClientMtls": {
    "title": "Require public client mTLS",
    "body": "Require accepted client certificates at source gateways. Source overrides can change this check for one gateway. PCM API client authentication is separately fixed by its deployment preset. Token and clinical data-permission checks stay enforced.",
    "technical": "mTLS authenticates transport; signed OAuth assertions are separate."
  },
  "simulation.serverCertificateVerification": {
    "title": "Verify HTTPS server certificate",
    "body": "Check that the remote HTTPS server presents a certificate the configured client trusts. This helps confirm that requests reach the intended server. Turning it off relaxes that server-identity check for sandbox testing; it does not by itself grant permission to read data.",
    "technical": "TLS encryption and certificate verification are related but separate settings."
  },
  "simulation.clientAssertionSignature": {
    "title": "Verify assertion signature",
    "body": "Verify that the application's signed login statement was produced with its registered signing key. This is part of authenticating the application when it asks PCM for access. Turning it off skips the signature simulation, while other enabled statement checks remain in place.",
    "technical": "The statement is an OAuth `private_key_jwt` client assertion."
  },
  "simulation.clientAssertionAudience": {
    "title": "Check assertion audience",
    "body": "Check that the application's signed statement names the PCM endpoint receiving it. This prevents a statement intended for one endpoint from being reused at another. Turning it off skips that destination comparison, not all client authentication.",
    "technical": "This audience belongs to the client assertion, not the later clinical access token."
  },
  "simulation.clientAssertionReplay": {
    "title": "Prevent assertion replay",
    "body": "Reject reuse of the same signed client statement after it has already been presented. Applications normally create a fresh statement for a new authentication attempt. Turning this off allows replay testing without disabling the other configured assertion checks.",
    "technical": "Replay is tracked by the assertion's unique `jti` identifier and client identity."
  },
  "simulation.clientAssertionExpiry": {
    "title": "Check assertion expiry",
    "body": "Check that the client's signed authentication statement is within its permitted time window. Old or incorrectly timed statements can fail before PCM issues an access token. Turning this off relaxes statement timing, while clinical token expiry stays enforced.",
    "technical": ""
  },
  "admin.upstream-url": {
    "title": "Legacy source custom upstream FHIR server URL",
    "body": "Supply the complete FHIR base address for the legacy source gateway only. Managed sources keep their own private HAPI targets. If an older configuration applied this URL to every gateway, review and acknowledge the migration before saving; clearing the field restores the built-in legacy server.",
    "technical": "The address must be reachable from the gateway network. AWS metadata and credential destinations remain blocked."
  },
  "admin.token-lifetime": {
    "title": "Access token duration (seconds)",
    "body": "Set a positive integer duration for future PCM access-token issuance. Production permits up to 30 seconds and test up to 86400 seconds; earlier authorization deadlines shorten tokens. Existing token expiry, approved grants and first-use clocks are unchanged. Issued-token expiry checks remain enforced in every preset.",
    "technical": "Environment and logical contract identities are deployment controlled. New PCM requests read the saved duration; saving is not runtime enforcement proof."
  },
  "admin.own-token-introspection": {
    "title": "Service Provider own-token introspection",
    "body": "Optional sandbox diagnostic capability. Easy, Balanced and mTLS default enabled; select an explicit override or restore the preset default. Strict locks it disabled and rejects enabled configuration; entering Strict removes an earlier override. Doctor checks only on explicit Check token status using its own registered mTLS and private_key_jwt credentials.",
    "technical": "This is not a production PCM support claim. Checks preserve the original issuer, client, audience, effective grant and expiry, read current authority without starting or extending first-use windows, and never issue tokens or call a source. Disabled or refused checks preserve a validated token response; authoritative inactive or inconsistent results block use. Saving alone does not prove runtime adoption."
  },
  "admin.security-save": {
    "title": "Save token duration",
    "body": "Save only the displayed duration under the current revision and existing configuration validator. Invalid, stale, zero, negative or above-environment values reject without saving. Source, transport, capability and authority settings remain with their own forms.",
    "technical": "Only future issuance uses the duration; this action never disables token-expiry enforcement."
  },
  "admin.mapping-section": {
    "title": "Identity mapping overrides table",
    "body": "These explicit legacy mappings connect a patient's business identifier to the legacy local identifier. Bare identifiers use the national-ID naming system; a full system-and-value token separates the naming system and exact business value, preserving leading zeros. Saving the same identity updates its existing override. They are useful for legacy/mock testing and are not a clinical patient registry. Adding a row does not import a Patient into HAPI or publish a Doctor inventory.",
    "technical": "Managed HAPI matching uses its source-local Patient data."
  },
  "admin.mapping-system": {
    "title": "Mapping System column",
    "body": "This identifies the naming system that gives a business identifier its meaning. The same number under a different system can identify something different. Read it together with the Business ID value when checking which mapping will be used.",
    "technical": ""
  },
  "admin.mapping-business": {
    "title": "Business ID input / column",
    "body": "Enter the external patient identifier to translate. A bare value uses the national-ID naming system; you can also supply a full system-and-value identifier. Keep the system correct, because a matching number alone does not establish the same identity.",
    "technical": "Full form is `system\\|value`; bare values use `http://fhir.health.gov.il/identifier/il-national-id`."
  },
  "admin.mapping-internal": {
    "title": "Internal identifier input / column",
    "body": "Enter the identifier exactly as the relevant source expects it locally. It is the mapping's destination, not a new national identifier. Saving this text does not create a Patient record or verify that the source contains one.",
    "technical": "A value may look like `Patient/local-123`; bare values are preserved."
  },
  "admin.mapping-add": {
    "title": "Add mapping",
    "body": "Save the business-to-local identifier override from these fields. Later requests using that mapping can resolve to the specified local identity. Verify both values before saving; a mapping change affects identity resolution, not the consent record's original patient identifier.",
    "technical": ""
  },
  "admin.mapping-remove": {
    "title": "Remove mapping",
    "body": "Remove this explicit override from team configuration. Later requests that depended on it may no longer resolve through that override. This does not delete a patient, remove clinical data or revoke an existing consent.",
    "technical": ""
  },
  "admin.mapping-empty": {
    "title": "No explicit overrides configured",
    "body": "There are no manually configured mapping overrides. This does not by itself mean that the managed HAPI sources lack patients, because they can resolve identifiers from their own Patient resources. The legacy mapped-patient check may need an explicit override for its test case.",
    "technical": ""
  },
  "admin.sources": {
    "title": "Data sources section / source card",
    "body": "These are the organizations and endpoints PCM can offer as information sources during consent approval. Registration identifies where requests go and how the source authenticates. It does not prove that the endpoint is running, holds a particular patient's data or passes conformance testing.",
    "technical": "A registered external source is not automatically a managed import target."
  },
  "admin.source-built-in": {
    "title": "Built-in / legacy compatibility badge",
    "body": "This source is supplied by the team's generated configuration rather than added through the custom-source form. Managed HAPI and built-in legacy hosting are separate facts. The legacy Node source retains health, logs and identity compatibility but has no qualified clinical scope matcher.",
    "technical": "Legacy clinical access remains unsupported in every preset."
  },
  "admin.source-id": {
    "title": "Source ID",
    "body": "This stable identifier connects the source's configuration, consent choices and diagnostics. Use it when matching a source override or a log record to this card. It is different from the source's display name, OAuth client ID and network address.",
    "technical": ""
  },
  "admin.source-name": {
    "title": "Name",
    "body": "Enter a clear display name so people can recognize this source in Admin and when reviewing consent. The name helps users choose the intended organization, but it does not establish the source's identity or trust on its own.",
    "technical": ""
  },
  "admin.source-endpoint": {
    "title": "FHIR base URL",
    "body": "Enter the source's FHIR service address, including its protocol and base path. PCM uses the registered destination when the Doctor discovers approved sources and obtains source-specific access. A correct name with an incorrect URL will not route requests to the intended server.",
    "technical": "Do not confuse the FHIR base with an Admin page or OAuth token endpoint."
  },
  "admin.source-client-id": {
    "title": "Client ID",
    "body": "This identifies the registered application when the source authenticates to PCM. Use the value assigned or configured for that registration; do not substitute an organization name or FHIR resource ID. Use a valid opaque value such as pcm-source-local-0001. A source URL is not a client-ID example.",
    "technical": "OAuth client IDs are opaque identifiers, not addresses to infer from endpoints."
  },
  "admin.source-auth": {
    "title": "PCM authentication group",
    "body": "These fields configure the source's identity when it connects to PCM. They are separate from the Doctor app's trust in the source's HTTPS server. A certificate used for a connection and a key used to sign an OAuth assertion can have different roles.",
    "technical": "Transport and assertion certificates are not interchangeable merely because both belong to one team."
  },
  "admin.source-client-thumbprint": {
    "title": "PCM client cert thumbprint / x5t#S256",
    "body": "This fingerprint identifies the client certificate associated with the source's PCM registration. Compare it when diagnosing certificate mismatches. The fingerprint contains no private key and cannot be used by itself to prove that the caller owns the certificate's key.",
    "technical": "`x5t#S256` is a SHA-256 certificate thumbprint in the expected encoded form."
  },
  "admin.source-client-cert": {
    "title": "Upload PCM client cert",
    "body": "Choose the public certificate for this source's PCM client identity. It must correspond to the intended client role and, when a key is supplied, to that key. Selecting a file does not save the new source until you submit the form.",
    "technical": "Certificate input accepts the supported PEM/CRT representation."
  },
  "admin.source-client-key": {
    "title": "Upload PCM client key",
    "body": "Choose the private key that matches the client certificate you are registering for this source. The source needs the appropriate key material to use that identity. This is credential material, so do not paste it into diagnostic notes or use the certificate file in its place.",
    "technical": "The help text must never display or store the selected key contents."
  },
  "admin.source-generate-demo": {
    "title": "Generate demo PCM client cert/key",
    "body": "Generate the chosen shared P-256/ES256 or separate transport and P-384/ES384 pairs using the team's local authority. PCM validates the pair and trust chain before saving it. Download the registration bundle for the source backend. This is a local test identity; it does not certify a production installation.",
    "technical": ""
  },
  "admin.source-reuse-pin": {
    "title": "Reuse PCM client cert as Doctor Portal server trust pin",
    "body": "Use the PCM transport certificate's fingerprint as the expected HTTPS server certificate for this source. A separate assertion certificate retains its own role. Select this only when that is really the certificate the source server presents. A client certificate and a server certificate normally serve different roles, so an incorrect reuse can make Doctor connections fail.",
    "technical": "Pin mode verifies the team-CA chain and hostname, then checks the exact server fingerprint. It does not register an OAuth assertion-signing key."
  },
  "admin.source-trust": {
    "title": "Source HTTPS server trust",
    "body": "Choose how Doctor and PCM workflow calls verify this source's HTTPS server. It can trust the team authority, the operating system's authorities, a custom authority, or the team authority plus an exact server certificate pin. Skipping verification is a sandbox-only relaxation; the selected policy still determines whether it is allowed.",
    "technical": "This configures source server trust separately from its own authentication to PCM; PCM workflows still use their registered workflow-client credentials."
  },
  "admin.source-ca-path": {
    "title": "Custom CA file path",
    "body": "Enter the configured certificate-authority file used to trust this source's server. The path must be available in the runtime's supported certificate layout, not just on your laptop. Use this with the custom-CA trust choice or select an upload where provided.",
    "technical": "CA means certificate authority."
  },
  "admin.source-ca-file": {
    "title": "Upload custom CA file picker",
    "body": "Select the certificate authority that should be trusted for this source's HTTPS server. It should be the authority needed to verify that server's certificate chain. Choosing the file prepares the form; use Add source or the adjacent Upload button to save it.",
    "technical": "Upload a CA certificate, not its private key."
  },
  "admin.source-server-thumbprint": {
    "title": "Server cert thumbprint",
    "body": "This fingerprint identifies the HTTPS certificate Doctor and PCM workflow calls expect the source server to present when pinning is selected. It must match the actual server certificate. A certificate renewal can change this value even when the source's hostname stays the same.",
    "technical": "Different from the PCM client-certificate thumbprint."
  },
  "admin.source-server-cert": {
    "title": "Upload server cert / Calculate server x5t#S256 picker",
    "body": "Choose the source server's public HTTPS certificate so the application can calculate its fingerprint. This helps avoid copying a thumbprint incorrectly. It does not upload a private server key or install a certificate on the remote source.",
    "technical": ""
  },
  "admin.source-add": {
    "title": "Add source",
    "body": "Register the source using the entered name, endpoint, client identity and trust settings. Depending on your choices, the sandbox also prepares demonstration credentials. Registration makes the source available to the sandbox workflow; it does not create clinical records or prove readiness.",
    "technical": ""
  },
  "admin.source-download": {
    "title": "Source Download JSON / Download ZIP",
    "body": "Download this source's registration information and available certificate material so its operator can configure a client. JSON presents the contents as structured text; ZIP packages them as files. These downloads can include private keys and should be handled as credentials.",
    "technical": "Different from the all-team certificate export."
  },
  "admin.source-test": {
    "title": "Test source",
    "body": "Run a bounded readiness check against this registered source using the configured connection and identity settings. The result can help locate connectivity or authentication problems. It is a sandbox smoke test, not a full conformance verdict or proof that every clinical request will work.",
    "technical": "Not-tested and not-applicable phases are not successful test observations."
  },
  "admin.source-readiness": {
    "title": "Readiness result, phase, duration and remediation",
    "body": "Read each phase to see what was actually tried and what failed, passed or remained untested. A partial result means some applicable evidence is missing. Use the named source and suggested next step to investigate; one successful connection does not establish successful token acquisition or all clinical access.",
    "technical": "These results are observations, not independent PCM-Tester certification."
  },
  "admin.source-remove": {
    "title": "Remove custom source",
    "body": "Remove this custom source from future consent-approval choices and its current configuration entry. Existing approved consents retain their stored source references, so this is not a complete revocation of every earlier consent. It does not delete the remote source's clinical database.",
    "technical": ""
  },
  "admin.certificates": {
    "title": "Credential owner and role inventory",
    "body": "Inspect PCM, source, app and system-client roles, algorithm, issuer, validity and backend file checks. Shared and separate roles retain their exact owners. Registration compares the current PCM client resolver where available; missing, expired, mismatched and unknown material stays visible. The inventory contains no private key material.",
    "technical": "File checks and resolver matches do not prove a running listener loaded those files."
  },
  "admin.source-credentials": {
    "title": "Open source credentials / Source onboarding",
    "body": "Open this exact registered source’s PCM credential workspace, or the separate new-source onboarding form. Source generation and upload stay there; browsing the inventory never changes a registration. Source HTTPS server trust has its own view.",
    "technical": "The source registry ID is preserved in navigation."
  },
  "admin.cert-owner": {
    "title": "Credential owner filter",
    "body": "Show only the exact registry owner selected here. Filtering performs a read and never selects another owner for a stale identity. Source and app links open their own credential or registration context.",
    "technical": "Sign-in, filtering and Refresh retain the selected source context. Owner IDs are public context, never credential contents."
  },
  "admin.cert-fingerprint": {
    "title": "Fingerprint, file and Copy fingerprint",
    "body": "Expand secondary public file facts. Copy the complete base64url SHA-256 certificate fingerprint. If automatic copying is unavailable, the exact value is selected for your keyboard or touch Copy command. A fingerprint is not an assertion signing key ID.",
    "technical": "No credential is changed, exported or stored by this control."
  },
  "admin.cert-refresh": {
    "title": "Refresh credential facts",
    "body": "Read current certificate files and PCM client registration facts again. This does not renew credentials, restart listeners or prove listener adoption.",
    "technical": "Existing whole-Admin pending-operation guards still apply."
  },
  "admin.cert-regenerate": {
    "title": "How to renew certificates",
    "body": "Open read-only renewal instructions directly, without confirmation or a request. The instructions change no credentials. The local operator command previews the affected roles, backs up files, stops this team and recreates its listeners with the complete validated replacement. Root authorities and participant-owned material stay unchanged.",
    "technical": "Optional key replacement requires --rotate-keys; prior issued tokens may become inactive."
  },
  "admin.cert-download": {
    "title": "Export credentials as JSON / ZIP",
    "body": "Explicitly download the current certificate-directory files, including private keys and any present CA keys, for permitted local credential portability. JSON includes named contents and public role facts; ZIP preserves the file layout. Protect the downloaded secrets. This is not a complete team backup: configuration, environment, databases, Consents and logs have separate owners.",
    "technical": "Does not regenerate credentials, replace roots or change running services."
  },
  "admin.logs-browse": {
    "title": "Open related diagnostics",
    "body": "Open the central Logs application with Diagnostics shown and exact supported operation, source or correlation context. Legacy constraints that cannot be preserved require an explicit broader-context link; no replacement event is selected.",
    "technical": "Missing, cleared and unavailable records remain honest. There is one Logs viewer."
  },
  "admin.logs-json": {
    "title": "Download full logs JSON",
    "body": "Download all available configured current and retained log files through the same protected full-history export as Logs Tools. Viewer filters never restrict this export. It can contain complete non-AWS credentials, identifiers and payloads.",
    "technical": "Unavailable sources are omitted with HTTP 207 and per-source failures; healthy records remain complete. AWS credentials are always excluded."
  },
  "admin.logs-clear": {
    "title": "Clear built-in logs",
    "body": "Clear built-in current logs and retained history after the existing confirmation. Read-only extension files remain. This removes shared evidence for every operator; download anything needed first.",
    "technical": "Partial failures identify each component. New runtime events can appear immediately."
  },
  "admin.runtime-reset": {
    "title": "Reset runtime",
    "body": "Clear PCM's runtime resources and issued tokens, then recreate the initial team catalog and resources. Existing consent or token workflows may need to be started again. This is separate from deleting a HAPI clinical dataset and from clearing the Doctor app's cached state.",
    "technical": "Does not promise a backup or an undo operation."
  },
  "admin.sanity-run": {
    "title": "Run sanity check",
    "body": "Exercise the configured team's sandbox workflow and report which checks pass or fail. It makes real test requests and can clear Doctor cached/session state as part of setup. The result reflects this deployment and its available data, not a production certification.",
    "technical": "Use a disposable team for qualification requiring mutations."
  },
  "admin.sanity-result": {
    "title": "Last sanity check",
    "body": "Show or hide the recorded checks, their passed, failed, incomplete or not-exercised states, and technical details. Unverified patient evidence is distinct from gateway failure. A smoke check is not conformance certification.",
    "technical": "No rerun or log deletion occurs."
  },
  "admin.sanity-dismiss": {
    "title": "Dismiss result",
    "body": "Hide this completed sanity result in the current view. Show / hide last result opens it again; diagnostic logs and pending-operation guards remain unchanged.",
    "technical": "Dismissal sends no request."
  },
  "admin.cert-public-download": {
    "title": "Download certificate",
    "body": "Download only this registered owner and role’s public certificate as PEM. No private key is included. Refresh the inventory if the material changed or is unavailable.",
    "technical": "Protected read; exact owner, role and observed fingerprint are required."
  },
  "admin.backup-download": {
    "title": "Download backup JSON",
    "body": "Export the current team configuration, certificates and fingerprints so that those settings can be restored later. The file can contain private keys. It is not a backup of every clinical database, consent record or log history in the environment.",
    "technical": "Review the backup's team identity before restoring it elsewhere."
  },
  "admin.backup-input": {
    "title": "Paste backup JSON",
    "body": "Paste the complete ordinary configuration backup, or select a JSON file above. Both inputs share the same team, version, scope and saved-revision validation. Maximum 1 MiB. Selecting or pasting alone makes no server change.",
    "technical": "Contents stay in this form only; they are not placed in browser storage or URLs."
  },
  "admin.backup-restore": {
    "title": "Restore backup",
    "body": "Restore complete live-compatible configuration, clear PCM resources and issued tokens, and bootstrap the configured catalog. Old runtime Consents and catalog choices are not recovered. Changed deployment, preset or credential files refuse before writing and require the controlled stopped-team workflow.",
    "technical": "The existing confirmation remains. Stale review or retained checkpoint authority refuses. Config errors roll back through the existing exact-byte journal."
  },
  "doctor.page": {
    "title": "Doctor's Portal / Simulated Service Provider heading",
    "body": "This app demonstrates requesting permission and retrieving synthetic clinical data. Choose the Requesting application, then use New consent request to choose a patient and clinical service. Create consent request, review it in PCM, then Refresh status and sources and Fetch data. It is a testing interface rather than a clinical care application.",
    "technical": "“SP” stands for Service Provider."
  },
  "doctor.identity": {
    "title": "Requesting application",
    "body": "Choose which registered test application is making requests. Changing it reloads the page and changes the consent records and credentials used for that identity. It does not select a patient, choose a data source or sign you in as a real clinician.",
    "technical": "All offered options are explained in this select’s tooltip. Negative tests depend on effective checks and provisioned credentials."
  },
  "doctor.library-context": {
    "title": "Requesting application",
    "body": "These patient choices belong to the application shown here. Back to request keeps its selected service and supported draft in this tab.",
    "technical": "Change the requesting application on the request page. Sampling remains explicit and source-bound."
  },
  "doctor.library-back": {
    "title": "Back to request",
    "body": "Return to the request with this application, selected service and supported draft. This action does not choose a patient, create consent or fetch records.",
    "technical": "The draft stays in the current application and browser tab."
  },
  "doctor.identity-registered": {
    "title": "Registered team / Hospital A / Hospital B client option",
    "body": "Use this configured service-provider identity for the next workflow. Its registered organization, keys and service determine which requests it can make. The hospital or team name identifies the requesting application; it does not select which source database will return data.",
    "technical": "Apply to each configured ordinary client option using its existing readable label."
  },
  "doctor.identity-untrusted": {
    "title": "Untrusted transport (negative test) option",
    "body": "Use the deliberately untrusted transport identity to test client-certificate rejection. The assertion uses a separate ES256 signing key, so a local RSA signing failure is not the expected result. Inspect the returned error and outgoing logs to see which boundary rejected the request.",
    "technical": "Presets that relax client-certificate enforcement can reach a later authentication check."
  },
  "doctor.reset": {
    "title": "Reset Doctor state",
    "body": "Clear tracked workflow state and token caches for all requesting applications in this Doctor application, including shared users, and clear this tab’s saved request drafts. PCM Consent resources and source clinical data remain. PCM records may reappear on reload.",
    "technical": "Confirmation is required. Shared caches reset across users; saved draft cleanup applies only to this tab and Doctor mount."
  },
  "doctor.create-section": {
    "title": "New consent request",
    "body": "Choose or edit the patient, select a connected clinical service and review its public settings before creating a request. Ordinary requests require explicit PCM review. Creating a request does not fetch records.",
    "technical": "Test SMART application launch is a separate optional test in Tools."
  },
  "doctor.patient": {
    "title": "Patient identifier type and exact value",
    "body": "Use Choose patient for a listed identity or Enter identifier to type or edit the system and identifier value. Select Enter system URI manually… to type a supported namespace. Switching modes, refresh and library return keep this tab’s draft. Keep leading zeros. Pasting a full system\\|value uses that explicit type. Editing clears an obsolete selected name. Invalid or unsupported identifiers need correction before submission.",
    "technical": "The same shared parser and validator checks manual and chosen identities. Choosing never authenticates a patient or establishes source presence."
  },
  "doctor.patient-system": {
    "title": "System URI",
    "body": "Enter a currently supported identifier system URI. This is an identifier, not a website: it is never fetched or rewritten. Unsupported systems remain visible and must be corrected before creating a request.",
    "technical": "The pinned allowlist is unchanged: national identifiers, supported passport URIs, exact standard test identifiers and the existing preset-gated sandbox GUID branch. Full system\\|value paste takes precedence. Empty manual systems have no national-ID fallback."
  },
  "doctor.patient-picker": {
    "title": "Choose patient",
    "body": "Select the ordinary demo identity, an exact standard test identity, or an already loaded supported sandbox GUID. This fills the same editable patient entry and does not submit a request, approve Consent or query records.",
    "technical": "Only the exact synthetic-test namespace with value 1 or 2 receives automatic test approval. Ordinary identities require review. GUID loading is explicit and bounded in Patient library."
  },
  "doctor.patient-sources": {
    "title": "Patient selection and approval",
    "body": "An identifier is a request context, not proof of records or authentication. Only exact typed standard test values 1 and 2 receive automatic test approval without a patient decision. Ordinary identifiers require explicit Consent review.",
    "technical": "Identifiers from other namespaces with value 1 or 2 do not receive that exception."
  },
  "doctor.patient-empty": {
    "title": "No loaded sandbox sample",
    "body": "No supported GUID candidates are currently loaded. Choose an offline identity or enter an identifier. Patient library can explicitly load one bounded source page when the current profile permits it.",
    "technical": "No sample is not evidence of no clinical records."
  },
  "doctor.patient-error": {
    "title": "Patient sample unavailable",
    "body": "The explicit bounded source load failed or is unsupported in this profile. Check the selected source and current profile, then retry if available. You can still enter a supported identifier in Doctor.",
    "technical": "A failed sample never establishes patient absence."
  },
  "doctor.request": {
    "title": "Create consent request",
    "body": "Creates a request in PCM for this exact patient and selected connected service. Review the recorded status; creation does not fetch clinical records or prove a patient decision.",
    "technical": "Only the public patient identifier and provider instance association are submitted with the fixed Consent envelope. Displayed service settings and advisory app operations are not a grant or editable request scope."
  },
  "doctor.smart-start": {
    "title": "Test SMART application launch",
    "body": "Start the optional browser application-launch test from Tools. HMO sign-in verifies test identity; a separate explicit decision authorizes the application. This test creates no clinical Consent and retrieves no clinical records.",
    "technical": "S256 PKCE binds the code to its private verifier; Doctor does not reuse the application token for clinical requests."
  },
  "doctor.consents": {
    "title": "Stored PCM Consents",
    "body": "These are tracked Consent records for the requesting application, refreshed from PCM where available. Pending, active, rejected, expired and cancelled records may appear. Each card retains its own historical patient and service.",
    "technical": "The displayed count does not count guaranteed usable approvals."
  },
  "doctor.consents-empty": {
    "title": "No stored requests",
    "body": "No Consent cards are currently available for this requesting application. Use New consent request, or open Manual request testing in Tools when you already know a Consent ID. This message is not a complete audit of every consent in PCM.",
    "technical": ""
  },
  "doctor.consent-card": {
    "title": "Stored Consent",
    "body": "Read this record’s patient, associated service, recorded PCM status and approval period. Refresh status and sources, choose a named Data source and supported query actions, then Fetch data. Composer edits do not rebind this historical record.",
    "technical": "Optional request overrides support deliberate diagnostics without editing the Consent itself."
  },
  "doctor.consent-status": {
    "title": "Consent status badge",
    "body": "This is the app's latest known status for the record. An active consent is a necessary part of a normal protected request, but service state, expiry, patient mapping and permissions can still prevent access. Refresh discovery when you need a current PCM decision.",
    "technical": "A badge is not a live introspection result for every source."
  },
  "doctor.saved-scope": {
    "title": "Approval details",
    "body": "Patient, provider, service, status, dates and known sources are public Consent facts. Saved approval access details are unavailable here; open this Consent in PCM Consents to review them. Service settings are descriptive defaults. Granted permissions are obtained from the validated token response; no token means permissions are not yet obtained. Original acquisition and expiry survive cache reuse. Literal token-response restrictions are distinct from service history inputs.",
    "technical": "No private approval actor, provenance, snapshot or PCM compiler is read. The opaque bearer credential is never rendered or decoded."
  },
  "doctor.copy-consent": {
    "title": "Copy Consent ID",
    "body": "Copy the complete selectable Consent logical ID, including exact case, dots and hyphens. If clipboard permission is denied or unavailable, select the visible ID and copy manually.",
    "technical": "This action neither submits a form nor issues a token, reads FHIR data or checks token status. Business identifiers are labelled separately in Approval details."
  },
  "doctor.token-status": {
    "title": "Check token status",
    "body": "Explicit optional own-SP introspection uses normal POST /introspect and this application’s credentials. Refusal, unsupported capability or transport failure retains the validated token response and says Not independently checked. Strict disables this action.",
    "technical": "Active when checked is a dated observation. Inactive, expired or contradictory results clear current authority/results and block fetching until current context is checked. A supplied issuer must match discovery validated when the token was acquired; omitted issuer is allowed. Checks never reissue clinical tokens, fetch source data or extend original expiry."
  },
  "doctor.requests": {
    "title": "View FHIR requests",
    "body": "Inspect planned intended operations or actual sent methods, source and encoded paths. A custom GET override replaces all predefined queries. Only the predefined first-page preview is bounded to ten records per resource type.",
    "technical": "No bearer credential or assertion is shown. Expanding this disclosure sends no request."
  },
  "doctor.access-period": {
    "title": "Access mode and expiry",
    "body": "These are the public Consent’s effective access mode and recorded access period, when available. Service defaults and token lifetime are separate facts.",
    "technical": "Missing values remain unavailable. A recorded active status does not prove a current unrevoked token."
  },
  "doctor.consent-id": {
    "title": "Consent ID (Editable) / manual Consent ID",
    "body": "This identifies the PCM consent record to check or use for a data request. Editing it changes which record the next action refers to; it does not modify that consent's contents. Use arbitrary IDs only when intentionally testing missing records or access failures.",
    "technical": "This is a Consent resource identifier, not the patient ID."
  },
  "doctor.discovered-sources": {
    "title": "Data source",
    "body": "Choose a source discovered for this Consent. Its readable name identifies the destination; the complete address remains in Request overrides. A destination may be unavailable or return an empty first page.",
    "technical": "Exact audience and application/Consent/source generations isolate token details and results."
  },
  "doctor.source-button": {
    "title": "Choose Data source",
    "body": "Select the destination for this Consent’s next fetch. Selection only fills its exact target address and clears stale results; it does not fetch records or change approved sources.",
    "technical": "Tokens and request plans remain specific to each source audience."
  },
  "doctor.request-overrides": {
    "title": "Request overrides",
    "body": "Edit the Consent ID, exact target address, optional FHIR GET path or requested SMART scope for deliberate request testing. Leave the GET override empty for predefined queries; otherwise Fetch data sends that one custom GET.",
    "technical": "These inputs do not change saved Consent or grant authority."
  },
  "doctor.fhir-get": {
    "title": "FHIR GET request override (optional)",
    "body": "Start with /, for example /Patient or /Observation?_summary=count. Fetch data appends this exact path and query to Exact target address and replaces the predefined searches. The grey example disappears when you type. Clear the field to restore predefined queries.",
    "technical": "No patient filter or page-size parameter is added. Use URL encoding where needed. The requested SMART scope still supplies token request intent; the validated token and source enforce access, including read-only and denied requests. Redirects and continuation links are not followed."
  },
  "doctor.endpoint": {
    "title": "Exact target address",
    "body": "Normally use the discovered Data source. This is the FHIR base address; an optional FHIR GET override is appended after it. Edit this technical override only for deliberate routing or audience diagnostics. An address edit does not add a source to the Consent or grant access.",
    "technical": "Registered resource addresses require exact audience matching."
  },
  "doctor.discover": {
    "title": "Check / Discover",
    "body": "Read current public Consent status and its permitted source endpoints. Use this after approval, when sources are missing or after invalidated authority. This does not retrieve clinical records or approve a request.",
    "technical": "Ordinary documented PCM FHIR reads resolve the card independently of private metadata. Service unavailability preserves recorded Consent status."
  },
  "doctor.fetch": {
    "title": "Fetch data",
    "body": "Obtain or reuse a source-specific opaque token and validate its returned scope and Consent/Patient/service context. With a FHIR GET override, send that exact custom GET and let the source enforce its authority. Otherwise send selected searches allowed by the effective grant. Errors never establish clinical absence.",
    "technical": "Clinical request scope is finite app intent. This sandbox returns its saved approval independently of requested operations; an external PCM may reject the request. One-time usage remains source-enforced; optional SP status checks never start it."
  },
  "doctor.result": {
    "title": "FHIR response / first-page preview / FHIR technical details",
    "body": "Read the selected patient request context and source before interpreting results. Predefined queries show up to ten matching records per type. A custom GET retains its returned FHIR response, including count-only Bundles and individual records, in FHIR technical details. Empty or failed responses never prove no clinical data exists. Reported totals describe that query only.",
    "technical": "Source scope and Patient/source enforcement remain authoritative. Doctor follows no continuation links; a custom GET may explicitly request a count or a different page size."
  },
  "doctor.manual": {
    "title": "Manual request testing · advanced",
    "body": "Refresh status and sources for an exact Consent ID. The target address is a local test override; it cannot change approved sources, scope or patient authority. Use the resolved Consent card for clinical requests and inspect its planned or sent FHIR operations separately from the actual token response.",
    "technical": "Controls retain their existing routes and exact audience validation. Requested scope expresses finite Doctor intent, never saved approval authority."
  },
  "doctor.identity-untrusted-assertion": {
    "title": "Unregistered assertion key (negative test) option",
    "body": "Use trusted team transport while signing the assertion with a deliberately unregistered ES256 key. This isolates remote assertion-signature rejection from TLS client authentication. Review the outgoing request and response logs to confirm the server received and rejected it.",
    "technical": "If the team predates this key, generate its separate demo assertion key before running the test."
  },
  "doctor.manage": {
    "title": "Manage organization",
    "body": "Inspect the organization and endpoint records visible to the selected service-provider identity. Some supported changes can be submitted here, subject to PCM's ownership and lifecycle rules. This page manages registration information; it does not edit clinical Patient or Observation records.",
    "technical": ""
  },
  "doctor.manage-identity": {
    "title": "Requesting application",
    "body": "Choose the simulated client whose organization records you want to inspect. Changing the selection reloads the management view for that client. It does not change a record's owner or let one client edit another organization's protected fields.",
    "technical": "Bind to actual identity IDs and readable labels; do not describe object-string labels as valid identities."
  },
  "doctor.organizations": {
    "title": "Visible organizations",
    "body": "Inspect the organizations visible to the selected simulated identity. Visibility depends on the PCM response and does not imply that every displayed organization belongs to this client. The JSON editor displays the returned definition; typing does not save it.",
    "technical": "The Organization editor has no save action."
  },
  "doctor.organization-type": {
    "title": "Organization type badge",
    "body": "This identifies the role of the organization record, such as service provider or data source. The role affects which relationships and actions PCM allows. It is a server-controlled classification, not an editable label that can be used to acquire another role.",
    "technical": ""
  },
  "doctor.organization-json": {
    "title": "Organization JSON (unsaved inspection text)",
    "body": "Inspect the organization's complete structured record here. You can edit the text in the browser, but this page currently has no Update Organization button, so typing is not a saved change. PCM also treats fields such as organization type and parent relationships as protected.",
    "technical": "The existing Organization route remains separate; this view adds no save action."
  },
  "doctor.organization-empty": {
    "title": "No organization records returned",
    "body": "The app did not obtain an organization record for this selected identity. Possible causes include registration or access restrictions; the message does not establish that no organization exists anywhere in PCM. Check the selected client and its registration before changing data.",
    "technical": ""
  },
  "doctor.endpoints": {
    "title": "Associated endpoints",
    "body": "These are endpoints linked directly to the organization records in this view. They describe service connection points, not the entire set of sources approved by a patient's consent. An empty list means no such endpoints were returned for this view.",
    "technical": ""
  },
  "doctor.endpoint-card": {
    "title": "Endpoint name, ID and status",
    "body": "This identifies one registered endpoint and its lifecycle state. Active, suspended and off states affect whether it can be used and which updates are permitted. Confirm the endpoint's identity before editing the structured definition below.",
    "technical": "An `off` endpoint is terminal; address replacement is restricted to suspended endpoints."
  },
  "doctor.endpoint-json": {
    "title": "Endpoint JSON",
    "body": "Edit the structured endpoint record you want PCM to update. Keep required fields and ownership relationships intact; arbitrary changes to protected fields or an invalid lifecycle transition are rejected. Editing the text does not save it until Update Endpoint is submitted.",
    "technical": "Public updates use the allowed interaction-specific FHIR shape."
  },
  "doctor.endpoint-update": {
    "title": "Update endpoint",
    "body": "Submit this endpoint's edited definition to PCM. A successful update can affect where related requests are directed or whether the endpoint is usable. A rejected draft stays in the response for correction and is not saved or put in browser storage. Read the validation response before retrying; the server remains authoritative about allowed fields and state transitions.",
    "technical": ""
  },
  "doctor.catalog-section": {
    "title": "Request a non-material catalog update",
    "body": "Propose a limited correction to an existing service catalog definition. Only the name, purpose or example query may change through this request. Acceptance records the proposal for review; it does not immediately alter the live service used by consent and token workflows.",
    "technical": ""
  },
  "doctor.catalog-json": {
    "title": "Complete authoritative catalog JSON",
    "body": "Provide the complete catalog representation with only the eligible corrections made. A small fragment containing just the changed name is not the expected input. Preserve the catalog's identity and all fields whose meaning you are not authorized to change.",
    "technical": "The proposal is submitted through `$request-catalog-update`, not a direct catalog PUT."
  },
  "doctor.catalog-reason": {
    "title": "Reason (optional)",
    "body": "Explain why the catalog correction is needed so the reviewer can understand your request. This text supports the proposal; it does not expand which fields may change or approve the change automatically. You can leave it blank when no extra context is needed. A rejected proposal keeps its reason and JSON in that response for correction.",
    "technical": ""
  },
  "doctor.catalog-submit": {
    "title": "Submit request",
    "body": "Send the complete proposed catalog correction to PCM for out-of-band review. A successful acknowledgement means the proposal was accepted for that process. The live catalog remains unchanged until an authorized decision applies a change.",
    "technical": "No separate public approval resource is created for you to poll."
  },
  "doctor.sandbox-mode": {
    "title": "Selected sandbox profile",
    "body": "This heading describes the configured profile. Transport and client-assertion checks may be relaxed, while approved permissions and applicable patient/source restrictions still apply. Use fabricated data and credentials only.",
    "technical": "A profile name is not a live source check, a test result, independent conformance evidence or proof of an explicit patient decision."
  },
  "doctor.sandbox-details": {
    "title": "Configured checks and compatibility",
    "body": "Expand the current page's configuration summary. Security checks, enabled compatibility accommodations, troubleshooting advice and diagnostic guidance have separate tabs.",
    "technical": "Configuration is supplied when the page renders. This notice does not probe running sources or establish conformance, availability or patient approval."
  },
  "doctor.sandbox-checks": {
    "title": "Security checks",
    "body": "Inspect configured certificate and client-assertion checks. Sources with identical settings share a table; differences remain separate. Enabled and Relaxed describe configuration, not a live verification result.",
    "technical": "Clinical permissions and applicable Patient/source authority remain enforced independently of these transport and assertion settings."
  },
  "doctor.sandbox-compatibility": {
    "title": "Compatibility accommodations",
    "body": "Read which legacy formats the configured policy permits and their adapter identifiers. These notes describe enabled settings, not evidence that a request used an accommodation.",
    "technical": "Exact unknown configuration notes remain visible. Investigate actual request behavior through Logs."
  },
  "doctor.sandbox-troubleshooting": {
    "title": "Sandbox troubleshooting",
    "body": "Read advice about context changes, cached positive decisions and refreshing status. A successful fetch does not prove a patient decision; inspect the recorded Consent and approval origin.",
    "technical": "Refreshing does not approve, restore or extend a Consent, and does not promise immediate downstream cache invalidation."
  },
  "doctor.sandbox-diagnostics": {
    "title": "Sandbox diagnostics",
    "body": "Logs may contain identifiers, tokens, client assertions and clinical payloads. Use fabricated data and credentials, and review diagnostic content before sharing.",
    "technical": "This tab displays guidance only; opening it does not read logs or fetch clinical data. AWS credential isolation remains unchanged."
  },
  "doctor.sandbox-technical": {
    "title": "Sandbox technical notes",
    "body": "Read the exact configured profile and policy version, plus the legacy Node clinical-backend availability note.",
    "technical": "The policy version identifies configuration rules; it is not an independent qualification result or an observed source version."
  },
  "pcm.page": {
    "title": "My Consents / Simulated Patient Portal",
    "body": "This is the sandbox's patient-facing view of consent requests held by PCM. It lets you review requests and make simulated decisions about access. The page is not a real patient sign-in system, and the team badge does not identify a verified person.",
    "technical": ""
  },
  "pcm.registry": {
    "title": "Consent Registry",
    "body": "Inspect saved Consent lifecycle states, including inactive and terminal records. Review requested records or open View Consent for details, approval dates and retained status-change evidence. Opening a record neither restores authorization nor checks source availability or clinical data.",
    "technical": "FHIR status and PCM business status are shown separately."
  },
  "pcm.status": {
    "title": "Consent status",
    "body": "This is the consent status recorded by PCM. Read it together with the approval dates. Successful data access in the sandbox does not prove that consent is approved.",
    "technical": "Stored lifecycle and elapsed approval dates are separate facts."
  },
  "pcm.status-details": {
    "title": "Show or hide status details",
    "body": "Expand the explanation beneath this Consent row to read its recorded lifecycle cause, what the state means, FHIR status and any recorded test-auto-approval origin. The short test warning stays visible when details are closed.",
    "technical": "Uses only the already-rendered record; opening details makes no request or Consent change. Missing approval provenance does not imply a patient decision."
  },
  "pcm.consent-id": {
    "title": "Consent ID",
    "body": "This identifies the particular consent record linking a patient, requester and service. Use it to match this row with the Doctor app's consent card or related logs. It is different from the patient's identifier and from the OAuth token used for a later request.",
    "technical": ""
  },
  "pcm.parent": {
    "title": "Parent Organization",
    "body": "This names the parent organization associated with the requesting service provider. It gives context about who stands behind the request. It is not necessarily one of the clinical sources whose data you will approve.",
    "technical": ""
  },
  "pcm.requester": {
    "title": "Service Provider / Requestor",
    "body": "This is the organization asking to use the patient's data for the stated service. Review it together with the purpose before making a decision. It is the recipient of the requested access, not automatically the organization that holds the clinical records.",
    "technical": ""
  },
  "pcm.service": {
    "title": "Requested service",
    "body": "The service for which data access was requested. Its registered definition specifies the normal data categories, sensitivity restrictions and history limits. Sandbox overrides are shown separately.",
    "technical": "Both the provider registration and shared definition must be usable for normal protected access."
  },
  "pcm.patient": {
    "title": "Patient identifier",
    "body": "The patient identifier attached to this request. Check both its value and identifier type before approving. It may differ from the patient record ID used by an individual data source.",
    "technical": "Listing an identifier does not prove that a source holds matching records."
  },
  "pcm.review": {
    "title": "Review request",
    "body": "Open the pending request to inspect its organization, patient and service, then choose sources and permissions before approving or declining.",
    "technical": "Opening the page makes no decision."
  },
  "pcm.registry-empty": {
    "title": "No consent requests found",
    "body": "This view currently has no consent records to display. Start a request from the Doctor app if you want to demonstrate the review workflow. The message says nothing about whether clinical records are present in the source databases.",
    "technical": ""
  },
  "pcm.review-details": {
    "title": "Consent Details / Request Details / View Consent / Refresh Consent",
    "body": "Inspect the requester, patient, service, lifecycle, approval period and available status evidence. Requested records may be reviewed for approval; inactive and terminal records remain read-only. Refresh retrieves current authoritative state after a conflict or error.",
    "technical": "Viewing or refreshing does not approve, restore or extend the Consent."
  },
  "pcm.sources": {
    "title": "Select Information Sources",
    "body": "Choose which configured source organizations may be included in this consent approval. A selected source contributes its endpoint to the discovery workflow where permitted. Selection authorizes participation in the consent; it does not prove the source is online or holds records for the patient.",
    "technical": ""
  },
  "pcm.source-choice": {
    "title": "Choose a data source",
    "body": "Include this source in the approval you are about to submit. Your selection is saved only when you choose Approve request.",
    "technical": "Selecting a source does not prove it is online or holds data for this patient."
  },
  "pcm.source-address": {
    "title": "Address under a source / built-in badge",
    "body": "This is the configured endpoint for the named source, helping you identify the intended destination. A built-in badge means the source comes from the team's standard setup. Neither the address nor the badge proves that the source is available or has verified patient data.",
    "technical": "The legacy Node distribution remains visible but does not support clinical access; managed HAPI sources enforce the qualified subset."
  },
  "pcm.scope": {
    "title": "Choose data permissions",
    "body": "Choose the permissions to save at approval. Sandbox alternatives may grant more access than the service default.",
    "technical": "The preview describes the selected scope. Complete exact values are available below."
  },
  "pcm.approve": {
    "title": "Approve request",
    "body": "Approve this request using the selected sources and permission option. This saves the decision; it does not retrieve patient records.",
    "technical": "Existing lifecycle, source validation and backend authorization still apply."
  },
  "pcm.decline": {
    "title": "Decline request",
    "body": "Decline this request. A new request is needed to seek approval again. Patient data is unaffected.",
    "technical": ""
  },
  "pcm.cancel-consent": {
    "title": "Permanently cancel consent",
    "body": "Cancel this consent on behalf of the requesting organization. This permanently ends its use for consent-based access. It does not delete patient data or alter separate non-clinical workflows.",
    "technical": "New tokens and fresh PCM token validation reject this consent. Previously cached decisions may remain usable for up to 30 seconds. Admin authentication, owning-provider permission, version and CSRF checks are required."
  },
  "pcm.cancel": {
    "title": "Back to Consents",
    "body": "Return to the consent list without saving changes.",
    "technical": "This navigation does not cancel the consent."
  },
  "scope.auto-resources": {
    "title": "All records of the service’s resource types",
    "body": "Read and search the service’s resource types without category, sensitive-category or record-date limits. This sandbox alternative can grant more access than the service default.",
    "technical": "R and V exclusions still follow the service setting. Enabled master data remains read only. Review the selected exact scope before approval."
  },
  "scope.auto-buckets": {
    "title": "Service categories with dates recalculated for this approval",
    "body": "Rebuild permissions from the service categories, sensitivity settings and history limits for this review. This can grant more access than the saved service default.",
    "technical": "The displayed fixed dates are saved once at approval; they do not move with the clock."
  },
  "scope.authored": {
    "title": "Use the service’s permissions",
    "body": "Save the exact service permissions, including their fixed record dates, for this consent. Later service changes do not replace the saved approval.",
    "technical": "If the service default is unavailable, refresh or choose an explicit alternative; no permissions are inferred."
  },
  "scope.custom": {
    "title": "Enter OAuth scope manually",
    "body": "Replace the service permissions with your complete exact scope for sandbox testing. It can grant more access. Warnings permit saving experimental input, but invalid or unsupported permissions cannot be used for data access.",
    "technical": "Ordinary finite scopes require Patient read/search and explicit V exclusions. Exact patient/*.rs includes R and V. The text is saved without trimming, repair or date substitution."
  },
  "smart.page": {
    "title": "Test SMART application launch",
    "body": "Review the registered application, current test identity and exact requested permissions before making a decision. HMO verification, SMART application approval and clinical Consent have separate purposes.",
    "technical": "Strict browser navigation uses HTTPS without a client key; backend token exchange retains confidential client authentication."
  },
  "smart.patient": {
    "title": "Verified test identity",
    "body": "Only a fresh verified self session in this browser can supply this person identity. Selecting a dependent does not authorize that dependent.",
    "technical": "Expired, changed or cross-browser identity requires a fresh request; HTEST does not establish person login."
  },
  "smart.scopes": {
    "title": "Optional scope narrowing",
    "body": "Uncheck complete requested scopes to narrow this protocol test. At least one permission must remain. Closing these details keeps the checked request permissions.",
    "technical": "The server validates an exact subset; this does not edit a clinical Consent or service definition."
  },
  "smart.approve": {
    "title": "Authorize test launch",
    "body": "Explicitly authorize the selected test identity and requested permissions. PCM returns a single-use code to the exact registered callback for confidential exchange.",
    "technical": "This decision does not create clinical Consent or retrieve source clinical data."
  },
  "smart.deny": {
    "title": "Deny test launch",
    "body": "Explicitly refuse this application test and return a denial to Doctor. No code or application token is issued.",
    "technical": "OAuth access_denied is retained; authored feedback distinguishes denial from cancellation."
  },
  "smart.cancel": {
    "title": "Cancel and return to Doctor",
    "body": "End only this pending application test without approving it. Another tab retains its own pending request.",
    "technical": "Cancellation consumes this decision once and returns OAuth access_denied with an authored cancellation description."
  },
  "logs.page": {
    "title": "Central Unified System Logs heading / log list",
    "body": "Follow recorded activity from the team's configured components in one view. Select a row to inspect its full details, and use ordering controls to follow a workflow or compare times. The viewer is diagnostic evidence, not a guarantee that every possible event was recorded.",
    "technical": "Native HAPI request, permission and selected error records are separate from legacy import diagnostics; collection gaps remain explicit."
  },
  "logs.workbench-filters": {
    "title": "Filters",
    "body": "Open the responsive field grid, then use the Apply / Reset row for browsing or the separate Search retained files action. Progress and result controls appear above the event list. Opening this sidebar keeps Event detail available.",
    "technical": ""
  },
  "logs.workbench-coverage": {
    "title": "Coverage",
    "body": "Show source availability for the loaded evidence, retention and instrumentation limits, exact source/role/HO filter actions and recorded ID investigations. Later source checks are separate from captured evidence. Advanced viewer state is under Tools.",
    "technical": "Available streams do not prove complete events or hops."
  },
  "logs.workbench-tools": {
    "title": "Tools and options",
    "body": "Open the sidebar for Filters, Coverage, Columns and Tools. Tools contains local row annotations, spacers, full export and protected log clearing.",
    "technical": "Close tools or Escape returns focus to the opener. Event detail stays independent."
  },
  "logs.close-workbench": {
    "title": "Close tools",
    "body": "Close the upper sidebar and return its space to the table. Event detail stays open.",
    "technical": ""
  },
  "logs.close-event": {
    "title": "Close event",
    "body": "Close the bottom Event detail pane while keeping the upper sidebar and current log view.",
    "technical": ""
  },
  "logs.return": {
    "title": "Return to results",
    "body": "Restore the view held before correlation, trace or flow inspection, including its filters, Diagnostics, reading position, selection and detail format. Recent views live only in this tab; browser Back and Forward also restore them while available.",
    "technical": ""
  },
  "logs.all": {
    "title": "All logs",
    "body": "Leave the current flow or trace investigation and open the latest view across configured sources.",
    "technical": ""
  },
  "logs.apply-filters": {
    "title": "Apply filters",
    "body": "Use the primary button in the browse action row, or press Enter in a field, to browse a bounded event page using the exact event filters together. Source ID applies to browse and search. Literal text and UTC time fields apply only to Search retained files.",
    "technical": "Browsing/live reads keep their existing byte-page limits."
  },
  "logs.reset-filters": {
    "title": "Reset filters",
    "body": "Cancel a retained search, clear the event and search fields, and load the latest browse page in the current view.",
    "technical": ""
  },
  "logs.search-start": {
    "title": "Search retained files",
    "body": "Use this separate search action below Apply / Reset to search current files and five rotations. IDs match exactly; text ignores case. Appends are excluded. Progress, pages, cancellation and Return appear above the event list.",
    "technical": ""
  },
  "logs.search-text": {
    "title": "Literal message / payload text",
    "body": "Find this literal text in the normalized message or individual string values under event details, including payloads, bodies, headers and IDs. Matching ignores case, keeps spaces, and never interprets regex or Boolean operators. Values blocked by AWS policy cannot match.",
    "technical": "Property names, configured source/role, classification values and raw JSON syntax are excluded. A match cannot cross two values; JavaScript Unicode lowercase applies without accent or locale folding."
  },
  "logs.coverage-sources": {
    "title": "Sources for loaded evidence",
    "body": "Source states describe the loaded evidence response within its filter scope. Available means retained files could be read; it does not prove every event or hop was recorded. Missing or failed streams may supply no evidence.",
    "technical": "HAPI runtime and import are separate sources. Writer health reports drops and unavailable or stale diagnostics; a receipt alone does not prove completion."
  },
  "logs.coverage-filter": {
    "title": "Apply one exact filter",
    "body": "Apply only this exact registered source, role or health organization and keep unrelated filters and Diagnostics. Browse keeps held/following state. Retained search stays a retained search.",
    "technical": "Remove the filter in Coverage or use Back to restore the previous view. An unavailable source may return no events; filtering cannot recover missing logs or instrumentation."
  },
  "logs.coverage-remove": {
    "title": "Remove this filter",
    "body": "Remove only the named source, role or health organization filter; keep the remaining filters and Diagnostics. This explicitly widens that one filter dimension.",
    "technical": "Back restores the prior view."
  },
  "logs.coverage-evidence": {
    "title": "Evidence in the loaded window",
    "body": "Counts describe only the currently loaded page or window. More bounded pages may be available. Filters, event visibility, unavailable sources, oversized omissions and retention limit the evidence.",
    "technical": "A normal continuation is not lost logging. Full export can include retained oversized lines but cannot recover never-recorded events."
  },
  "logs.coverage-warning": {
    "title": "Evidence read problem",
    "body": "Catch-up or history failure retains the prior rows and checkpoint. Read the stated reason; retry by scrolling where supported or use Jump to latest. The prior loaded evidence does not certify the missing interval.",
    "technical": "Viewer diagnostics under Tools gives technical reader state."
  },
  "logs.coverage-health": {
    "title": "Later source checks",
    "body": "A newer check describes its own requested source scope and current read availability. It does not change or certify the earlier captured evidence.",
    "technical": "Unknown inventory is not healthy."
  },
  "logs.coverage-journey": {
    "title": "Investigate an observed exact ID",
    "body": "Count each recorded Flow, Trace and Correlation ID in the loaded page or window; groups may share rows. Inspect searches that exact ID across configured roles and organizations, explicitly setting other filters aside and keeping Diagnostics.",
    "technical": "Return or Back restores the prior view. Matching evidence is not a complete distributed trace or proof of causality; missing propagation cannot be recovered."
  },
  "logs.coverage-legend": {
    "title": "Role color key",
    "body": "The legend explains colors only. Listed roles are not all necessarily configured or observed.",
    "technical": "Use the source inventory above for actual availability."
  },
  "logs.viewer-diagnostics": {
    "title": "Viewer diagnostics",
    "body": "Advanced reader, cache, render and polling state, including bounded requests, offscreen eviction and reload behavior. This does not change events.",
    "technical": "The separate Diagnostics switch in Filters controls event visibility."
  },
  "logs.search-source": {
    "title": "Source ID",
    "body": "Narrow browse or retained search to one registered source ID, such as ho-b-adapter or extensions/example. Unknown source IDs are rejected safely. This is an exact, case-sensitive ID, not a display label or filesystem path.",
    "technical": "A source may be absent, unavailable or have limited coverage. The search does not add instrumentation."
  },
  "logs.search-time": {
    "title": "UTC time range",
    "body": "Narrow retained search to normalized event timestamps between the inclusive From and Until bounds. Enter ISO UTC time ending in Z, such as 2026-11-04T10:00:00Z; leave either field empty for an open bound. Records without a valid timestamp do not match an active time bound.",
    "technical": "A derived gateway request uses its estimated request timestamp; its raw source remains the completion record."
  },
  "logs.search-retry": {
    "title": "Retry retained search",
    "body": "Start a fresh captured query with the actual previous search scope, including its exact ID and Diagnostics setting. Unapplied filter edits are ignored. Retry after a failure, cancellation, rotation or expired job; previous partial results do not establish a complete workflow.",
    "technical": ""
  },
  "logs.search-progress": {
    "title": "Retained search status",
    "body": "See bytes and captured files searched, visible matches found and whether the query is running, complete within captured files, partial, cancelled or failed. Zero matches while searching is not a completed empty result. Limits and unavailable sources remain visible.",
    "technical": "These are retained observations, not a complete distributed trace or proof that every source emitted evidence. No global completion percentage is claimed."
  },
  "logs.search-pages": {
    "title": "Search result pages",
    "body": "Move between up to 200 matching summaries per result page. Pages follow fixed source ID, relative file path and ascending byte coordinates; the chosen view orders or groups only within each page. Progress polling does not rescan the logs.",
    "technical": "Each source coordinate and gateway variant has its own stable identity. Identical lines at different coordinates are separate events."
  },
  "logs.search-cancel": {
    "title": "Cancel search",
    "body": "Stop the running query and keep matches already found as an explicitly cancelled result. Retry starts a fresh query; Return to browsing restores the held view. This action never clears stored logs.",
    "technical": "Cancellation terminates the bounded worker. The button becomes unavailable after the query stops."
  },
  "logs.search-return": {
    "title": "Return to browsing",
    "body": "Cancel any running retained query and restore the browse view held before it started, including its selection and scroll position. New appends remain available through the normal browse/live controls.",
    "technical": "Search and browsing use separate retrieval paths."
  },
  "logs.inspection": {
    "title": "Exact recorded ID investigation",
    "body": "Correlation joins one recorded request/exchange ID; Trace matches one propagated trace ID; Flow matches a recorded workflow ID that may span traces. All use bounded retained search jobs with progress, cancel and retry. Observed roles/sources describe matching result pages received, not guaranteed participants. Missing propagation, source failures, retention and native writer drops can hide evidence. HAPI runtime and legacy import remain distinct sources.",
    "technical": ""
  },
  "logs.trace-id": {
    "title": "Trace ID",
    "body": "The recorded propagated trace identifier. A dash or Not recorded means no trace ID is available. The compact table value opens the full ID for selection or copying. Different trace IDs remain separate even when a correlation ID connects their observations.",
    "technical": "An exact trace search cannot recover missing propagation or prove complete span coverage."
  },
  "logs.inspect-correlation": {
    "title": "Inspect related correlation across roles",
    "body": "Search retained files for this exact correlation/request ID across all configured roles and organizations. It can join gateway, auth and proxy observations whose trace IDs differ, without claiming causality. Other filters are set aside; Diagnostics stays unchanged. This opens a separate investigation; Return or Back restores the prior results.",
    "technical": ""
  },
  "logs.inspect-flow": {
    "title": "Inspect this flow across roles",
    "body": "Search retained files for this exact recorded workflow ID, which may span requests and traces. Searches all configured roles and organizations; other filters are set aside and Diagnostics stays unchanged. Return restores the previous view. Grouping does not create a flow ID.",
    "technical": ""
  },
  "logs.inspect-trace": {
    "title": "Inspect this trace across roles",
    "body": "Search retained files for one propagated trace ID and its recorded spans across configured roles and organizations. Other filters are set aside and Diagnostics stays unchanged. Correlation-only events and different trace IDs stay excluded; explicitly inspect related correlation to find them. Return restores the previous view.",
    "technical": ""
  },
  "logs.filter-role": {
    "title": "Role",
    "body": "Choose the emitting role, or All roles to include every configured role. Select Apply filters to load results.",
    "technical": ""
  },
  "logs.filter-healthOrganizationId": {
    "title": "Organization ID",
    "body": "Match the exact organization ID recorded on an event. Select Apply filters to load results.",
    "technical": ""
  },
  "logs.filter-level": {
    "title": "Level",
    "body": "Match the displayed event severity exactly. Derived gateway requests use INFO; their source response keeps its recorded severity. Select Apply filters to load results.",
    "technical": ""
  },
  "logs.filter-method": {
    "title": "HTTP method",
    "body": "Match the recorded HTTP method exactly. Select Apply filters to load results.",
    "technical": ""
  },
  "logs.filter-operationId": {
    "title": "Exact operation ID",
    "body": "Match the recorded administrative or native import operation ID exactly across configured files. Missing IDs do not match.",
    "technical": "This uses the existing bounded browse and retained search; it does not infer protocol correlation."
  },
  "logs.filter-sourceId": {
    "title": "Exact registered source ID",
    "body": "Match the recorded registered source ID exactly. This differs from the configured log file source ID.",
    "technical": "Records without this field do not match. Source runtime coverage can be incomplete."
  },
  "logs.filter-correlationId": {
    "title": "Correlation ID",
    "body": "Match the complete recorded correlation ID exactly. Select Apply filters to load results.",
    "technical": ""
  },
  "logs.filter-flowId": {
    "title": "Flow ID",
    "body": "Match the complete recorded flow ID exactly. Select Apply filters to load results.",
    "technical": ""
  },
  "logs.filter-traceId": {
    "title": "Trace ID",
    "body": "Match the complete recorded trace ID exactly. Select Apply filters to load results.",
    "technical": ""
  },
  "logs.filter-path": {
    "title": "Path",
    "body": "Match the recorded URL path exactly, without its query string. Select Apply filters to load results.",
    "technical": ""
  },
  "logs.filter-status": {
    "title": "HTTP status",
    "body": "Match the recorded HTTP status code exactly. Select Apply filters to load results.",
    "technical": ""
  },
  "logs.flow-order": {
    "title": "Group related events",
    "body": "Gather related events within the loaded page using recorded IDs and heuristics. This can reorder events for readability; group headers do not establish a complete workflow or causality. Choose Timeline for chronological ordering within the page.",
    "technical": "The saved flow mode and grouping algorithm are unchanged. Actual Flow ID inspection is a separate exact-ID action."
  },
  "logs.timeline-order": {
    "title": "Timeline",
    "body": "Arrange the available events by timestamp with stable tie-breaking. Use this when comparing the recorded order of events is more useful than keeping related requests together. Matching timestamps alone do not prove that two events belong to the same request.",
    "technical": ""
  },
  "logs.tail-top": {
    "title": "Newest first",
    "body": "Put the newest end of the selected log ordering at the top of the view. This makes recent activity easy to follow while the page refreshes. It changes display order and reloads the view; it does not change stored log timestamps.",
    "technical": ""
  },
  "logs.tail-bottom": {
    "title": "Newest last",
    "body": "Put the newest end of the selected log ordering at the bottom of the view. This can make a workflow easier to read from older to newer activity. It changes display order and reloads the view; existing records remain unchanged.",
    "technical": ""
  },
  "logs.mark-yellow": {
    "title": "Y / yellow mark",
    "body": "Mark the selected row yellow as a personal visual reminder while investigating. Select a log row first. The mark is saved in this browser's view settings and does not change the recorded event, its severity or the application's result.",
    "technical": "Color has no built-in workflow meaning; use it consistently for your own review."
  },
  "logs.mark-green": {
    "title": "G / green mark",
    "body": "Mark the selected row green so you can recognize it while comparing events. Select a row first. Green is your annotation here, not proof that the underlying request passed or that its contents were independently verified.",
    "technical": "Saved as browser presentation state, not written into the log."
  },
  "logs.mark-red": {
    "title": "R / red mark",
    "body": "Mark the selected row red to draw your attention to it during troubleshooting. This does not turn the event into an error or change its recorded severity. Select the row you want to annotate before pressing the button.",
    "technical": ""
  },
  "logs.mark-clear": {
    "title": "Clear beside Y/G/R",
    "body": "Remove the color annotation from the selected row. This clears only your visual mark, so the event and its full payload stay available. To delete stored log data, use the separate Clear Logs action and its confirmation.",
    "technical": ""
  },
  "logs.spacer-above": {
    "title": "Spacer above",
    "body": "Add or remove a visual gap above the selected row to separate parts of your investigation. Choose a row first. The gap changes only this browser's presentation and does not insert an event or alter the recorded timestamps.",
    "technical": ""
  },
  "logs.spacer-below": {
    "title": "Spacer below",
    "body": "Add or remove a visual gap below the selected row. This can help you distinguish one test run from the next while reading. It does not modify the underlying log or automatically identify a real transaction boundary.",
    "technical": ""
  },
  "logs.spacer-tail": {
    "title": "Spacer at log tail",
    "body": "Place a visual separator at the current newest log entry, using the selected top-or-bottom tail position. It helps you recognize the point where you started watching for new activity. It does not clear earlier entries or stop new events from arriving.",
    "technical": "The separator is attached to the current tail entry."
  },
  "logs.reader-state": {
    "title": "Reader state",
    "body": "Following latest means the active filtered view has accepted every page in its captured update interval. Loading updates means initial loading or a deliberate catch-up is unfinished. Routine polls keep Following latest stable. Position held keeps rows, selection and scroll stable while background checks continue. Select an event or scroll away to hold; return to the actual newest edge or choose Jump to latest to catch up. Failure text gives the retry action; it never means following. Search snapshot is fixed retained evidence and excludes appends.",
    "technical": "This indicator does not establish complete distributed traces or source health."
  },
  "logs.active-scope": {
    "title": "Active scope",
    "body": "This summary names the effective filters for the active browse view or retained search, not unapplied form edits. Choose Edit filters to change the current filters. Exact filter values appears only when values are shortened or additional filters overflow the summary; it shows every full value. Shortened values are display-only. All roles and organizations describes requested scope, not evidence from every participant.",
    "technical": "Exact ID investigations set other filters aside; Return and browser history restore the earlier view."
  },
  "logs.diagnostics": {
    "title": "Diagnostics",
    "body": "Show sandbox UI activity and supporting diagnostic events, including authentication page/form wrappers and generic action summaries, startup, conformance, rejected-configuration and failed sanity summaries. Actual HMO authentication, OTP decisions and downstream protocol evidence remain visible by default. When hidden, real call-flow and protocol events remain visible: FHIR/OAuth, gateway/auth, token, cache, retry and authorization evidence, including errors. Observed diagnostic errors have one actionable notice.",
    "technical": "Hiding rows never deletes stored evidence or changes full export. Historical diagnostic errors do not establish current service health."
  },
  "logs.critical-diagnostic": {
    "title": "Diagnostic errors observed in retained evidence / Show exact error",
    "body": "An error was observed among records already read within bounded page or search work, including harness sanity-check failure summaries. Underlying real request and service errors remain visible with Diagnostics OFF. This is not a global error count or a claim that a service is currently failing. Show exact error enables Diagnostics and temporarily sets other filters aside to select that exact source event. Return restores the prior view.",
    "technical": "Only one compact target is held; repeated errors are consolidated. Clear, rotation or retention can make the target unavailable; no different event is substituted."
  },
  "logs.critical-return": {
    "title": "Return to previous view",
    "body": "Restore the saved filters, Diagnostics setting, selection and scroll from before opening the observed diagnostic error. Browser Back and Forward also restore bounded in-tab snapshots.",
    "technical": "The viewer retains at most twenty in-tab snapshots; clear discards them."
  },
  "logs.clear": {
    "title": "Clear built-in logs",
    "body": "Clear built-in current logs and retained history after confirmation. Read-only extension sources are retained and listed in the result. This removes shared evidence, not just visible rows. Preserve needed records first; holding your position and hiding Diagnostics do not protect stored logs from clear.",
    "technical": "New runtime activity can create new entries immediately after clearing."
  },
  "logs.time": {
    "title": "Time column / detail timestamp",
    "body": "This is the time recorded for the event. Use it to compare events and narrow an investigation, keeping display timezone and clock differences in mind. With Group related events selected, nearby rows are related for readability and may not be globally time-ordered.",
    "technical": "The detail panel retains the recorded timestamp representation."
  },
  "logs.component": {
    "title": "Component column / detail badge",
    "body": "The compact badge names the emitting role, with the organization beside it. Hover for the full label and technical source identity, or open Event metadata in the bottom detail pane. Roles, organization identity, severity and your local row marks are separate.",
    "technical": ""
  },
  "logs.correlation": {
    "title": "Correlation ID column / Request ID",
    "body": "Correlation identifies one recorded request or exchange. The compact table value opens the complete recorded ID for selection or copying without changing the selected event. A dash or Not recorded means no ID was recorded. Event metadata and exact correlation inspection use the same value.",
    "technical": "Legacy Request ID is used only when correlation ID is unavailable."
  },
  "logs.level": {
    "title": "Level column / severity badge",
    "body": "This is the event severity, such as INFO, WARN or ERROR. Derived gateway requests use INFO independently of the response outcome; responses and native errors keep their recorded severity. Inspect the message and payload for the actual outcome. INFO alone does not prove workflow success.",
    "technical": "Emitted gateway arrivals have their own raw request record. A derived request's Raw text shows the source response and can contain WARN or ERROR."
  },
  "logs.class": {
    "title": "Class column / detail class badge",
    "body": "This classifies the kind of activity, helping distinguish application flow from supporting diagnostics or test-harness actions. It is different from severity: a diagnostic event can still be an error. The Diagnostics switch affects visibility of records marked for that purpose.",
    "technical": ""
  },
  "logs.message": {
    "title": "Message column / detail Message",
    "body": "This is the event's short human-readable description. Select a row for its complete record. Current gateway arrival events are emitted before authorization or upstream processing and have their own raw text. Historical completion-only requests remain labeled derived. A missing completion in this view does not establish failure.",
    "technical": "Arrival IDs pair only within their configured source and distinguish the public request from its internal auth subrequest. A completion may refer to an arrival outside this page or retention window."
  },
  "logs.row": {
    "title": "Individual log row / selected row",
    "body": "Select an event to open its full record in the bottom Event detail pane. Use JSON, Structured record or Raw text while metadata remains beside them, or below on narrow screens. Selection holds the list in place while new events wait. Scroll to the newest edge or use Jump to latest to follow again. The selected record stays available even if it leaves the current page. Color and spacer tools affect this selection only.",
    "technical": "Help outlines must remain distinguishable from the normal row-selection outline."
  },
  "logs.flow-summary": {
    "title": "Related event group",
    "body": "This header gathers related events within the loaded page using recorded IDs and heuristics. It can reorder rows and may show only part of a workflow. Inspect individual events for exact messages and outcomes; headers do not establish a complete workflow or causality.",
    "technical": "Grouping is a reading aid, not an action that can be approved or replayed."
  },
  "logs.resizer": {
    "title": "Resize the bottom Event detail pane",
    "body": "Drag this horizontal divider up or down with a mouse or touch. Up and Down arrow keys change the height by five percentage points; Home chooses the readable minimum for your viewport and End chooses 70 percent of the workspace. The minimum is at least 25 percent and grows on shorter screens. Closing Event detail gives its height back to the logs.",
    "technical": "Only the bounded size preference is saved locally, never event payloads. Cancelled drags restore their starting size."
  },
  "logs.details": {
    "title": "Event detail",
    "body": "The bottom pane opens JSON first, with Structured record, conditional FHIR exchange and Raw text tabs. Event metadata stays beside every format, or below on narrow screens. Event detail and the upper sidebar close independently. Inspect correlation, trace or flow sets other filters aside and preserves Diagnostics; Return restores your earlier view, tab, size and place.",
    "technical": "Matching IDs are bounded evidence, not a complete distributed trace."
  },
  "logs.json-tab": {
    "title": "JSON",
    "body": "Read the complete normalized selected object, pretty-printed with nested objects and arrays expanded. Copy JSON copies this complete object. No fields are omitted by the structured explorer or its search.",
    "technical": "Arrow keys, Home and End switch format tabs."
  },
  "logs.fhir-tab": {
    "title": "FHIR exchange",
    "body": "Read the captured request and response with exact URLs, expanded readable JSON and collapsed parameters/headers. Missing methods stay unknown; multiple candidates remain separately numbered. Field paths and provenance are available in JSON/Structured record.",
    "technical": "Arrow keys switch available tabs. No other event, FHIR endpoint or full export is fetched."
  },
  "logs.fhir-copy": {
    "title": "Copy recorded FHIR value",
    "body": "Copy request includes recorded method/URL, headers and the original body. Copy JSON copies the recorded response string or serializes its object as JSON. Exact URL/body actions remain beside parameter views; display bounds never silently shorten copies.",
    "technical": "If automatic copy is blocked, use the existing manual-copy text area. Large values remain in JSON/Structured record or the authenticated export."
  },
  "logs.structured-tab": {
    "title": "Structured record",
    "body": "Read event-specific recorded facts, explore every field, and use recorded token, HTTP or authorization views. Missing fields stay unavailable. JSON shows the complete expanded normalized object; Raw text preserves independent source text.",
    "technical": "Use Left and Right arrow keys, Home or End while focused on a format tab. No current token state is fetched."
  },
  "logs.raw-tab": {
    "title": "Raw text",
    "body": "Read the exact source text returned for this record, including malformed or plain text. Emitted gateway arrivals show their own request record. Derived gateway requests use INFO but show their source response record here, which can contain WARN or ERROR. Any AWS-safe projection is labeled and is not the original raw text.",
    "technical": "Raw line endings and spacing are preserved. Wrapping only changes display."
  },
  "logs.wrap": {
    "title": "Wrap long lines",
    "body": "Toggle visual line wrapping in the active payload. Unwrapped long lines can be scrolled horizontally. Neither mode rewrites the record or its copied text.",
    "technical": ""
  },
  "logs.copy": {
    "title": "Copy selected format",
    "body": "Copy the complete normalized JSON or exact source text after an explicit click, regardless of collapsed fields or search results. Native clipboard access is tried first, then a compatible browser copy command. If both fail, Manual copy text exposes the complete payload: choose Select copy text, then Ctrl/Cmd+C or your touch Copy command. Platform/manual copying may normalize line endings. Success appears only after an accepted programmatic write.",
    "technical": "Logs can contain sensitive sandbox values. Handle copied text with the same care as exports."
  },
  "logs.explorer": {
    "title": "Explore recorded fields",
    "body": "Expand objects and arrays, read paths and value types, or choose Explore object to make a nested object the root. More fields loads the next 40 children. Read value shows the complete selected value. Reset field tree returns to the full record.",
    "technical": "At most 400 tree rows and 12 nested levels render at once. Collapse a branch or continue at an object to reach deeper fields. Only selected detail is loaded; no payload is stored in browser storage."
  },
  "logs.field-search": {
    "title": "Search selected fields",
    "body": "Search literal field names and scalar values in this selected record, ignoring case. Search next batch continues after the displayed bounded batch; a partial batch does not claim the record has been fully searched. Empty search clears results.",
    "technical": "Each action visits at most 12,000 fields and shows at most 50 matches. This does not search retained logs or fetch token state."
  },
  "logs.copy-manual": {
    "title": "Select text for manual copying",
    "body": "Automatic copying was blocked. Select copy text selects the complete requested JSON, source projection or field value. Use Ctrl/Cmd+C or your touch Copy command. Selection alone does not confirm a clipboard write.",
    "technical": "This transient text is cleared on tab or record changes and is never stored. Textareas and native clipboard implementations may normalize CR/LF line endings. AWS source projections retain the original disclosure in the Raw text tab."
  },
  "logs.copy-value": {
    "title": "Copy complete field value",
    "body": "Copy the complete chosen value after an explicit click. Strings copy exactly without JSON quotes; null, booleans, numbers, objects and arrays copy as JSON. The preview never limits the copied value. The same native and compatible copy fallback is used as Copy JSON. If automatic copying fails, Manual copy text exposes the complete value; choose Select copy text and use your keyboard or touch Copy command. Platform/manual copying may normalize line endings.",
    "technical": "Opaque tokens are exact recorded values. The issuance-time server record is historical evidence, not decoded claims or a current verdict. Decoding a recorded JWT does not verify its signature."
  },
  "logs.id": {
    "title": "Detail ID",
    "body": "This identifies the individual log entry, which is useful for distinguishing similar-looking rows. It is separate from a request's correlation ID, an import operation ID or a consent ID. Browser marks and selection refer to the individual entry.",
    "technical": ""
  },
  "logs.flow-id": {
    "title": "Flow ID",
    "body": "The recorded workflow identifier may span several requests and traces. A dash or Not recorded means no flow ID is available; grouping never creates one. The compact table value opens the full ID for selection or copying. Use exact flow inspection to find recorded matches across roles.",
    "technical": "Shared IDs do not establish complete workflow coverage or causality."
  },
  "logs.payload": {
    "title": "Complete normalized JSON",
    "body": "This is the complete normalized selected record, including event metadata and recorded request, response or diagnostic details. The JSON tab opens first with nested objects and arrays expanded. Specialized views and field search do not limit this JSON. Sandbox logs intentionally retain full non-AWS values, so read and share the contents with that in mind.",
    "technical": "The viewer displays data; it must not execute HTML or scripts found in recorded values."
  },
  "logs.empty": {
    "title": "Loading / empty / cleared log display",
    "body": "This area has not displayed any entries in the current view yet. Loading, filtering, a cleared log store or a retrieval problem can produce different empty-looking results. Check any visible status message and Diagnostics settings before concluding that no service activity occurred.",
    "technical": ""
  },
  "service-logs.pause": {
    "title": "Pause service logs",
    "body": "Stop automatic checks in this service-only viewer. The service keeps writing logs. Clear the checkbox to check again.",
    "technical": "This separate legacy viewer has no central catch-up checkpoints or following-state indicator."
  },
  "service-logs.page": {
    "title": "Doctor App Logs / service log heading",
    "body": "This view shows events returned by this one service's log endpoint. Use the central viewer when you need to follow the same action across PCM, gateways and other sources. An empty local view does not prove that those other components have no logs.",
    "technical": ""
  },
  "service-logs.central": {
    "title": "Open central Logs",
    "body": "Open the configured central viewer with this service role selected. Local records alone cannot establish a complete journey or source coverage.",
    "technical": "The legacy DS template remains unserved."
  },
  "service-logs.refresh": {
    "title": "Refresh local logs",
    "body": "Check this service’s current log endpoint. Pause updates also pauses this check; clear Pause updates to read again.",
    "technical": "Does not query central retained history."
  },
  "service-logs.tools": {
    "title": "Local log tools",
    "body": "Open local copy and central-tool guidance without changing selection or reading logs.",
    "technical": ""
  },
  "service-logs.close-tools": {
    "title": "Close tools",
    "body": "Close local tools and return keyboard focus to Tools. The selected event stays available.",
    "technical": ""
  },
  "service-logs.copy": {
    "title": "Copy selected JSON",
    "body": "Copy the complete selected local record on explicit activation. Select an event first; if automatic copying is blocked, use the labelled manual text field.",
    "technical": "No record is stored in browser preferences."
  },
  "diagnostics.download": {
    "title": "Download all logs JSON",
    "body": "Open the complete available log export for deeper inspection, including oversized records skipped by bounded browsing. The export covers the configured logs rather than only the rows matching your current filters. It can contain full non-AWS credentials, identifiers and payloads.",
    "technical": "Current filters and the page cursor do not restrict this export."
  },
  "logs.page-status": {
    "title": "Bounded log page",
    "body": "Browse/live requests read at most 1 MiB and return at most 200 summaries. Explicit retained searches instead use bounded jobs with byte/file progress, up to 1,000 matches and 200-result pages. Tools → Viewer diagnostics lists reader budgets, cache and polling state. Coverage lists loaded evidence, source availability, filters, limitations and exact investigation actions. The main bar keeps state, active filters and actionable warnings.",
    "technical": "Oversized lines remain in the authenticated full JSON export."
  },
  "logs.older": {
    "title": "Automatic log history",
    "body": "Scroll in either direction to load adjacent or previously evicted pages from the same snapshot with the same filters. At most three pages stay rendered; the opposite offscreen page is released. Empty filtered pages continue automatically, and selected details remain available. Reaching the true newest edge catches up every intervening page before following, including with Event detail open.",
    "technical": "Scroll retries a failed continuation. Jump to latest starts fresh after clearing or rotation. Loading and errors appear in the top status line."
  },
  "logs.latest": {
    "title": "Jump to latest",
    "body": "Return to the accepted live head, then load every intervening bounded page before following. New events arriving during that drain are read in the next finite interval. Selected details remain available. Failures retain the checkpoint; use Jump to retry and read Coverage for the reason. The persistent state indicator reports when catch-up finishes.",
    "technical": "This is an action, not the following-state indicator."
  },
  "logs.role-pcm": {
    "title": "PCM Core",
    "body": "PCM owns Consent lifecycle decisions, OAuth tokens, discovery and source authorization.",
    "technical": ""
  },
  "logs.role-doctor": {
    "title": "Doctor / Service Provider",
    "body": "The Doctor app simulates a requesting Service Provider. It submits Consents, obtains tokens and retrieves clinical data.",
    "technical": "This is the requester, not a Data Source."
  },
  "logs.role-gateway": {
    "title": "Source gateway",
    "body": "This gateway accepts source requests and forwards them through its authorization adapter to the source FHIR service.",
    "technical": "The named HO or legacy source remains isolated."
  },
  "logs.role-adapter": {
    "title": "Source authorization adapter",
    "body": "The adapter checks source tokens and effective simulation controls before forwarding to the private FHIR server.",
    "technical": ""
  },
  "logs.role-hapi-runtime": {
    "title": "Native HAPI runtime",
    "body": "Actual request, permission and selected native warning/error observations for this HO. Default summaries remain visible with Diagnostics off.",
    "technical": "Missing terminals, disabled detail, retention and drops leave explicit gaps. Private detail collection expires independently of Diagnostics display."
  },
  "logs.role-hapi": {
    "title": "Private HAPI import diagnostics",
    "body": "This separate legacy source covers private import requests, completion and errors for this HO. Native request and permission observations use the HAPI runtime role.",
    "technical": "Use the HAPI runtime source for general server events."
  },
  "logs.role-fhir": {
    "title": "Legacy Node FHIR",
    "body": "The compatibility Data Source supplies the retained small mock responses.",
    "technical": "It is not a managed HAPI server or strict target."
  },
  "logs.level-info": {
    "title": "INFO",
    "body": "An informational event. Derived gateway requests use INFO even when the later response warns or fails. It does not itself prove operation success.",
    "technical": "Inspect the response's severity and outcome separately."
  },
  "logs.level-warn": {
    "title": "WARN",
    "body": "A warning or recoverable unexpected condition. Read the message and payload to understand its effect.",
    "technical": ""
  },
  "logs.level-error": {
    "title": "ERROR",
    "body": "An operation or request encountered an error. Inspect the correlated diagnostics for the cause.",
    "technical": ""
  },
  "logs.level-debug": {
    "title": "DEBUG",
    "body": "Detailed diagnostic output intended to help inspect execution.",
    "technical": ""
  },
  "logs.level-trace": {
    "title": "TRACE",
    "body": "Fine-grained execution diagnostics.",
    "technical": ""
  },
  "logs.level-fatal": {
    "title": "FATAL",
    "body": "A severe process or service failure.",
    "technical": ""
  },
  "logs.level-unknown": {
    "title": "Unrecognized severity",
    "body": "The record has missing or unrecognized severity. Inspect its original payload; unknown does not itself mean an error.",
    "technical": ""
  },
  "logs.class-system": {
    "title": "System activity",
    "body": "A protocol request, response, token or clinical workflow event.",
    "technical": ""
  },
  "logs.class-security": {
    "title": "Security checks",
    "body": "An authentication or authorization check. Classification alone does not identify success or failure.",
    "technical": ""
  },
  "logs.class-harness": {
    "title": "Harness activity",
    "body": "An action from the local demonstration or qualification harness.",
    "technical": "Diagnostic visibility can hide these rows by default."
  },
  "logs.class-lifecycle": {
    "title": "Process lifecycle",
    "body": "Startup, shutdown or other process lifecycle activity.",
    "technical": ""
  },
  "logs.class-admin": {
    "title": "Administration",
    "body": "An operator page or administrative action.",
    "technical": ""
  },
  "logs.class-noise": {
    "title": "Background activity",
    "body": "Polling, health or other background traffic classified separately from the clinical flow.",
    "technical": ""
  },
  "logs.class-uncategorized": {
    "title": "Uncategorized",
    "body": "The record has no recognized classification. This is not itself an error.",
    "technical": "Severity and payload describe the actual outcome."
  },
  "doctor.identity-primary": {
    "title": "Primary requesting application",
    "body": "Use the primary registered application and its configured credentials. This selects the requester; choose the Patient and Data source separately.",
    "technical": "Transport and assertion-signing roles follow the current registration. A shared key pair or a particular signing algorithm is not assumed."
  },
  "doctor.identity-secondary": {
    "title": "Secondary requesting application",
    "body": "Use this separately registered application and its configured credentials. Its connected services and Consent requests belong to its own organization.",
    "technical": "PCM checks requester ownership and the registered transport and assertion-signing roles. Selecting this application does not select a Patient or Data source."
  },
  "consent.test-exception": {
    "title": "Automatic approval for two special test patients",
    "body": "Automatic approval applies only to IDs 1 and 2 with the special HDP test identifier type. An ID of 1 or 2 under another identifier type does not qualify.",
    "technical": "Exact identifier type: http://fhir.health.gov.il/identifier/il-hdp-test-id. Automatic approval does not represent a patient decision."
  },
  "consent.test-approved": {
    "title": "Originally approved automatically for testing",
    "body": "No patient approval decision was recorded. This historical marker does not establish the current consent status; expiry or cancellation may have followed.",
    "technical": "Applies only to the exact special test identifier and retained test approval marker."
  },
  "consent.relaxed-access": {
    "title": "Required Consent approval",
    "body": "Every preset requires current Consent authority for ordinary clinical access. Legacy bypass settings are rejected.",
    "technical": "Separate normative Contract workflows retain their own authorization."
  },
  "admin.endpoint-doctor": {
    "title": "Doctor’s Portal",
    "body": "Open the Service Provider demonstration app to submit Consent requests, discover approved sources and retrieve data.",
    "technical": "This is an application link, not a FHIR API base."
  },
  "admin.endpoint-pcm-ui": {
    "title": "PCM console / Admin",
    "body": "The console reviews stored Consent requests and provides local administration and diagnostics.",
    "technical": "Separate from public normative OAuth/FHIR listeners."
  },
  "admin.endpoint-pcm-api": {
    "title": "PCM OAuth / FHIR API",
    "body": "This base serves token and FHIR management interactions; its capability link describes supported FHIR resources and operations.",
    "technical": "A trusted client certificate is required when the effective transport policy enables mTLS."
  },
  "admin.endpoint-metadata": {
    "title": "OAuth authorization metadata",
    "body": "This diagnostic URL describes issuer, token and authorization endpoints.",
    "technical": "It is metadata, not the clinical FHIR resource base. Client certificates may be required."
  },
  "admin.endpoint-gateway": {
    "title": "Data Source gateway",
    "body": "The FHIR base accepts clinical requests for the named source. Its health link is a transport/readiness diagnostic.",
    "technical": "Health is not clinical authorization or a conformance verdict; a client certificate may be required."
  },
  "admin.endpoint-adapter": {
    "title": "Private source adapter",
    "body": "The container-only adapter checks source authorization before forwarding requests to FHIR.",
    "technical": "This address is not browser-routable from the host."
  },
  "admin.endpoint-hapi": {
    "title": "Private HAPI FHIR",
    "body": "This container-only FHIR service stores the named HO’s resources and accepts private managed import operations.",
    "technical": "Public clinical access travels through the HO gateway and adapter."
  },
  "admin.endpoint-private": {
    "title": "Internal service address",
    "body": "This base is used by containers on the team network. It is not a browser application link.",
    "technical": "The row identifies its specific service and configuration origin."
  },
  "logs.controls": {
    "title": "Log controls",
    "body": "Use Tools for local row marks, spacers, the authenticated full export and clearing built-in logs. Filters, Diagnostics and source coverage have their own workbench sections. Close the workbench to reclaim the table width.",
    "technical": "Escape closes the focused sidebar or Event detail and returns focus to its trigger. The other pane stays open."
  },
  "workflow.sso": {
    "title": "Local trusted SSO simulation",
    "body": "This explicit sandbox path uses configured fabricated provider facts. A validated SSO result does not repeat OTP.",
    "technical": "One-use provider results bind browser, registered discovery client and expiry. No live GovID or registry is connected."
  },
  "workflow.fixture": {
    "title": "HTEST lookup fixture simulation",
    "body": "HTEST 1 and 2 exercise separately enrolled HMO lookup, local OTP and discovery. They never establish person login or Consent approval authority.",
    "technical": "Ordinary login rejects synthetic identifiers. The server separately enrolls and labels each test fixture."
  },
  "workflow.start": {
    "title": "Test patient sign-in and dependents",
    "body": "Choose a registered HMO, enter a test identifier and date of birth, then verify the local code before finding dependents. This is a local simulation, separate from clinical Consent.",
    "technical": "No SMS, email or national identity provider is connected. Backend calls keep their registered workflow credentials."
  },
  "workflow.identity": {
    "title": "Patient identifier",
    "body": "Enter the complete identifier and keep leading zeros. Surrounding pasted spaces are removed using the same parser as Doctor. Choosing or entering an identifier is not authentication or proof that a source has records.",
    "technical": "Advanced input accepts a full system\\|value token; supported types and national-ID check digits are validated server-side."
  },
  "workflow.dob": {
    "title": "Full date of birth",
    "body": "Enter the complete date recorded for this patient at the selected HMO. The source must return one exact identifier and date match with a current designated code contact before a code can be verified.",
    "technical": "Partial or invalid dates are rejected. Source demographics are not shown before verification."
  },
  "workflow.otp": {
    "title": "Six-digit code",
    "body": "Enter this sign-in’s current six-digit local code. Incorrect attempts use a limited budget. A new code replaces the previous one, and expired or already used codes cannot verify the patient.",
    "technical": "The server checks the browser binding and expiry on every attempt."
  },
  "workflow.presence": {
    "title": "Where does this patient have records?",
    "body": "Check record locations separately from dependent relationships. Each patient needs independent source-list eligibility, including dependents. Records found and no matching record are successful checks; an unavailable source stays unknown.",
    "technical": "Presence is not clinical Consent or permission to fetch records."
  },
  "workflow.evidence": {
    "title": "Relationship evidence",
    "body": "Review which HMO verified the relationship, the Patient and RelatedPerson records used and when the check completed. Only current active relationships allowed by policy qualify.",
    "technical": "An explicit selection refreshes relationship evidence before it is saved in this PCM flow."
  },
  "workflow.doctor": {
    "title": "Doctor",
    "body": "Open the separate requesting application. This test sign-in and selected dependent are not transferred to Doctor, and PCM workflow credentials remain server-side.",
    "technical": "The requesting application, verified test identity and selected dependent have separate purposes."
  },
  "workflow.consent": {
    "title": "Consents",
    "body": "Open the existing Consent dashboard on its UI listener. It remains available without completing this test sign-in. Authentication and discovery do not approve clinical Consent.",
    "technical": "Clinical approval and effective source access still follow their own rules."
  },
  "demo.service": {
    "title": "Clinical service",
    "body": "Choose a service connected to this application. Review its data, record history, maximum consent period and access mode before creating the request. Missing descriptive facts are labelled Not provided by PCM.",
    "technical": "Only current owned instance registrations with usable provider and definition prerequisites can start requests. Service settings are separate from approved record dates and token permissions; names never imply full access."
  },
  "demo.ceilings": {
    "title": "Intended query selection",
    "body": "Select finite patient resource types with r, s or rs. Search needs s; individual read-only r requires a known logical ID and is skipped by this preview. Public service categories suggest app operations, never exact approved permissions.",
    "technical": "PCM returns the whole saved approval independently of requested operations in this sandbox. Doctor validates the actual effective grant, supports filtered read/search grants and denies unsupported restrictions without dropping them."
  },
  "demo.patient-library": {
    "title": "Patient library",
    "body": "Open the shared ordinary demo and standard test choices, plus an optional bounded GUID sample. Use patient or Back to request preserves the requesting application, service and deliberate supported draft in this tab. Choosing fills the same patient entry without creating Consent or proving source records.",
    "technical": "Only exact standard test identifiers 1 and 2 auto-approve. GUID identities need Consent review and sampling is unavailable in Strict."
  },
  "demo.patient-views": {
    "title": "Patient lists",
    "body": "Demo & test patients are available offline. Source sample shows only the current loaded source candidates for this application. Switching lists keeps the visible filter and never loads a source.",
    "technical": "Cached candidates remain subject to the source, application and configuration generation."
  },
  "demo.patient-find": {
    "title": "Find in this list",
    "body": "Filter the current list by name or identifier. The same query stays when you switch lists. Clear filter shows all current choices again.",
    "technical": "This is a local filter over displayed choices, not a source search or patient inventory."
  },
  "demo.patient-details": {
    "title": "Patient details",
    "body": "Inspect the name, supplied birth date and source for a sampled patient, with the exact System URI and full system\\|value identifier. Partial dates retain their supplied precision; missing dates say Not provided. Use patient fills this exact pair on the request.",
    "technical": "Opening details never loads data, creates Consent or approves access. Replacing the sample removes its old details."
  },
  "demo.patient-source": {
    "title": "Managed sample source",
    "body": "Choose the managed source for the next bounded sample. Changing it clears the previous candidates and cancels an unfinished refresh.",
    "technical": "An eligible registered source does not establish that patient data is present."
  },
  "demo.patient-load": {
    "title": "Load or refresh sample",
    "body": "Your application obtains an ordinary PCM token for its sandbox Contract and directly requests one first page of up to ten marked synthetic GUID candidates. Refresh replaces the previous sample. A partial or empty result never triggers another scan.",
    "technical": "The two standard test choices remain available offline. Sampling is disabled in strict."
  },
  "demo.patient-cancel": {
    "title": "Cancel",
    "body": "Cancel the displayed refresh and clear its candidates. A late response cannot restore the discarded sample.",
    "technical": "This does not alter Consent or source clinical records."
  },
  "demo.patient-state": {
    "title": "Sample result",
    "body": "Read the source, candidate count and refresh time for this sample, or the reported empty, partial or failed result.",
    "technical": "Candidates are convenience choices; they confer no clinical access or source-presence evidence."
  },
  "demo.full-access": {
    "title": "Clinical grant policy",
    "body": "Every preset enforces the exact approved scope, Patient/source context and current authority. Broader sandbox access requires an explicitly chosen service or approval scope. Legacy Node clinical access is unavailable.",
    "technical": "No full-access flag, native all-off group or anonymous clinical fallback remains."
  },
  "demo.source-change": {
    "title": "Change data sources — sandbox simulation",
    "body": "Add or remove sources on this existing consent to test the application. Saving updates PCM without recording a new patient approval or confirming that any source holds data for this patient.",
    "technical": "Patient, service, approval dates, saved permissions and first-use windows stay the same. Empty selection saves zero sources. Strict excludes this action. New sources need exact-source tokens; removed grants fail fresh validation, with positive caches bounded to 30 seconds."
  },
  "admin.migration-checkpoint": {
    "title": "Freeze retained-team migration checkpoint",
    "body": "Freeze PCM configuration and policy state before stopping all team workers. The versioned CLI previews exact record identities, versions, changed/unchanged/rejected outcomes and measured five-component artifacts before explicit apply. Metadata preview uses --public-metadata and never prints private snapshots. Restart matching PCM, Doctor, adapter and HAPI artifacts and obtain fresh tokens. Later revocation, source removal or shortened validity blocks unsafe rollback.",
    "technical": "Online checkpoint is separate from preview. Stop PCM, Doctor/SP, adapters and import workers; wait 31 seconds for private tokens to expire. Preview never writes. Use the guarded migration CLI for recovery and rollback; the ordinary config/certificate backup and public FHIR export are insufficient. Preserve the private checkpoint and journal; ambiguous legacy authority stops for recovery without inference."
  },
  "common.diagnostics": {
    "title": "Synthetic local sandbox disclosure",
    "body": "Use fabricated data only. This sandbox deliberately retains full non-AWS diagnostics, including request and response payloads and local credentials. Keep logs and screenshots private.",
    "technical": "AWS credential isolation remains enabled in every profile."
  },
  "doctor.tools": {
    "title": "Tools",
    "body": "Open optional SMART application launch, Manual request testing or Reset Doctor state without moving the page. Opening or closing Tools makes no request. Escape, Close tools or clicking outside dismisses the panel.",
    "technical": "SMART is separate from HMO verification, clinical Consent and clinical retrieval. Reset confirms application-wide shared caches; it never deletes PCM Consent or clinical data."
  },
  "logs.columns": {
    "title": "Columns / Display",
    "body": "Choose visible table columns in the upper sidebar or mobile drawer. These choices change display only, preserving filters, selected detail, reading position and live-follow state. Flow ID and Trace ID are optional. Message stays visible so each event can still be identified and selected.",
    "technical": "Only validated column booleans are saved locally in this browser. Event IDs and payloads are never saved as display preferences. Unavailable reads use defaults; failed saves may restore earlier settings on reload."
  },
  "logs.column-required": {
    "title": "Message is required",
    "body": "Message stays visible to identify and select events when other columns are hidden. Use the other checkboxes to configure the table.",
    "technical": "This does not change event filters or the selected detail."
  },
  "logs.columns-reset": {
    "title": "Reset display columns",
    "body": "Restore Time, Component, Correlation ID, Level, Class and Message. Optional Flow ID and Trace ID return to hidden. Filters, selected detail, reading position and live-follow state are preserved.",
    "technical": "Saves only display booleans in this browser when storage is available."
  },
  "logs.column-id": {
    "title": "Complete recorded ID",
    "body": "Open a compact table ID to read its complete recorded value. Select the text or use Copy complete ID. Opening and closing this dialog preserves the selected event and reading position and makes no detail request.",
    "technical": "The value already exists in the bounded event summary. No ID is invented or persisted."
  },
  "logs.column-id-copy": {
    "title": "Copy complete ID",
    "body": "Copy the entire recorded ID, including characters hidden by the compact table label. Success is reported only after the browser accepts a write. If automatic copying is blocked, use Select copy text and your keyboard or touch Copy command.",
    "technical": "Uses the same native and compatible clipboard controller as full JSON, raw text and field value copying."
  },
  "logs.column-id-select": {
    "title": "Select complete ID text",
    "body": "Select the entire recorded ID, then use Ctrl/Cmd+C or your touch Copy command. Selection alone does not confirm a clipboard write.",
    "technical": "The full value stays in the dialog only, without persistent storage."
  },
  "logs.column-id-close": {
    "title": "Close complete ID",
    "body": "Close this ID dialog and return focus to its table button. Selected event, details and reading position stay in place. Escape also closes the dialog.",
    "technical": "Closing cancels pending copy feedback and clears the transient ID."
  },
  "logs.schema": {
    "title": "Schema version",
    "body": "The recorded event-envelope schema version. Legacy record means this source did not provide an event schema; the viewer still presents its available normalized fields.",
    "technical": "Normalization does not manufacture missing producer metadata."
  },
  "logs.event-name": {
    "title": "Event name",
    "body": "The recorded machine-readable event name, or the supported legacy type. Unspecified means neither was recorded. It describes activity, not its success.",
    "technical": "Read severity, message and payload for the observed outcome."
  },
  "logs.source-identity": {
    "title": "Source identity",
    "body": "The configured source identity and recorded role or organization identify where this event was read. This is separate from severity and classification.",
    "technical": "Configured inventory limits reads; producer claims cannot add a source."
  },
  "logs.source-component": {
    "title": "Source component ID",
    "body": "The exact registered component ID used to read the selected source. Unavailable means no component coordinate was returned for this record.",
    "technical": "Use Coverage for exact source filters and current source availability."
  },
  "logs.source-file": {
    "title": "Source file",
    "body": "The relative retained source file containing this record, when available. It can name current or rotated history.",
    "technical": "Retention, rotation or clear can make an earlier detail reference unavailable."
  },
  "logs.source-offset": {
    "title": "Source byte offset",
    "body": "The zero-based byte coordinate of the source line in that file. It is a source coordinate, not a row number, timestamp or global event sequence.",
    "technical": "Derived projections can share one source coordinate with their response record."
  },
  "logs.provenance": {
    "title": "Provenance",
    "body": "Emitted means a recorded source event. Derived means reconstructed evidence, such as a historical gateway request inferred from a completion. Imported means an adapted external record; unparsed means source text could not be parsed as JSON. Legacy / unspecified means no supported provenance was recorded.",
    "technical": "A derived request has no separately captured raw request; Raw text shows its source response. Provenance does not prove complete instrumentation."
  },
  "logs.derived-from": {
    "title": "Derived from",
    "body": "The recorded source reference used to reconstruct this event. It identifies evidence for the projection, not a newly observed request or a causal link.",
    "technical": "For historical gateway requests, timing can be estimated and Raw text is the source response."
  },
  "logs.parent-span-id": {
    "title": "Recorded parent span",
    "body": "The recorded parent identifies the preceding observed span in this trace. Not recorded means no parent was supplied or recorded. Inspect this trace to find retained matches; missing parents or children may be outside these results, expired, uninstrumented or unavailable.",
    "technical": "IDs describe observed causality, not authenticated caller identity or guaranteed complete delivery."
  },
  "logs.span-id": {
    "title": "Span ID",
    "body": "The recorded span identifier within a propagated trace. Not recorded means this source provided no span ID. A span and a request correlation ID describe different scopes.",
    "technical": "Missing spans or different traces cannot be joined into a complete trace by the viewer."
  },
  "logs.parse-status": {
    "title": "Parse status",
    "body": "A source parse problem was reported for this record. Inspect Raw text for the available source projection; readable neighboring records remain separate evidence.",
    "technical": "AWS-safe source projections and withheld unsafe malformed content remain labelled."
  },
  "logs.provenance-note": {
    "title": "Provenance note",
    "body": "The source projection records this additional provenance or derivation explanation. Read it with Provenance and Derived from to understand what was actually observed.",
    "technical": "The note cannot add missing raw records, IDs or instrumentation."
  },
  "pcm.details-title": {
    "title": "Consent details",
    "body": "Review the recorded consent and its current status. Pending requests can be approved or declined; existing approvals have separate sandbox controls.",
    "technical": "Viewing the record makes no decision."
  },
  "pcm.request-information": {
    "title": "Request information",
    "body": "These fields identify the requesting organization, requested service and patient. Check them together before making a decision.",
    "technical": ""
  },
  "pcm.approval-dates": {
    "title": "Approval dates",
    "body": "These dates bound the recorded approval. An elapsed end date means the approval period has ended, even if its stored status has not yet changed.",
    "technical": "Dates are displayed in UTC, with an explicit timezone."
  },
  "pcm.status-history": {
    "title": "Status-change history",
    "body": "Read the recorded reason, who changed the status and when, where that evidence is available. Expiry, provider cancellation and unknown causes remain distinct. A general record-update timestamp does not establish when approval or cancellation happened.",
    "technical": "Missing evidence remains unrecorded."
  },
  "pcm.grant-notice": {
    "title": "Sandbox data permissions",
    "body": "The selected approval owns one exact final scope. Every security preset enforces it together with Patient/source context and current authority. Different permissions require a new Consent approval.",
    "technical": "Source editing preserves the saved decision. Positive caches remain bounded by 30 seconds and earlier deadlines."
  },
  "pcm.admin-login": {
    "title": "Open Admin to log in",
    "body": "Open Admin in a new tab. Sign in if prompted, then return here and refresh the details.",
    "technical": "Admin login does not replace the requesting organization’s own authorization."
  },
  "pcm.refresh": {
    "title": "Refresh details",
    "body": "Reload the current consent details from PCM. Unsaved checkbox changes will be lost.",
    "technical": "Refreshing does not approve or restore the consent."
  },
  "pcm.cancel-disabled": {
    "title": "Cancellation unavailable",
    "body": "Read the reason beside the cancellation button. A terminal consent cannot be restored; an unavailable or unauthorized requesting organization cannot cancel it.",
    "technical": ""
  },
  "pcm.cancel-result": {
    "title": "Cancellation result",
    "body": "Read the recorded result or reason cancellation is unavailable. After an error, refresh the details to check the current state before trying again.",
    "technical": ""
  },
  "pcm.service-category": {
    "title": "Data category",
    "body": "A named group of clinical data in the selected permissions. Review exact permissions for the complete resource and code-system values.",
    "technical": ""
  },
  "pcm.service-history": {
    "title": "Record dates",
    "body": "A fixed record-date cutoff is shown as the saved date. It does not mean a rolling number of years before today.",
    "technical": "Service changes do not recalculate an existing approval’s dates."
  },
  "pcm.service-sensitivity": {
    "title": "Sensitive data",
    "body": "The selected permissions show which sensitive labels are excluded or required. Unknown filters remain available in the complete exact scope.",
    "technical": ""
  },
  "pcm.recorded-sources": {
    "title": "Recorded sources",
    "body": "These organizations are listed as data sources on this consent. Being listed does not confirm that a source is online or holds data for this patient.",
    "technical": ""
  },
  "pcm.saved-permissions": {
    "title": "Saved permissions",
    "body": "These permissions come from the saved approval. Later service changes and source edits do not replace them. Different permissions require a new Consent and approval.",
    "technical": "Missing or unsupported approval scope cannot authorize data. Public FHIR does not contain the private approval snapshot."
  },
  "pcm.permission-choice": {
    "title": "Permission choice",
    "body": "Shows whether the saved permissions came from the service default, a selected alternative or manual input.",
    "technical": "An unknown selection method is not inferred from matching scope text."
  },
  "pcm.source-history": {
    "title": "Source-change history",
    "body": "Shows the most recent recorded sandbox change to this consent’s source list. This change does not represent a new patient approval.",
    "technical": "Missing source names use the source ID. If no change history was recorded, no date or person is inferred."
  },
  "pcm.source-edit": {
    "title": "Source checkbox on an existing consent",
    "body": "Choose whether this source should remain on the consent. Your selection is saved only when you choose Save source changes.",
    "technical": "An already selected source can still be removed when it cannot currently be added."
  },
  "pcm.source-unavailable": {
    "title": "Source cannot currently be added",
    "body": "This source does not currently meet registration and operational prerequisites. An already selected source can still be removed.",
    "technical": "Selection eligibility does not establish online health or patient data presence."
  },
  "pcm.source-save": {
    "title": "Save source changes",
    "body": "Save the selected source list to PCM for this sandbox simulation. This changes the existing consent without recording a new patient approval.",
    "technical": "Requires Admin authentication, a current version and same-origin protection. A cached access decision may survive for up to 30 seconds."
  },
  "pcm.source-discard": {
    "title": "Discard unsaved changes",
    "body": "Restore the checkboxes to their values when this page loaded. Saved changes are unaffected.",
    "technical": ""
  },
  "pcm.source-unchanged": {
    "title": "No source changes to save",
    "body": "Change at least one source selection to enable saving.",
    "technical": "Clearing every checkbox saves an empty source list."
  },
  "pcm.source-saving": {
    "title": "Saving source changes",
    "body": "Wait for the current save to finish. Another save cannot start while it is in progress.",
    "technical": ""
  },
  "pcm.source-stale": {
    "title": "Refresh before saving",
    "body": "The displayed record or session is no longer current, or the saved outcome is uncertain. Refresh the details and review the source list before trying again.",
    "technical": ""
  },
  "pcm.source-result": {
    "title": "Source change result",
    "body": "Read the result before continuing. If the outcome is uncertain, refresh the details to inspect the saved sources.",
    "technical": "Changes are saved only after the server accepts the command."
  },
  "pcm.alternative-permissions": {
    "title": "Alternative permissions",
    "body": "Open the three sandbox alternatives: all records of the service resource types, recalculated service categories, or manual OAuth scope. Review the permissions preview before approving.",
    "technical": "Choosing an alternative may broaden access; it does not save a decision until approval."
  },
  "pcm.access-summary": {
    "title": "Data access summary",
    "body": "Review the data, allowed actions, fixed record dates and sensitive-data restrictions in the selected or saved scope. A limited summary points to complete exact permissions.",
    "technical": "This display does not validate the scope or confirm that a source holds records. Read means an individual record; search means a query."
  },
  "pcm.exact-permissions": {
    "title": "Exact permissions and identifiers",
    "body": "Inspect the complete OAuth scope, Consent ID, patient identifier type, service registration and requesting provider. These values are selectable for integration checks.",
    "technical": "Saved scope comes from the approval, independently of later service edits. Code systems remain in the exact scope."
  },
  "pcm.copy-value": {
    "title": "Copy exact value",
    "body": "Copy the complete displayed value. If clipboard access is unavailable, select the value and copy it manually.",
    "technical": "Copying changes no permissions or sources."
  },
  "pcm.approval-error": {
    "title": "Review was not saved",
    "body": "Read the error, inspect the current state and permissions, and submit only after reviewing again. A non-secret manual draft and source selection remain on this response.",
    "technical": "The fresh review is bound to the current Consent and service versions. Nothing is retried automatically."
  },
  "services.nav": {
    "title": "Services navigation",
    "body": "Open the protected Service catalog or Provider assignments. Catalog management uses Admin authority; ordinary assignments use the exact provider’s own API credentials.",
    "technical": "Admin login is required. Opening the screen changes no service and connects no provider."
  },
  "services.page": {
    "title": "Services",
    "body": "Manage shared definitions in Service catalog and provider connections in Provider assignments. New service opens a draft; templates are inside that form.",
    "technical": "Catalog inventory and lightly marked Admin actions use protected owners. Provider operations retain each provider’s own credentials and public authority."
  },
  "services.provider": {
    "title": "Provider",
    "body": "Ordinary actions use this exact registered provider’s own credentials. Inventory includes actual registered providers beyond the built-in roles.",
    "technical": "Credentials stay on the server. Missing credentials make ordinary actions unavailable; Admin privilege does not replace provider authority."
  },
  "services.load": {
    "title": "Refresh Services",
    "body": "Refresh the current catalog or assignment view while retaining the live creation draft. Failed loads preserve displayed results and their action locks.",
    "technical": "A successful explicit refresh supplies current version-bound actions; no mutation is automatically retried. Unloaded catalog pages remain incomplete."
  },
  "services.visibility": {
    "title": "Protected provider inventory",
    "body": "This Admin inventory shows provider pairs within named service groups, including pending, disabled and historical records omitted by ordinary discovery.",
    "technical": "Public FHIR visibility is unchanged. Browsing and Help obtain no provider tokens and make no lifecycle changes."
  },
  "services.list": {
    "title": "Provider assignments",
    "body": "Each named service group contains loaded provider assignments and eligible Connect actions. Saved state and any blocking reason appear together; this is no live network health check.",
    "technical": "Provider filtering changes loaded rows only. Group paging remains reachable; missing credentials and unknown or unloaded results never prove disconnection."
  },
  "services.filter": {
    "title": "Filter loaded assignments",
    "body": "Choose All providers or one provider, then narrow by service name or status. This changes visible loaded rows only; it never changes the provider credentials used by an action.",
    "technical": "Refresh retains these filters. Unloaded provider/service pages remain unknown; counts describe only loaded rows."
  },
  "services.row": {
    "title": "Connection details",
    "body": "Inspect this exact service, provider and registration in the current group. Stored lifecycle, version, source and exact FHIR remain visible and selectable.",
    "technical": "Inventory is protected Admin data. Ordinary lifecycle uses the named provider’s credentials; private activation and cleanup retain their Admin marking and Strict restrictions."
  },
  "services.name": {
    "title": "Service name",
    "body": "Use a short, recognizable name for the shared service definition. PCM requires a unique definition name.",
    "technical": "The server generates identifiers and managed status values."
  },
  "services.purpose": {
    "title": "Purpose",
    "body": "Explain why this service needs access to patient data. This description is part of its shared definition.",
    "technical": "Stored in HealthcareService.extraDetails."
  },
  "services.status": {
    "title": "Saved assignment state",
    "body": "Connected, Paused, Pending or Ended describes the stored assignment. Follow any blocking reason beside it; Connected alone does not establish usable access.",
    "technical": "Access still requires an eligible Consent, client and source with the exact approved scope enforced. This screen does not test network health or establish real patient approval."
  },
  "services.create": {
    "title": "Create service",
    "body": "Save one shared pending definition with no provider connections. Public service facts and protected exact authoring remain with their existing owners. Approve the definition, then explicitly connect providers.",
    "technical": "Admin authentication, current revision and CSRF are required. Strict refuses private creation. Refresh and inspect an uncertain result before retrying; Help cannot replay it."
  },
  "services.category": {
    "title": "Service classification",
    "body": "Hospital (35) is the fixed service classification. A data category such as Laboratory tests selects clinical record types; it does not change that classification.",
    "technical": "The required category and information-access type remain on the registration. Additional classification authoring is outside this basic form."
  },
  "services.master-data": {
    "title": "Include master data — read only",
    "body": "In Generated mode, include Organization, Practitioner, PractitionerRole and Location reads by known logical ID, including records outside the Patient compartment. Master search, history, writes and included results are unavailable through this grant. In Manual mode this disabled setting adds no permissions.",
    "technical": "New blank and template drafts start with this generator group on; later opt-out is retained. Only the exact final scope supplies authority. Consent, source, audience, expiry and confidentiality checks still apply; absent metadata stays off for legacy services."
  },
  "services.confidentiality": {
    "title": "Restricted policy",
    "body": "For generated scopes, deliberately enable Restricted (R) while Very Restricted (V) remains excluded. Sensitive-category choices are separate. In manual mode the exact scope supplies its own predicates; this checkbox does not silently add filters.",
    "technical": "Generated defaults use an explicit allowRestricted boolean. Ordinary finite alternatives explicitly exclude V. Exact sandbox patient/*.rs includes R and V without scope predicates."
  },
  "services.mode": {
    "title": "Access mode",
    "body": "Ongoing access lasts within the approved period. One-time access opens a one-hour window for each authenticated client and source on first qualifying use. Issuing a token does not start it.",
    "technical": "Reissuing tokens, rotating credentials for the same client or readding a source cannot restart that window. Consent validity and clinical-history dates are separate."
  },
  "services.duration": {
    "title": "Maximum consent period",
    "body": "Set the maximum duration a Consent for this service may have. Use a whole number and a supported time unit.",
    "technical": "For example, six months of consent can cover records from the past two years. This does not approve or extend a Consent; one-time usage and token expiry can end access sooner. Clinical-history filters are separate."
  },
  "services.patient-changes": {
    "title": "Let patients choose data categories",
    "body": "Record whether the service allows a patient category choice. This is a saved preference; the current Consent screen has no separate category editor. It grants no permission by itself.",
    "technical": "The current Consent profile does not capture a separate bucket subset. Approval freezes the selected complete scope."
  },
  "services.permissions": {
    "title": "Service data permissions",
    "body": "In Generated mode, categories, history, sensitivity and action settings determine the final scope. In Manual mode these controls are disabled and the exact text determines access. Review the scope before saving.",
    "technical": "Replacing manual text requires an explicit settings review and confirmation. Creation stores exact text and provenance. Every preset enforces the approved grant and Patient/source context."
  },
  "services.scope-mode": {
    "title": "Manual or Generated scope",
    "body": "Generated from settings uses the active controls and shows a read-only final preview. Manual scope uses only the exact editable text; disabled settings do not add permissions or limits. Switch to settings-generated scope reviews the replacement before you confirm it.",
    "technical": "Basic patient data supplies an exact manual template scope. Its known unchanged text has a finite summary; edited manual text is not reverse-parsed. Changing modes creates no service or Consent."
  },
  "services.data-category": {
    "title": "Data category",
    "body": "Select a category to show its history, sensitive categories and supported actions. Clearing it hides and disables those settings; selecting it again restores your draft choices.",
    "technical": "An unselected category is not submitted. Resource mappings and defaults are unchanged."
  },
  "services.history": {
    "title": "Include records from the past",
    "body": "Set how far back the generator starts at service creation. It converts that depth into a fixed lower date once. Newer eligible records remain included, so the lookback grows as the service ages. Zero starts at creation; it never means unlimited history.",
    "technical": "For example, two years at creation fixes a lower record date; a six-month Consent sets a separate access deadline. Service-default approval copies its saved dates. An explicitly selected generated approval can freeze new dates once. Manual dates stay literal. Issuance and introspection never refresh them."
  },
  "services.sensitivity": {
    "title": "Additional sensitive categories",
    "body": "By default no additional sensitive categories are allowed. Select those the generated service scope should allow. Their complete alternatives retain category, history and confidentiality predicates.",
    "technical": "In manual mode the exact final scope replaces generated predicates; these controls remain authoring metadata."
  },
  "services.actions": {
    "title": "Read and search actions",
    "body": "Read allows fetching an individual record. Search allows finding records of this data type. Patient read and search are always included. For other types, clear both to omit that type from the selected permission option.",
    "technical": "Only types mapped to the selected categories are offered. Generated consent choices remain available separately."
  },
  "services.scope": {
    "title": "Saved service default",
    "body": "Review the exact service scope and its generated or custom origin. This is the default offered at Consent approval. An explicit generated or manual approval choice can differ, including broader sandbox permissions.",
    "technical": "Approval atomically freezes exact scope and provenance; issued scope and active introspection retain it unchanged. Source edits change sources only. Different permissions require a new Consent; current eligibility, revocation and expiry remain separate."
  },
  "services.assign": {
    "title": "Connect provider",
    "body": "Connect requests a registration through this row’s exact provider credentials. It creates Pending; Activate is a separate Admin decision after catalog approval.",
    "technical": "Each provider requires a separate request and result. PCM supplies providedBy from authentication. Reconnect after End creates a new request and never restores old approvals. Missing credentials are unavailable."
  },
  "services.effect": {
    "title": "Effect on access",
    "body": "A shared definition affects all its providers. A registration affects one provider. Only eligible unexpired Consents can recover; terminal decisions stay terminal.",
    "technical": "New tokens are needed after changes. Cached positive decisions may last up to 30 seconds, capped by earlier deadlines. Clinical permissions stay enforced in every preset; only transport/assertion simulations may vary. Normative system Contracts have no HealthcareService dependency; their own lifecycle, source membership and client entitlement remain required. The labelled sandbox sampler keeps its separate Contract/service pair, with its own lifecycle, source and client restrictions."
  },
  "services.restart": {
    "title": "Restart and deletion",
    "body": "Uncheckpointed runtime changes are lost on restart/reset. An explicit retained checkpoint can preserve services and registrations. This screen does not rewrite seeds or delete patient data.",
    "technical": "Without a retained checkpoint, changes stay only in memory. Configured seeds may be recreated by bootstrap when no retained checkpoint restores the runtime. Runtime deletion does not edit seed/config files."
  },
  "services.disabled": {
    "title": "Action unavailable",
    "body": "Read the current state and reason beside the target. Pending records need activation; only a sandbox-disabled shared definition can be re-enabled. Terminal or independently frozen records cannot be revived.",
    "technical": "An instance also requires an operational provider and active shared definition for activation or enable. Delete requires an inactive unreferenced record."
  },
  "services.target": {
    "title": "Exact service target",
    "body": "Review the exact reference, version and provider context before acting. Shared definitions affect all providers; registrations affect one provider.",
    "technical": "Protected inventory and private authoring facts are Admin capabilities, separate from ordinary provider discovery."
  },
  "services.dependencies": {
    "title": "Deletion dependencies",
    "body": "Provider assignments must be removed before deleting their shared service. Configuration, protected built-in identities and Consent, Contract or saved approval history are separate restrictions; follow the recorded reason.",
    "technical": "History is preserved even for terminal records. No cascading cleanup or clinical deletion is performed. Disabling a service retains its references."
  },
  "services.activate": {
    "title": "Approve definition / Activate provider registration",
    "body": "Simulate initial approval of a pending definition or provider registration. A definition can be approved before any provider is connected. A registration first requires an active definition and operational provider.",
    "technical": "This is private sandbox administration, not real Ministry of Health approval. Does not change public FHIR lifecycle rules."
  },
  "services.enable": {
    "title": "Restore shared definition / provider registration",
    "body": "Restore a suspended registration or a shared definition disabled by this screen. Operational prerequisites must pass. Eligible unexpired approvals may be restored.",
    "technical": "Terminal decisions and independent freezes cannot be overridden. Old grants do not become valid again; request fresh tokens."
  },
  "services.disable": {
    "title": "Pause shared definition / provider registration",
    "body": "Temporarily block consent-based use of this active target. Disabling a shared definition affects all its registrations; disabling a registration affects that provider.",
    "technical": "Reconciles consents and invalidates authority generations. Cached decisions can remain usable for up to 30 seconds and earlier deadlines. Every preset requires current clinical authority."
  },
  "services.full-access": {
    "title": "Built-in patient read/search",
    "body": "Exact patient/*.rs includes Restricted (R) and Very Restricted (V) for all supported patient-context types, without category, sensitivity or history predicates. Consent, Patient/source, validity and current lifecycle still apply.",
    "technical": "Provisioning initializes each real provider once. Private pcm-provider-service-defaults/1 retains paused/disconnected choices through reconciliation and retained checkpoint restore. Global enable preserves choices. Ordinary reconnect creates Pending requiring separate activation; old approvals never revive. Organization/Practitioner/PractitionerRole/Location need explicit finite direct-read grants without master search. Uncheckpointed factory reset discards runtime choices."
  },
  "services.delete": {
    "title": "Delete from this runtime",
    "body": "Permanently remove one inactive ordinary service record after resolving all dependencies, including retained approval history. There is no undo. Built-in identities and configured seed records are protected. This differs from disabling or cancelling its lifecycle.",
    "technical": "No cascade, clinical deletion, provider deletion or seed rewrite. Repeated or stale commands fail and require review. Uncheckpointed runtime changes are lost on restart/reset; an explicit retained checkpoint can preserve them."
  },
  "services.result": {
    "title": "Save result and recovery",
    "body": "Authoring fields are locked while saving. A successful receipt describes the submitted definition; a failed or uncertain result retains the draft for review and a deliberate retry after Refresh.",
    "technical": "Successful, stale or uncertain saves remain locked until successful inspection. Validation failures retain a deliberate retry. Explain remains usable during saving. Starting-point replacement still asks before discarding unsaved edits."
  },
  "services.paging": {
    "title": "Service and provider pages",
    "body": "Continue by service, then load provider pages within the named service group. Complete, partial and unknown states describe the loaded snapshot explicitly.",
    "technical": "Continuations are revision-bound; a stale page requires Refresh. Unloaded pairs are unknown, never Not connected. No guessed totals or automatic provider enrollment."
  },
  "services.technical": {
    "title": "Technical service details",
    "body": "Inspect the exact resource and identifiers from the source labelled in this panel. Protected Admin inventory is distinct from ordinary provider API discovery.",
    "technical": "No private key, certificate or access token is included."
  },
  "admin.source-institution": {
    "title": "Institution type",
    "body": "Classify this registered source as HMO, Hospital or Other. This is independent of its hosting, certificates and clinical records. PCM test workflows use HMO sources subject to current Organization, Endpoint and Contract readiness; classification alone does not prove a patient exists or grant Consent.",
    "technical": "Existing built-in ho-a/ho-b/ho-c default to HMO; unclassified custom and legacy sources default to Other."
  },
  "admin.source-institution-save": {
    "title": "Save institution type / saved feedback",
    "body": "Save only this source's institution classification. Refresh and review if another configuration change made this form stale. Endpoints, credentials, patient data and clinical Consent source choices are preserved.",
    "technical": "Uses authenticated Admin configuration publication and a new revision."
  },
  "workflow.notice": {
    "title": "Local test environment",
    "body": "Codes are displayed here for disposable testing. No SMS or email is sent, and this page does not establish production identity assurance.",
    "technical": ""
  },
  "workflow.progress": {
    "title": "Choose patient, verify code, find dependents",
    "body": "First choose a source and enter a test identity. Next verify the current local code. Only then can you check eligible dependent relationships.",
    "technical": "Each stage uses the current private browser-bound flow."
  },
  "workflow.stage": {
    "title": "Current sign-in stage",
    "body": "This status shows the current server-owned stage. Waiting for a code is not a verified patient. Verification lasts only until the displayed deadline.",
    "technical": "Refreshing the canonical page does not resend a code."
  },
  "workflow.busy": {
    "title": "Sign-in step in progress",
    "body": "Wait for the current request to finish. The browser keeps the submitted patient, current code or selected action; reloading does not extend any deadline.",
    "technical": "The server validates each step and its original settings."
  },
  "workflow.error": {
    "title": "Action needs attention",
    "body": "Read the recovery message and review the named field or current stage. Correct input, retry an unavailable check or start again when the sign-in has expired.",
    "technical": "Patient recovery stays on this page; technical diagnostics remain with the sandbox operator."
  },
  "workflow.technical": {
    "title": "Optional test details",
    "body": "Open the recorded technical details when investigating this test. They help correlate the current flow or identity type without changing permissions.",
    "technical": "Trace IDs are diagnostics, not authorization handles."
  },
  "workflow.hmo": {
    "title": "Home HMO for this test",
    "body": "Choose one registered HMO to check this identifier, date of birth and current code contact. This is a declared test target, not proof of real HMO membership. Dependents are checked separately at eligible registered HMOs.",
    "technical": "Source registration, institution classification, current Organization/Endpoint and workflow Contracts remain authoritative."
  },
  "workflow.hmo-choice": {
    "title": "Registered HMO choice",
    "body": "Select the named HMO for this test lookup. An unavailable choice needs Admin review of source or workflow readiness. Registration does not prove that this HMO contains the patient.",
    "technical": "The submitted value is a stable source Organization identity; the browser cannot provide a destination URL."
  },
  "workflow.no-hmo": {
    "title": "No HMO ready for a test lookup",
    "body": "No registered HMO currently meets the source and workflow prerequisites. Ask the sandbox operator to make an HMO available, then reload this page. Loading matching test data is a separate operator step.",
    "technical": "Hospital and Other sources remain valid clinical Consent choices."
  },
  "workflow.picker": {
    "title": "Configured test identifier",
    "body": "Optionally fill the editable identifier fields from the team’s configured test identifiers. You can enter another identifier without loading a patient inventory.",
    "technical": "A configured choice is not membership, source presence or authentication evidence."
  },
  "workflow.picker-empty": {
    "title": "Enter another identifier",
    "body": "No configured choice is required. Select the identifier type and enter the patient identifier and date of birth manually. No pre-login patient inventory is requested.",
    "technical": "Explicit HTEST fixtures have their own separately labelled flow."
  },
  "workflow.picker-choice": {
    "title": "Configured identifier choice",
    "body": "Copy this configured test identifier into the editable fields. Check the HMO and date of birth before continuing.",
    "technical": "This choice supplies input only; it grants no authority."
  },
  "workflow.identity-type": {
    "title": "Identifier type",
    "body": "Choose the kind of identifier you are entering. Israeli and Palestinian national IDs are supported. Foreign passports need trusted eligibility facts; Israeli nationals use their national ID.",
    "technical": "Exact system URIs are shown only in Identifier details."
  },
  "workflow.type-national": {
    "title": "National identifier",
    "body": "Use the selected national identifier type and keep leading zeros. The source must match the complete identifier and date of birth.",
    "technical": "Israeli national IDs require a valid nine-digit check digit. Selecting a type proves no identity."
  },
  "workflow.type-passport": {
    "title": "Foreign passport identifier",
    "body": "Use a passport issued by the displayed country only when trusted eligibility facts allow it. Israeli nationals with a national ID must use that ID instead.",
    "technical": "Eligibility comes from configured server facts, not a checkbox or browser claim."
  },
  "workflow.identity-details": {
    "title": "Identifier details",
    "body": "Open the exact identifier system for technical investigation. Everyday entry uses the readable type selector and identifier field.",
    "technical": "A full system\\|value token is accepted by the shared server parser."
  },
  "workflow.send": {
    "title": "Check HMO and start code verification",
    "body": "Check only the selected HMO for one matching patient, date of birth and current designated code contact. Success opens the verification step; it does not sign in the patient yet.",
    "technical": "The code stays in the local test transport and is shown only by an explicit action."
  },
  "workflow.otp-status": {
    "title": "Code status and attempts",
    "body": "Check the code’s actual expiry and remaining attempts. Earlier codes stop working when a new one is requested. Source demographics stay hidden until verification succeeds.",
    "technical": "Displayed times use UTC; the server enforces expiry and attempts independently of browser timers."
  },
  "workflow.verify": {
    "title": "Verify code",
    "body": "Verify the current six-digit code for this browser’s pending sign-in. Success verifies the test identity until its displayed deadline.",
    "technical": "No clinical Consent or dependent authorization is created."
  },
  "workflow.code-expired": {
    "title": "Code expired",
    "body": "This code expired and can no longer be verified. Request a new code if available, or end this test and start again.",
    "technical": "Changing a browser timer cannot extend server-side validity."
  },
  "workflow.resend": {
    "title": "Request a new code",
    "body": "Replace the current code after the required wait. Earlier codes immediately stop working. Failed verification attempts remain counted.",
    "technical": "The server limits both the wait and the total number of replacements."
  },
  "workflow.resend-wait": {
    "title": "New code temporarily unavailable",
    "body": "Wait until the displayed time before requesting another code. If the replacement limit is reached, end this sign-in and start again.",
    "technical": "The control updates as time passes; the server remains authoritative."
  },
  "workflow.show": {
    "title": "Show local code",
    "body": "Display this browser’s current local test code. No message was sent. This does not verify the patient or send another code.",
    "technical": "Only a current pending delivery is shown; expired, cancelled or used codes are unavailable."
  },
  "workflow.verified": {
    "title": "Verified test patient",
    "body": "This browser completed the local code or explicitly configured SSO check for the displayed test identity. Its verification lasts only until the recorded deadline.",
    "technical": "A verified representative does not automatically have clinical authority for dependents."
  },
  "workflow.expiry": {
    "title": "Sign-in expiry",
    "body": "This is the server’s deadline for using the current verified test identity. When it expires, choose a patient and verify again.",
    "technical": "Source tokens may have a shorter independent lifetime."
  },
  "workflow.discover": {
    "title": "Find or refresh dependents",
    "body": "Check eligible registered HMOs for current active relationships allowed by policy. Each source is checked independently. Refresh clears the prior selected dependent before new results arrive.",
    "technical": "Independent pages, time limits and source tokens preserve partial and unknown outcomes."
  },
  "workflow.source-result": {
    "title": "HMO check result",
    "body": "A completed check exhausted that HMO’s prescribed pages. Could not check means its result is unknown, not that no dependent exists. Review the last-check time and retry unavailable sources.",
    "technical": "Source readiness, trust, current policy and time budgets can prevent a completed check."
  },
  "workflow.empty": {
    "title": "No dependent confirmed",
    "body": "Completed checks found no currently eligible dependent. If any HMO is unknown, the results are incomplete; retry it before drawing a wider conclusion.",
    "technical": "Only relationships enabled by the team’s policy qualify."
  },
  "workflow.dependent": {
    "title": "Verified dependent result",
    "body": "This person matched an eligible active relationship at the listed HMO sources. Review the evidence before selecting them for this test.",
    "technical": "Conflicting identities or cross-source relationship joins are not silently combined."
  },
  "workflow.select": {
    "title": "Recheck relationship and select",
    "body": "Recheck current relationships before saving this dependent in the PCM test flow. A stale or no-longer-eligible relationship cannot be selected.",
    "technical": "This does not select the patient in Doctor, approve Consent or grant clinical access."
  },
  "workflow.selection": {
    "title": "Selection stays in this PCM test",
    "body": "The selected dependent is stored only in this browser-bound PCM test. Continue through the separately authorized clinical Consent workflow when testing clinical access.",
    "technical": "Discovery, presence and clinical Consent retain separate authority."
  },
  "workflow.presence-self": {
    "title": "Check my source presence",
    "body": "Check record locations for the verified test identity only. It must meet independent source-list eligibility. Unavailable checks remain unknown.",
    "technical": "The request is count-only and does not retrieve clinical records."
  },
  "workflow.presence-all": {
    "title": "Check presence for me and verified dependents",
    "body": "Refresh dependent relationships, then check record locations for the verified identity and current eligible dependents. Each person has separate source-list eligibility.",
    "technical": "A dependent relationship alone does not enroll the dependent for presence or clinical access."
  },
  "workflow.presence-result": {
    "title": "Record location result",
    "body": "Records found or no matching record found reflect a completed count-only check. Could not check remains unknown; previous knowledge is shown separately when available.",
    "technical": "The source and check time describe evidence, not a clinical access grant."
  },
  "workflow.clear": {
    "title": "End this test sign-in",
    "body": "End this sign-in and clear its selected dependent and pending code. Starting another test requires a fresh lookup and verification.",
    "technical": "Stored Consents, clinical data and retained source-presence observations are preserved."
  },
  "workflow.sso-choice": {
    "title": "Configured SSO choice",
    "body": "Choose an explicitly configured fabricated provider identity for the separate local SSO simulation. A validated one-use result skips the code step.",
    "technical": "The browser cannot supply its own successful SSO claim."
  },
  "workflow.fixture-choice": {
    "title": "HTEST fixture choice",
    "body": "Choose an explicitly enrolled HTEST lookup fixture. This tests the protocol without establishing a real person login or clinical approval authority.",
    "technical": "HTEST input is not accepted by the ordinary person sign-in form."
  },
  "workflow.attempts": {
    "title": "No code attempts remain",
    "body": "End this test sign-in and start again. Requesting another code does not reset the total attempt budget.",
    "technical": "The server enforces the budget independently of this disabled control."
  },
  "smart.canonical-start": {
    "title": "Open configured Doctor address",
    "body": "Restart the SMART test at the explicitly configured application address whose callback is registered. This starts a fresh request; it does not transfer an existing sign-in or approval between browser origins.",
    "technical": "Incoming Host or forwarded headers never add a callback registration."
  },
  "smart.hmo-signin": {
    "title": "Test sign-in through an HMO",
    "body": "Verify your own synthetic test identity using the existing PCM source-driven flow, then return to this same request. Sign-in does not approve the application or a dependent.",
    "technical": "The private continuation is browser bound and retains the original request deadline."
  },
  "smart.hmo-return": {
    "title": "Return to the pending SMART request",
    "body": "Return to the original application request for an explicit decision. Cancelling sign-in leaves this request pending until its original deadline.",
    "technical": "No code or clinical Consent is created by sign-in or return navigation."
  },
  "smart.application": {
    "title": "Requesting application",
    "body": "This is the registered name of the application requesting this test launch. Review it before authorizing.",
    "technical": "Client, exact callback and audience are available in technical details."
  },
  "smart.permissions": {
    "title": "Requested application permissions",
    "body": "Read the resource types and actions requested for this patient. All FHIR resource types means a broad wildcard, not a service-limited clinical grant.",
    "technical": "Exact scope strings and filters remain in Protocol testing."
  },
  "smart.technical": {
    "title": "Protocol testing and technical details",
    "body": "Inspect non-secret client, callback, audience, S256 method or granted scope. Optional narrowing and explicit protocol fixtures are testing tools.",
    "technical": "Verifier, authorization code, access token and client keys are never shown."
  },
  "smart.fixture": {
    "title": "Synthetic protocol fixtures",
    "body": "Choose an explicit configured synthetic identity for protocol testing without person verification. No fixture is selected automatically.",
    "technical": "This is separate from HMO verified self and does not establish clinical authority."
  },
  "smart.identity-required": {
    "title": "Test identity required",
    "body": "Verify your own test identity through an HMO, or choose an explicit synthetic protocol fixture in Protocol testing, before authorizing.",
    "technical": "Server checks remain authoritative if browser controls are changed."
  },
  "smart.busy": {
    "title": "Decision pending",
    "body": "This decision is being submitted. Wait for the registered Doctor return. Repeating it cannot approve twice.",
    "technical": "The original expiry and atomic single-use boundary remain unchanged."
  },
  "smart.error": {
    "title": "SMART test needs attention",
    "body": "Read the recovery message and start a fresh test on the configured Doctor address. An invalid request never gains an unsafe return redirect.",
    "technical": "Check exact registration, identity, expiry and requested scope with the operator."
  },
  "smart.restart": {
    "title": "Start a fresh SMART test",
    "body": "Start a separate request on the configured Doctor address. It has fresh state and PKCE and does not revive an expired or used request.",
    "technical": "The prior decision and clinical Consent are unchanged."
  },
  "smart.completion": {
    "title": "SMART test result",
    "body": "Success means only that the confidential code exchange completed. This test created no clinical Consent and performed no clinical data retrieval.",
    "technical": "The application token is not cached into Doctor clinical requests."
  },
  "services.templates": {
    "title": "Service starting point",
    "body": "Choose Blank or one of five maintained synthetic templates inside New service. Selection fills an editable draft and creates nothing. Replacing a dirty draft uses one ordinary confirmation.",
    "technical": "Keys are file metadata, never PCM resource identifiers. Template changes affect future drafts only; saved definitions and patient decisions remain unchanged."
  },
  "services.template-add": {
    "title": "Use starting point",
    "body": "Fill a draft from this template with patient category choice off, master-data generator settings on and resource read/search selected. Review the scope mode and edit the draft. Selection creates no resource, provider connection, Consent or token.",
    "technical": "Basic patient data starts with its exact manual scope and inactive generator settings. Other maintained templates start in Generated mode. The exact final scope remains authoritative."
  },
  "services.template-examples": {
    "title": "Illustrative bounded queries",
    "body": "Examples use enforced Patient context: Patient?_count=10 and clinical Type?_count=10 need no client patient identifier or repeated authorization dates. Read-only operations require a known record ID.",
    "technical": "The maintained file validates each operation against its read/search permission, qualified resource parameters and one _count from 1 to 100. Master Organization/Practitioner/PractitionerRole/Location examples are direct GET by ID only. Editable JSON is illustrative text, never executed or HTML; it is not a live link or OAuth scope. Empty or unsupported results do not justify broader fallback queries."
  },
  "services.template-reference": {
    "title": "Registration details for clients",
    "body": "Use this returned provider service reference and official business identifier when configuring the same provider's consumer. Keep credentials on its server.",
    "technical": "Doctor and another client cannot borrow a different provider's registration. A compatible scope alone is not source or consumer qualification."
  },
  "services.new": {
    "title": "New service draft",
    "body": "Open the dedicated Service details, Data access and Review form. Back / Cancel returns to results and keeps the draft in this tab. Blank and templates are inside the form.",
    "technical": "Replacing a dirty draft requires confirmation. Refresh retains the live draft; leaving or reloading the page ends it. No browser storage or server draft store is introduced."
  },
  "services.lifecycle": {
    "title": "Provider connection lifecycle",
    "body": "Withdraw request ends Pending. Pause and Resume are reversible ordinary provider actions. Disconnect is terminal; reconnect creates a new pending request and old approvals stay terminal.",
    "technical": "Active Disconnect uses Pause, checks its exact fresh version, then End. The two calls are not atomic: a failed or uncertain End may leave the registration paused. Inspect before retrying. Global catalog enable preserves individual pauses and disconnects. Resume requires fresh tokens; cached decisions may last up to 30 seconds."
  },
  "services.rules": {
    "title": "Authoring inputs",
    "body": "Review selected categories, original history depths, sensitive categories, R/V, master reads, duration and access mode. Generated scope applies those inputs. Manual text replaces the generated grant.",
    "technical": "Descriptive metadata does not secretly add predicates to a manual final override. Access duration is separate from clinical record dates."
  },
  "services.advanced": {
    "title": "Final service scope",
    "body": "Generated previews are read-only. Choose Edit exact scope manually to edit that text in Manual mode, with generator settings disabled. Whitespace, newlines, unusual filters and malformed experimental text are preserved exactly.",
    "technical": "Returning to Generated mode requires a replacement review and explicit confirmation. Name, purpose, period, focus, disclosures and Refresh preserve manual text. Syntax advice is advisory; saving manual text needs no compiler preview. Runtime validation still denies invalid or unsupported authority."
  },
  "services.reset-scopes": {
    "title": "Regenerate from settings",
    "body": "In Generated mode, regenerate the scope using the active settings. In Manual mode, use Switch to settings-generated scope and review the replacement before confirming. Keep manual scope cancels without changing text.",
    "technical": "Failed generation keeps visible text and invalidates the old save proof. Review the final text and creation/history anchor before saving. No provider connection, Consent or token is created."
  },
  "services.preview": {
    "title": "Final scope review",
    "body": "Generated text is saved exactly with its reviewed creation/history anchor. Fixed lower dates admit newer records without rolling at issuance. Manual text replaces the generator completely.",
    "technical": "Generated proofs bind the exact draft for 15 minutes. Failed or obsolete replies cannot establish a current proof. Manual syntax advice does not establish runtime applicability or source support and is never required to save bounded exact text. No patient or source probe occurs."
  },
  "services.copy-scope": {
    "title": "Copy final service scope",
    "body": "Copy the exact final service grant shown here, including literal dates. Patient identity is supplied by verified runtime context. If clipboard access is unavailable, select and copy the raw text.",
    "technical": "This filtered final value is separate from the unfiltered resource/action ceiling accepted by clinical token requests."
  },
  "doctor.services-refresh": {
    "title": "Refresh services",
    "body": "Read connected services again with this application’s credentials and recheck readiness. The patient draft is retained. Loading or failed refresh cannot establish a removed assignment.",
    "technical": "Refresh fences old access decisions and late responses. Failed refresh leaves the list stale and blocks creation until a successful refresh and review; current exact service reads still guard submission."
  },
  "doctor.services-manage": {
    "title": "Manage services in PCM",
    "body": "Open the separate PCM Services workspace with this provider context. Use Doctor Refresh after returning; PCM requires its existing Admin login.",
    "technical": "The destination preserves provider and configured browser navigation context, without credentials or tokens. Diagnostic applications have no provider fallback."
  },
  "doctor.services-pages": {
    "title": "Loaded service pages",
    "body": "Only loaded ordinary API pages are shown. Load more services follows the advertised next page for this requesting application. Absence from loaded pages does not establish deletion; Refresh status and sources resolves a stored Consent’s own service association.",
    "technical": "At most 20 pages, 100 requests and 2 MiB per list; request groups have a 15-second deadline. Invalid or foreign continuation stops with an incomplete state."
  },
  "doctor.services-empty": {
    "title": "Services unavailable or not loaded",
    "body": "No usable owned registration is established yet. Refresh or load more pages; check provider registration, credentials and activation in PCM. A diagnostic identity is unavailable for service choices. No other provider or default service is selected for you.",
    "technical": "Missing and hidden definitions stay unavailable. A transient failure is not deletion; existing Consent history stays visible."
  },
  "doctor.service-state": {
    "title": "Consent service and lifecycle",
    "body": "This Consent keeps its own patient, service association, saved permissions and PCM status even when the service leaves the picker. Unresolved or unusable service context blocks unsupported retrieval instead of guessing Observation permissions. Re-enabling requires current state and fresh valid grants; terminal Consents stay terminal.",
    "technical": "Exact ordinary reads can resolve off-page instances. Only five historical service associations are revalidated on a render; Refresh status and sources resolves another explicitly. Positive downstream caches may take up to 30 seconds. No clinical history store is added."
  },
  "doctor.services-return": {
    "title": "Return to Doctor",
    "body": "Return to Doctor with the currently selected provider. Refresh services there to read current registration readiness. This link carries provider context only; it grants no permission.",
    "technical": "The shared browser-navigation rule preserves Doctor’s destination listener and supported prefix, with no credentials or tokens."
  },
  "services.catalog": {
    "title": "Service catalog · Admin",
    "body": "One row per shared definition, including pending, disabled, ended and unassigned records. Global actions affect every provider of the definition.",
    "technical": "Protected owner inventory; it does not widen ordinary FHIR discovery. Other catalog pages may contain additional records."
  },
  "services.catalog-details": {
    "title": "Definition details",
    "body": "Inspect the exact saved version, final scope, origin and creation/history anchor beside the service’s actions. Generator buckets are not the effective manual scope.",
    "technical": "Public persisted FHIR facts and private Admin authoring facts are separately attributed. Existing Consent approvals remain immutable; saving or approving a definition issues no token."
  },
  "services.admin-provenance": {
    "title": "Admin provenance",
    "body": "These inventory facts and commands use the protected local Admin owner, not a provider’s standard discovery permissions.",
    "technical": "Commands are audited diagnostics and unavailable in Strict. The public FHIR resource remains caller-scoped through ordinary APIs."
  },
  "doctor.service-details": {
    "title": "Service details",
    "body": "Inspect the selected service’s resource/history, access and sensitive-data settings, exact identifiers and versions. Granted permissions are not yet obtained; opening these details does not fetch records or start access.",
    "technical": "Advisory app operations come from public service categories. Exact R/V, sensitive-data and date restrictions belong to the applicable token-response grant, not a reconstructed service scope."
  },
  "admin.area-overview": {
    "title": "Overview",
    "body": "Review exact configured addresses and separately recorded status. Refresh rereads saved configuration without issuing tokens or running clinical checks.",
    "technical": "Saved revision, component adoption and observed checks are different facts."
  },
  "admin.area-sources": {
    "title": "Sources & data",
    "body": "Open source registration, trust, managed data operations and legacy compatibility settings. Each form keeps its exact source or server target.",
    "technical": "External registration does not create a managed local import target."
  },
  "admin.area-security": {
    "title": "Security & access",
    "body": "Review the current preset, retained transport/assertion controls, token lifetime and optional own-token diagnostic capability.",
    "technical": "Required authorization and Patient/source context remain enforced."
  },
  "admin.area-apps": {
    "title": "Service providers & apps",
    "body": "Inspect configured provider/application identities and registered callbacks. Open Services for catalog and provider assignments, or Doctor for its application.",
    "technical": "This page does not register new applications or manage their credentials."
  },
  "admin.area-certificates": {
    "title": "Certificates",
    "body": "Compare current certificate fingerprints, intentionally export credentials or review controlled renewal.",
    "technical": "Protected credential exports include private keys. Reviewing renewal changes no credentials; managed listeners require controlled recreation."
  },
  "admin.area-logs": {
    "title": "Logs & diagnostics",
    "body": "Open the existing Logs application, protected full-history export, clear and explicit sanity checks.",
    "technical": "Browsing or Explain does not run a sanity check."
  },
  "admin.area-maintenance": {
    "title": "Maintenance",
    "body": "Back up or restore configuration and credentials, review migration status or reset PCM runtime state.",
    "technical": "Clinical databases, runtime Consents and logs have separate owners; ordinary backup is not full recovery."
  },
  "admin.source-context": {
    "title": "Selected source address",
    "body": "Open one registered source workspace from its managed HAPI, custom external or legacy group. The address preserves its exact registered source ID; stale links never select a replacement. Institution type, hosting and the Data source role are separate facts.",
    "technical": "Selection alone makes no configuration change or clinical request. Runtime not checked is not a healthy result."
  },
  "admin.source-workspace": {
    "title": "Source workspace views",
    "body": "Registration, HTTPS trust, PCM credentials, Clinical data, Request & processing limits and Diagnostics apply according to this source's existing capabilities. Legacy additionally owns Identity mappings and Custom upstream; custom external sources have no local import or deletion.",
    "technical": "Source and view navigation discard an unsubmitted draft and never send it to another target. Active operations retain the whole-Admin navigation guard."
  },
  "admin.runtime-state": {
    "title": "Saved, adopted and observed state",
    "body": "Saved configuration revision describes the file this page read. Component adoption needs that component's own revision evidence; observed checks need a separately recorded result and time. Unknown or not checked does not mean healthy.",
    "technical": "Refresh rereads saved facts; explicit sanity or source readiness actions run their own checks."
  },
  "admin.copy-address": {
    "title": "Copy exact address",
    "body": "Copy the complete configured address without changing host, port or path. If clipboard access is unavailable, the visible address is selected for manual keyboard or touch copying.",
    "technical": "A separate reachable browser link may use this browser's hostname; copied configuration stays exact."
  },
  "admin.protocol-identity": {
    "title": "Exact protocol identity",
    "body": "OAuth issuer, FHIR identity and registered callbacks retain their exact configured values. Browser navigation does not rewrite these identities.",
    "technical": "Callback changes require the existing explicit preview and apply command."
  },
  "admin.apps-inventory": {
    "title": "Configured applications",
    "body": "This inventory reflects current provider registrations only. Service catalog, assignments and lifecycle remain in Services, and Consent approval stays in Consents.",
    "technical": "Dynamic client registration and application provisioning are unavailable here."
  },
  "admin.source-credential-mode": {
    "title": "Credential action",
    "body": "Generate sandbox credentials creates a team-CA-signed pair only when published. Upload existing credentials validates every applicable matching certificate and key before publication. File selection and review never save credentials.",
    "technical": "Private keys stay in this live form until submission and never enter browser storage."
  },
  "admin.source-credential-profile": {
    "title": "Credential profile",
    "body": "Shared P-256 uses one approved pair for PCM mTLS and ES256 assertions. Separate uses independent transport and P-384/ES384 assertion pairs. Source HTTPS server trust stays separate.",
    "technical": "Uploads must match their declared algorithm, issuer, key and client transport role."
  },
  "admin.source-save": {
    "title": "Review and publish source",
    "body": "Review the exact entered endpoint, credential action, role profile and server trust changes before Publish. A save updates this registration and invalidates existing authority; runtime readiness is not checked.",
    "technical": "Existing client and Organization identities remain fixed. Historical Consents and remote clinical data are retained."
  },
  "admin.source-lifecycle": {
    "title": "Disable or re-enable source",
    "body": "Disable prevents use and invalidates existing authority and in-flight operations. Re-enable keeps the same identities and needs fresh authority. Removing a disabled registration preserves historical references and reserves its identity.",
    "technical": "No lifecycle action deletes remote clinical data. Seed-backed team registrations remain operator-controlled."
  },
  "admin.limits-requests": {
    "title": "PCM requests to sources",
    "body": "Controls how PCM groups patient presence checks, how much data it sends and accepts, and how long it waits for each source. Presence checks ask whether a matching patient record exists; they do not retrieve clinical records.",
    "technical": "Managed source components also enforce applicable patient-count, payload and batch-execution limits after loading this configuration. External servers retain their own settings."
  },
  "admin.limits-authorization": {
    "title": "PCM authorization for sources",
    "body": "Controls the size of OAuth messages handled by PCM when authorizing access to the selected source. These limits apply when the source is managed or external; they do not configure an external OAuth or FHIR server.",
    "technical": "RAR JSON, decoded form, encoded transport and token/introspection responses have separate byte limits. Existing local integration components retain applicable checks."
  },
  "admin.limits-managed": {
    "title": "Also enforced by managed sources",
    "body": "The sandbox-managed source also uses these settings for presence batch patient count, payload checks and batch execution time. Edit each value once here. Saving does not prove that the running source has loaded the change.",
    "technical": "Managed native and applicable gateway/adapter checks retain their existing configuration-loading behavior. No second setting or new enforcement mechanism is introduced."
  },
  "admin.limits-external": {
    "title": "External source settings",
    "body": "These controls affect PCM and local integration components for this external source. The external server’s own limits are managed by its operator. Changing a value here cannot reconfigure that server.",
    "technical": "Per-source overrides remain local configuration. Coordinate remote capacity and limits separately with the external operator."
  },
  "admin.limits-adoption": {
    "title": "When saved settings take effect",
    "body": "Saving stores the settings, but this page does not check whether running services are using them. Ask your sandbox administrator to confirm they have taken effect. Let current requests and imports finish before lowering limits. Saving never changes an external server’s own settings.",
    "technical": "PCM uses current configuration on new requests. Mounted source consumers and the gateway must load the configuration; environment-only consumers or old binaries may need an operator-controlled restart or recreation. In-progress OAuth bodies and workflows retain captured budgets; native checks may read later values."
  },
  "admin.limits-inherit": {
    "title": "Shared default or source override",
    "body": "Leave the textbox empty to use the displayed default. Enter a value to override it for this source only; clear the textbox to remove the override. Manage shared defaults opens the common settings page; changes there affect sources that use those defaults. Edits take effect only after saving.",
    "technical": "The form derives inherit or custom from the textbox. Inherit removes only the selected source’s explicit value. Other overrides remain unchanged; legacy retains its private budget alias."
  },
  "admin.clinical-query": {
    "title": "Clinical query processing",
    "body": "Adjust local managed HAPI query work using exact whole bytes, milliseconds and counts. New requests capture saved settings after supporting services are installed; in-flight work retains its snapshot. A save alone does not verify an older image supports the controls.",
    "technical": "Candidate work differs from returned records; cumulative worker allocation differs from JVM heap. Shared defaults and registered-source overrides do not change permissions. Lowered paging capacity or lifetime may evict or expire cursors from original creation time; HTTP 410 means restart the search."
  },
  "admin.clinical-query-transport": {
    "title": "Query transport and deadlines",
    "body": "The query timeout includes a 1,000 millisecond completion reserve and is capped by verified authorization expiry. Private tokens cannot exceed 57,344 bytes and query URIs cannot exceed 8,192 characters.",
    "technical": "These settings do not enlarge NGINX, Node or Tomcat buffers, change HAPI native page-size settings or alter Doctor preview and continuation behavior."
  },
  "admin.clinical-query-save": {
    "title": "Save clinical query limits",
    "body": "Save only this form's settings under the displayed revision. Clearing a source textbox removes only that field's override when saved. Invalid or stale saves preserve saved configuration and return a safe draft.",
    "technical": "After initial binary adoption, a successfully saved edit applies to new local requests without restarting services. Active work is not interrupted by a concurrency reduction. Larger budgets grant no access and promise no available capacity."
  },
  "admin.limits-save": {
    "title": "Save limits",
    "body": "Save the settings in this form using the displayed units. Invalid values or a conflicting saved change leave the settings unchanged. Saving does not confirm that every running service is using the new settings, and does not change an external server’s configuration.",
    "technical": "One decimal MB is exactly 1,000,000 bytes; one second is exactly 1,000 milliseconds. Sub-byte and sub-millisecond values are rejected. Permissions, grant lifetimes and server capacity are unchanged."
  },
  "admin.limits-upload": {
    "title": "Managed source imports",
    "body": "These limits apply only to imports into this sandbox-managed FHIR server, through Admin or the command line. Upload size limits the file’s bytes; entries per upload limits the number of FHIR Bundle entries. They do not affect external sources or guarantee enough server memory and storage.",
    "technical": "Admin and CLI use the same transaction-bundle validator. Canonical minima remain 27,465,318 bytes and 7,155 entries; multipart capture reserves a further 1,048,576 bytes. Active or uncertain imports retain their captured settings and require explicit recovery, never automatic retry."
  },
  "admin.limits-upload-blocked": {
    "title": "Finish or review the current import",
    "body": "Upload limits cannot change while an import is running or its result is uncertain. Finish the import or resolve its status first. Do not retry a partly completed import.",
    "technical": "The server checks unfinished operations and target reservations under the existing configuration mutex. A stopped worker requires the separate recovery process."
  },
  "admin.limit-maxPatients": {
    "title": "Patients per presence batch",
    "body": "The maximum patients PCM checks together in one presence batch. PCM splits larger lists into smaller batches. Managed sources also enforce this count; an external server keeps its own limit. Presence checks find matching patient records without retrieving clinical records.",
    "technical": "Whole patients; range 2–10,000. This is also used by applicable patient-context validation. Source, Patient, scope and Contract authority remain required."
  },
  "admin.limit-maxPayloadBytes": {
    "title": "Batch payload",
    "body": "Limits presence request and response size for PCM. Managed source components also use this value for applicable batch payload checks. For an external source, this does not change the remote server’s own size limit.",
    "technical": "Decimal MB; exact range 1,024–16,777,216 bytes. Saved raw values and origin remain in details. Applicable source gateway and native checks use the loaded configuration."
  },
  "admin.limit-timeoutMilliseconds": {
    "title": "Presence timeout",
    "body": "How long PCM allows for presence checks against one source. Managed sources also use this value to limit batch execution time. It does not set an external server’s timeout. A failed or timed-out check leaves presence unknown rather than treating the patient as absent.",
    "technical": "Displayed in seconds; exact range 1–300,000 milliseconds. PCM captures a per-source deadline; native batch execution checks its own deadline. This does not change sign-in or token expiry."
  },
  "admin.limit-maxRarBytes": {
    "title": "Authorization details",
    "body": "Limits the authorization_details JSON handled by PCM when authorizing access to this source. It describes requested access, including patient and Contract references. This setting does not configure the external source’s OAuth server.",
    "technical": "Decimal MB; exact range 1–16,777,216 decoded UTF-8 bytes, checked after URL decoding. The complete OAuth form has separate decoded and encoded limits."
  },
  "admin.limit-maxFormBytes": {
    "title": "Decoded OAuth form",
    "body": "Limits the whole OAuth request form handled by PCM after URL decoding, including field names, values and separators. Authorization details are part of this form. This does not change an external server’s request limits.",
    "technical": "Decimal MB; exact range 1–16,777,216 UTF-8 bytes. Pre-target parsing uses the largest configured envelope; the selected source’s budget applies after resolution."
  },
  "admin.limit-maxEncodedFormBytes": {
    "title": "Encoded OAuth form",
    "body": "Limits the OAuth request form handled by PCM as it travels over the connection. URL encoding can make it larger than the decoded form: for example, { becomes %7B. This does not configure the external server.",
    "technical": "Decimal MB; exact range 1–50,331,648 wire bytes. Transport parsing and the selected source budget are checked separately."
  },
  "admin.limit-maxResponseBytes": {
    "title": "OAuth response",
    "body": "Limits token and introspection response size for PCM authorization of this source. Responses may contain authorization details as well as token information. Local integration components also check applicable responses; this does not configure the external server.",
    "technical": "Decimal MB; exact range 1–16,777,216 UTF-8 bytes. Responses are checked before applicable replay or invocation consumption. Clinical and presence payload sizes have separate limits."
  },
  "admin.test-workflows": {
    "title": "Local test workflow settings",
    "body": "Save only bounded OTP and sign-in/discovery clocks. Changed settings invalidate outstanding local flows and clear test codes; restart sign-in. No real SMS/email is sent and no Contract or token deadline is extended.",
    "technical": "Existing private configuration owner; no entitlement or membership editor."
  },
  "admin.workflow-otp": {
    "title": "Local OTP limits",
    "body": "Expiry and resend are seconds. Resend must be shorter than expiry. Attempts count across all resends; resending does not reset failed attempts. Contact evidence must be current within the saved maximum age. Changed settings require a new flow.",
    "technical": "Local synthetic code transport only."
  },
  "admin.workflow-authentication": {
    "title": "Sign-in clocks",
    "body": "The sign-in flow captures its deadline. Authenticated session expiry is capped by that original deadline. Authentication request timeout bounds source lookup. Changed settings invalidate outstanding local flows rather than extend them.",
    "technical": "Seconds for lifetimes; milliseconds for request timeout."
  },
  "admin.workflow-discovery": {
    "title": "Dependent discovery limits",
    "body": "Timeout is milliseconds per source and is capped by flow expiry. Page count applies independently to Patient and RelatedPerson streams. Request retries share the request deadline; the single relationship-race retry shares the source deadline. Partial failures stay unknown.",
    "technical": "Source presence/OAuth byte budgets remain under Sources."
  },
  "admin.workflow-sources": {
    "title": "Reviewed HMO source reconciliation",
    "body": "Preview only reads exact saved source and Contract versions. Apply requires an unchanged review and valid existing Contracts; missing, expired or terminal policy requires explicit replacement. Classification grants no access and does not activate an Organization or Endpoint.",
    "technical": "Private backup and publication; no authentication or dependent lookup."
  },
  "admin.doctor-browser": {
    "title": "Doctor browser and SMART callbacks",
    "body": "Enter an explicit browser application base, including its mount. Preview shows exact affected existing client callbacks. Apply requires the unchanged review, privately backs up prior configuration and Organizations, and requires pending SMART tests to restart. Live connectivity remains not checked.",
    "technical": "Request Host headers, provider navigation and browser reachability never create OAuth registration. PKCE, state, client scopes and ownership remain enforced."
  },
  "admin.backup-file": {
    "title": "Select backup JSON file",
    "body": "Read a JSON file into the same ephemeral paste field for review. Loading a file makes no server changes. File and paste use the same server validation and 1 MiB limit.",
    "technical": "An unreadable, malformed or oversized file gives a non-secret error; no filename or backup contents enter browser storage."
  },
  "admin.migration-status": {
    "title": "Observed migration state",
    "body": "Read the existing checkpoint manifest phase, resource scope and measured source artifact/schema facts. Reading does not freeze PCM or verify running component adoption.",
    "technical": "Preserve uncertain journals and fences; checkpoint publication remains explicit."
  },
  "admin.private-backup": {
    "title": "Versioned private checkpoint backup",
    "body": "The accepted pcm-public-metadata-migration/1 operation includes public/private checkpoint authority and binds five source artifacts, configuration, credentials, catalog and original usage/operation owners. It excludes clinical databases, transient tokens and external usage-file contents.",
    "technical": "Use the reviewed stopped-worker CLI. Later restrictions or changed bindings block compatible restore. Ordinary configuration export and public FHIR export are insufficient."
  },
  "admin.maintenance-owners": {
    "title": "Open the operation owner",
    "body": "Open the existing source, certificate, security or Logs area with the exact selected source where applicable. Each action keeps one editor and its established confirmation and pending-operation guards.",
    "technical": "Maintenance does not repeat another area’s mutation form."
  },
  "admin.maintenance-doctor": {
    "title": "Doctor local reset",
    "body": "Open Doctor, then Tools and Reset. Its existing confirmation clears that mount’s request drafts in this tab and uses the existing Doctor reset route.",
    "technical": "This does not reset PCM, clear clinical data or revoke issued PCM tokens."
  }
};
