# Optional sandbox workflows

These tools exercise sign-in and application flows with synthetic data. They do
not send real messages or establish a real patient's approval.

## Patient sign-in and dependents

Open **Test patient sign-in and dependents** from PCM. First register a working
source in Admin and classify it as an HMO. Configure its credentials, HTTPS trust
and workflow policy, then load suitable synthetic Patient and RelatedPerson data.
Relationship codes must match the discovery policy. Importing a population alone
does not configure these workflows.

Choose **Home HMO for this test**, an identifier and the full date of birth.
You can enter an identifier manually; the suggested list is only a convenience.
After the HMO check succeeds, open **Show the local test code** and verify it.
No SMS or email is sent. Verification reveals the returned demographics.
Resend and attempt limits apply; requesting a new code does not reset attempts.

Use **Find or refresh dependents** to query eligible HMOs. Results show which
checks completed and which sources were unavailable. Selecting a dependent
rechecks the relationship. It does not select a Doctor patient, approve Consent
or authorize a clinical request.

Use **Explain this page** for control-specific help. For errors, inspect the
message and Logs, correct the inputs or source configuration, then start again.

## SMART application launch

In Doctor, open **Advanced tools → Test SMART application launch**. Use the
registered browser address and callback described in [sandbox use](public-quickstart.md).
Choose the registered application and review the requested access.

If sign-in is needed, complete the HMO test in the same browser and choose
**Return to SMART request**. Then make an explicit application authorization
decision. Signing in or selecting a dependent does not approve that decision.
Synthetic protocol identities are separately labelled choices.

Requests expire after five minutes. Keep the same browser origin throughout.
Lost cookies, expired requests or changed registrations require a fresh start
from Doctor. Starting a new sign-in replaces the browser's previous OTP session;
an older tab cannot verify the newer session.

**SMART code exchange completed** means the token exchange succeeded. This test
does not create clinical Consent, fetch clinical data or put the application token
into Doctor's clinical requests.

## Find sample patients at a source

The source sampler is a sandbox convenience, separate from the normative PCM
workflows. It is unavailable in Strict. The application and source must be
explicitly enabled for it; new non-Strict teams configure the Doctor and Hospital B
applications for this purpose.

The sampler reads a first page of at most ten candidates, with a ten-second
deadline and a 128 KiB response limit. It does not retry or follow later pages.
It returns limited patient details and excludes ambiguous or invalid identifiers.
A sample is neither a full inventory nor proof of permission to read clinical
records. Clinical access still requires the ordinary Consent flow.

Applications integrating this sampler use normal PCM authentication and request
`system/Patient.s` for the configured source. The authorization details identify
the sampling Contract:

```json
[{"type":"https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access","fhirContext":[{"type":"Contract","role":"https://pcm.fhir.health.gov.il/fhir-context-role/authorization-basis","identifier":{"system":"http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id","value":"PCM-POLICY-SANDBOX-PATIENT-SAMPLE-001"}}]}]
```

After validating the token response, use the application's transport certificate
and token to call the source:

```text
GET [HO FHIR BASE]/Patient?identifier=http%3A%2F%2Ffhir.health.gov.il%2Fidentifier%2Fil-hdp-sandbox-synthetic-id%7C&_count=10&_total=none&_elements=identifier%2Cname%2CbirthDate
Authorization: Bearer [ordinary PCM opaque token]
```

Keep tokens in the application backend and separate them by application, source
and purpose. Source errors remain errors; there is no maintenance-access fallback.


When integrating the sampler, sign the assertion for the discovered token
endpoint and supply one configured source as the token request's `resource`.
Form-encode `authorization_details` once. Check the returned scope and
authorization details, including the linked service and the purpose
`sandbox-patient-sample`. Keep the cache separate for each application,
environment, source, authorization basis and scope.

For an existing compatible team, preview the sampling configuration and
team-local catalog with `node pcm-connectathon/scripts/migrate-team-config.js
--config /path/to/team-config.json --standard-sampling`. Review both files
before adding `--write`. Apply the reviewed catalog through the team's protected
catalog workflow when restarting. An expired or terminated sampling policy
requires explicit replacement.
