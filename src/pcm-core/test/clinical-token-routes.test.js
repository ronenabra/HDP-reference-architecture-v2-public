'use strict';

/** Actual mTLS OAuth routes: exact scope and source/Patient context on the wire. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { startSnapshotFixture, EXACT, V } = require('../../../test-support/consent-snapshot-fixture');
const { approveConsent, createConsent } = require('../src/fhir/consent-lifecycle');
const { readApprovalSnapshot } = require('../../shared/consent-scope-snapshot');
const { requestJson } = require('../src/system-workflow-client');
const { createClientAssertion, buildTokenForm } = require('../../sp-client/src/oauth');
const { environmentEndpoints } = require('../../shared/pcm-environment');
const { certificateConfirmation } = require('../../shared/assertion-keys');
const { rar } = require('../../../test-support/data-grants');

/** Keep real registered certificate roles separate from logical OAuth audiences. */
function credentials(f, source) {
    const { certPath } = require('../src/team-config');
    const file = name => fs.readFileSync(path.join(process.env.CERTS_DIR, name));
    const cert = source ? file(source.certificates.gatewayMtlsCert) : fs.readFileSync(certPath(f.config, 'serviceProvider', 'cert', 'mtls'));
    return { tls: { ca: file('rootCA.crt'), cert, key: source ? file(source.certificates.gatewayMtlsKey) : fs.readFileSync(certPath(f.config, 'serviceProvider', 'key', 'mtls')), rejectUnauthorized: true },
        sign(audience) { return createClientAssertion({ clientId: source ? source.clientId : f.config.organizations.serviceProvider.clientId,
            privateKey: source ? file(source.certificates.gatewayAssertionKey) : fs.readFileSync(certPath(f.config, 'serviceProvider', 'key', 'assertion')),
            audience, cnfThumbprint: certificateConfirmation(cert)['x5t#S256'] }); } };
}

test('real token/introspection routes preserve approvals across tokens, clocks, patients and permitted sources without compiler calls', async t => {
    const f = await startSnapshotFixture(); t.after(() => f.close());
    const endpoints = environmentEndpoints(f.config.contract.environment), provider = credentials(f);
    const baseNow = Math.ceil(Date.now() / 1000) + 1;
    let now = baseNow;
    t.mock.method(Date, 'now', () => now * 1000);
    const clock = () => new Date(baseNow * 1000);
    const call = (suffix, body, auth, statuses = [200]) => requestJson(f.config.internalBaseUrls.pcmFhir + suffix, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
        tls: auth.tls, timeoutMilliseconds: 10000, acceptedStatuses: statuses });
    const issue = (consent, source, ceiling) => call('/token', buildTokenForm({ assertion: provider.sign(endpoints.tokenEndpoint),
        scope: ceiling, resource: source.endpoint, authorizationDetails: rar('Consent', consent.identifier[0].value).details }), provider, [200, 400]);
    const introspect = (token, source) => { const ds = credentials(f, source); return call('/introspect', new URLSearchParams({
        token, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: ds.sign(endpoints.introspectionEndpoint) }), ds); };
    const manual = `patient/Patient.rs?${V} patient/Observation.s?status=final&date=ge2000-02-29&${V} patient/Observation.r?code=abc&${V} patient/Encounter.s?${V}`;
    const choices = ['service-provided', 'auto-resources', 'custom'];
    const receipts = [];
    let finalConsent;
    for (const [index, choice] of choices.entries()) {
        const request = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json')));
        request.patient.identifier = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: index % 2 ? '000000026' : '000000018' };
        request.extension.find(item => item.url.endsWith('/ext-pcm-service')).valueReference.reference = 'HealthcareService/approval-lab-follow-up';
        const pending = createConsent({ store: f.store, config: f.config, callerOrganization: f.store.get('Organization', f.config.organizations.serviceProvider.id), request, clock });
        const approved = approveConsent({ store: f.store, consent: pending, scopeChoice: choice, customScope: manual,
            sourceOrganizationIds: f.config.healthOrganizations.map(source => source.dataSourceOrganization.id), clock });
        finalConsent = approved;
        const snapshot = f.store.privateRecords.approvals.getDecision(approved.id).snapshot, ceiling = require('../../shared/service-grant').inspectScope(snapshot.scope).requestCeiling;
        if (choice === 'service-provided') assert.equal(snapshot.scope, EXACT);
        if (choice === 'custom') assert.equal(snapshot.scope, manual);
        const compiler = require('../src/grant-compiler');
        const original = compiler.compileConsentScope; compiler.compileConsentScope = () => { throw new Error('clinical compiler must not run'); };
        try {
            const denied = await issue(approved, f.config.healthOrganizations[0], 'patient/Observation.s');
            assert.equal(denied.scope, snapshot.scope);
            for (const source of f.config.healthOrganizations.slice(0, 2)) for (const offset of [0, 60]) {
                now = baseNow + offset;
                const token = await issue(approved, source, ceiling); assert.ok(token.access_token, JSON.stringify(token));
                assert.equal(token.scope, snapshot.scope);
                const active = await introspect(token.access_token, source); assert.equal(active.active, true); assert.equal(active.scope, snapshot.scope);
                assert.deepEqual(active.authorization_details, token.authorization_details);
                assert.deepEqual(active.authorization_details[0].fhirContext.find(item => item.type === 'Patient').identifier, request.patient.identifier);
                const wrongSource = await introspect(token.access_token, f.config.healthOrganizations.find(other => other.id !== source.id));
                assert.deepEqual(wrongSource, { active: false });
                const again = await introspect(token.access_token, source); assert.equal(again.scope, snapshot.scope);
                receipts.push({ choice, clock: now, patient: request.patient.identifier, source: source.id,
                    approved: snapshot.scope, token, active, wrongSource, again });
            }
        } finally { compiler.compileConsentScope = original; }
    }
    const doctor = require('../../sp-client/src/client'); t.after(() => doctor.resetCache());
    const ordinary = await doctor.checkConsentStatus(finalConsent.id, 'hospital-a');
    assert.equal(readApprovalSnapshot(ordinary), null, 'ordinary FHIR response excludes the private approval');
    assert.equal(f.store.privateRecords.approvals.getDecision(ordinary.id).snapshot.scope, manual);
    // Doctor token preparation remains sprint08; this source-facing route test uses the ordinary OAuth request directly.
    const publicToken = await issue(finalConsent, f.config.healthOrganizations[0], 'patient/Observation.s');
    const publicActive = await introspect(publicToken.access_token, f.config.healthOrganizations[0]);
    assert.equal(publicActive.scope, manual, 'ordinary narrow requests retain the exact saved approval');
    assert.ok(f.requests.some(item => item.path.endsWith('/token') && item.certificate && item.status === 200));
    assert.ok(f.requests.some(item => item.path.endsWith('/introspect') && item.certificate && item.status === 200));
    if (process.env.TOKEN_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.TOKEN_EVIDENCE_DIR, 'route-readback.json'), JSON.stringify({ receipts, publicActive, requests: f.requests }, null, 2));
});
