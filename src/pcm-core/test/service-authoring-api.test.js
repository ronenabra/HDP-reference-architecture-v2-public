'use strict';
/** Authoring HTTP seams: lossless private storage, fixed generated proof and runtime denial. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { startServicesFixture } = require('../../../test-support/services-fixture');
const { csrf } = require('../src/sandbox-service-command');
const lifecycle = require('../src/fhir/healthcare-service-lifecycle');

/** Supported required fields deliberately narrower than a valid custom grant. */
function definition(name, extra = {}) {
    return { name, purpose: 'Disposable authoring qualification', category: '35', accessMode: 'continuous', duration: 6, durationUnit: 'mo', allowChanges: false,
        buckets: [{ code: 'laboratoryTests', history: 2, historyUnit: 'a', sensitivity: [] }], permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 's' }], ...extra };
}

/** Keep the exact authenticated owner command and current private revision. */
function admin(f) {
    const post = (suffix, body, headers = {}) => fetch(`${f.base}/admin/services${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': f.password, ...headers }, body: JSON.stringify(body) });
    const createBody = (input, extra = {}) => ({ definition: input, expectedRevision: f.store.privateState.revision, csrf: csrf('', 'catalog-create', String(f.store.privateState.revision)), ...extra });
    const action = (id, action) => { const version = f.store.get('HealthcareService', id).meta.versionId; return post(`/${id}/sandbox`, { action, expectedVersion: version, csrf: csrf('', id, version) }); };
    return { post, createBody, action };
}

test('catalog authoring saves exact raw manual bytes without preview; generated proof binds draft and history clock', async () => {
    const f = await startServicesFixture();
    try {
        const api = admin(f), count = f.store.getAll('HealthcareService').length, requests = f.requests.length;
        const raw = '  patient/Encounter.s?unusual=שלום%ZZ&status=finished\r\n\tbroken experimental clause  ';
        const input = definition('Raw exact bytes', { scopeOrigin: 'custom', approvalScope: raw });
        const advisory = await api.post('/preview', { csrf: csrf('', 'catalog-preview'), definition: input }); assert.equal(advisory.status, 200);
        const advice = await advisory.json(); assert.equal(advice.savedScope, raw); assert.deepEqual(Object.keys(advice.diagnostics).sort(), ['issues', 'syntax']);
        assert.equal(f.store.getAll('HealthcareService').length, count); assert.equal(f.requests.length, requests);
        const body = api.createBody(input), response = await api.post('/catalog', body); assert.equal(response.status, 200, await response.clone().text());
        const saved = await response.json(), record = f.store.privateRecords.services.getDefinition(saved.id);
        assert.deepEqual(Buffer.from(record.grant.scope), Buffer.from(raw)); assert.equal(record.grant.origin, 'custom'); assert.deepEqual(record.grant.authoring, input);
        const inventory = await (await fetch(`${f.base}/admin/services/inventory?limit=50`, { headers: { 'x-admin-password': f.password } })).json();
        assert.deepEqual(Buffer.from(inventory.items.find(item => item.id === saved.id).definition.grant.scope), Buffer.from(raw));
        assert.equal(record.definitionVersion, saved.version); assert.equal(saved.registrationCount, 0); assert.equal(f.store.getAll('HealthcareService').length, count + 1);
        assert.equal(f.store.get('HealthcareService', saved.id).providedBy, undefined); require('../src/public-fhir').assertPublic(f.store.get('HealthcareService', saved.id));
        assert.equal((await api.post('/catalog', body)).status, 409);
        const generated = definition('Fixed generated anchor');
        const preview = await (await api.post('/preview', { csrf: csrf('', 'catalog-preview'), definition: generated })).json();
        assert.match(preview.savedScope, /date=ge/); assert.match(preview.savedScope, /Confidentiality\|R/); assert.match(preview.savedScope, /Confidentiality\|V/);
        const generatedBody = api.createBody(generated, { previewProof: preview.previewProof });
        assert.equal((await api.post('/catalog', { ...generatedBody, definition: { ...generated, purpose: 'Changed after review' } })).status, 409);
        assert.equal((await api.post('/catalog', { ...generatedBody, previewProof: { ...preview.previewProof, anchor: '2000-01-01T00:00:00.000Z' } })).status, 409);
        const created = await api.post('/catalog', generatedBody); assert.equal(created.status, 200, await created.clone().text());
        const grant = (await created.json()).serviceGrant; assert.equal(grant.scope, preview.savedScope); assert.equal(grant.anchor, preview.calculatedAt);
        for (const invalid of [{ ...input, name: '' }, { ...input, approvalScope: 'x'.repeat(16385) }, { ...input, providedBy: 'forged' }]) assert.equal((await api.post('/catalog', api.createBody(invalid))).status, 400);
        assert.equal((await api.post('/catalog', api.createBody(input), { Origin: 'https://foreign.invalid' })).status, 403);
        assert.equal((await api.post('/catalog', api.createBody(input), { 'x-admin-password': '' })).status, 401);
        assert.equal((await api.post('/catalog', api.createBody({ ...input, purpose: 'x'.repeat(33000) }))).status, 400);
        assert.deepEqual(Buffer.from(f.store.privateRecords.services.getDefinition(saved.id).grant.scope), Buffer.from(raw));
    } finally { await f.close(); }
});

test('saved invalid and unsupported defaults deny real OAuth execution with correlated logs; new correction leaves prior approvals frozen', async () => {
    const f = await startServicesFixture();
    try {
        const api = admin(f), { providerManagementClient } = require('../src/provider-management-client');
        const { requestJson } = require('../src/system-workflow-client'), { createClientAssertion, buildTokenForm } = require('../../sp-client/src/oauth');
        const { certificateConfirmation } = require('../../shared/assertion-keys');
        const { environmentEndpoints } = require('../../shared/pcm-environment'), { certPath } = require('../src/team-config');
        const endpoints = environmentEndpoints(f.config.contract.environment);
        const cert = fs.readFileSync(certPath(f.config, 'serviceProvider', 'cert', 'mtls'));
        const tls = { cert, key: fs.readFileSync(certPath(f.config, 'serviceProvider', 'key', 'mtls')), ca: fs.readFileSync(path.join(process.env.CERTS_DIR, 'rootCA.crt')), rejectUnauthorized: true };
        const signed = () => createClientAssertion({ clientId: f.config.organizations.serviceProvider.clientId, privateKey: fs.readFileSync(certPath(f.config, 'serviceProvider', 'key', 'assertion')), audience: endpoints.tokenEndpoint, cnfThumbprint: certificateConfirmation(cert)['x5t#S256'] });
        const client = await providerManagementClient({ config: f.config, providerRole: 'serviceProvider', tokenStore: f.tokens });
        const v = '_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V';
        const cases = ['malformed experimental text', '  patient/Encounter.s?code=שלום\n  ', `patient/Patient.rs?${v} patient/DocumentReference.s?novel=anything&${v}`, `patient/Patient.rs?${v} patient/Encounter.s?status=finished&${v}`];
        const frozen = [];
        for (const [index, text] of cases.entries()) {
            const created = await api.post('/catalog', api.createBody(definition(`Execution default ${index}`, { scopeOrigin: 'custom', approvalScope: text })));
            assert.equal(created.status, 200, await created.clone().text()); const catalog = await created.json();
            assert.equal((await api.action(catalog.id, 'activate')).status, 200);
            const registration = await client.register(require('../src/service-definition-form').existingRegistration(catalog.id));
            assert.equal((await api.action(registration.id, 'activate')).status, 200);
            const submit = require('../../sp-client/src/fhir-builders').buildConsentSubmit({ system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' }, registration.id, require('../../shared/identity-mapping').sandboxIdentityOptions(f.config));
            const consent = require('../src/fhir/consent-lifecycle').createConsent({ store: f.store, callerOrganization: f.store.get('Organization', f.config.organizations.serviceProvider.id), request: submit, config: f.config });
            const decision = f.store.privateRecords.approvals.getDecision(consent.id).snapshot;
            assert.equal(decision.scope, text); frozen.push({ id: consent.id, bytes: JSON.stringify(decision) });
            await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.ceil(Date.parse(consent.provision.period.start) / 1000) * 1000 - Date.now()) + 5));
            const correlation = `authoring-execution-${index}`, beforeTokens = f.tokens.size;
            const result = await requestJson(f.config.internalBaseUrls.pcmFhir + '/token', { method: 'POST', timeoutMilliseconds: 10000, acceptedStatuses: [200, 400], tls,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-correlation-id': correlation },
                body: buildTokenForm({ grantType: 'client_credentials', assertion: signed(), scope: 'patient/Patient.rs', resource: f.config.healthOrganizations[0].endpoint, authorizationDetails: require('../../shared/data-authorization-details').consentAuthorizationDetails(consent) }).toString() });
            if (index < cases.length - 1) {
                assert.equal(result.error, 'invalid_scope'); assert.match(result.error_description, /unusable/); assert.equal(result.access_token, undefined); assert.equal(f.tokens.size, beforeTokens);
                const denied = fs.readFileSync(require('../src/logger').getLogPath(), 'utf8').trim().split('\n').map(line => JSON.parse(line)).find(row => row.details.type === 'TOKEN_AUTHORIZATION_DENIED' && row.details.correlationId === correlation);
                assert.ok(denied); assert.equal(denied.details.decision, 'denied'); assert.ok(denied.details.traceId); assert.match(denied.details.authorizationError, /unusable/);
            } else { assert.ok(result.access_token); assert.equal(result.scope, text); }
            for (const prior of frozen) assert.equal(JSON.stringify(f.store.privateRecords.approvals.getDecision(prior.id).snapshot), prior.bytes);
        }
    } finally { await f.close(); }
});
