'use strict';
/** Historical token evidence covers the actual closed issuance branches. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dataGrantFixture, rar, NOW } = require('../../../test-support/data-grants');
const { createTokenService } = require('../src/token-service');
const { FileTokenStore, TOKEN_KINDS } = require('../src/token-store');
const { INTERNAL_INVOCATION } = require('../src/data-grant');
const { samplingResourceDrafts } = require('../src/fhir/sampling-policy');
const { SCOPES } = require('../../shared/pcm-contract');
const assertion = { client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: 'exact synthetic assertion' };

/** Build only owned file state and actual grants; capture returned object identity. */
function harness(t) {
    const f = require('../../../test-support/clinical-token-fixture').clinicalTokenFixture();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issuance-evidence-'));
    const tokenStore = new FileTokenStore(directory, { clock: () => NOW });
    const oldLogDir = process.env.LOG_DIR; process.env.LOG_DIR = path.join(directory, 'logs');
    const writer = require('../../shared/logger').createLogger({ service: 'pcm-core' });
    if (oldLogDir === undefined) delete process.env.LOG_DIR; else process.env.LOG_DIR = oldLogDir;
    const issued = [], logs = [];
    t.after(() => { tokenStore.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const service = createTokenService({ fhirStore: f.store, firstUseStore: f.firstUseStore,
        tokenStore: { issue(...args) { const result = tokenStore.issue(...args); issued.push(result); return result; } },
        authenticate: req => { req.mtls = { thumbprint: 'A'.repeat(43) }; return { transportVerified: true, signatureVerified: true, assertionSigningThumbprint: 'B'.repeat(43), client: { ...f.client, scopes: [SCOPES.management], authorizationCodeGrant: true,
            mtlsThumbprint: 'A'.repeat(43), assertionThumbprint: 'B'.repeat(43), ...req.client } }; },
        getConfig: () => f.config, getIssuer: () => f.config.contract.operational.fhirBase,
        getPolicy: () => ({ compatibility: { enabledAdapters: [] } }), getLifetime: () => 86400, clock: () => NOW,
        authorizationStore: { consumeCode: () => ({ ok: true, grant: { scope: ['patient/Observation.rs'], audience: f.config.contract.operational.fhirBase, patient: f.patient } }) },
        logger: { info: (message, details) => { logs.push({ message, details }); writer.info(message, details); }, warn() {} } });
    const body = { grant_type: 'client_credentials', ...assertion, resource: f.source.endpoint, scope: f.request.scope, authorization_details: JSON.stringify(f.request.requested.details) };
    return { ...f, serviceResource: f.service, directory, tokenStore, issued, logs, service, body };
}

test('all nine issuance kinds retain the exact opaque token and detached complete returned record', t => {
    const h = harness(t), { config } = h;
    const presenceId = config.oauthClients.presenceOrchestrator.clientId;
    const authId = config.oauthClients.authenticationOrchestrator.clientId;
    const discoveryId = config.oauthClients.discoveryOrchestrator.clientId;
    const second = { ...h.patient, value: '2' }; config.systemAuthorization.presenceEligiblePatients.push(second);
    config.serviceCatalog = { file: 'config/demo-services.json', bindings: [{ application: 'doctor', providerRole: 'serviceProvider', serviceKey: 'lab-follow-up', instanceId: h.serviceResource.id, instanceIdentifier: 'SAMPLER-TEST-INSTANCE' }] };
    config.sandboxSampling = { sourceIds: ['ho-a', 'ho-b'] };
    config.systemAuthorization.clientEntitlements[h.client.clientId] = [...(config.systemAuthorization.clientEntitlements[h.client.clientId] || []), 'sandbox-patient-sample'];
    for (const resource of samplingResourceDrafts(config, NOW)) require('../src/public-fhir').publishNewResource(h.store, resource);
    const contract = (id, patients, scope, client) => ({ body: { ...h.body, scope, authorization_details: JSON.stringify(rar('Contract', id, patients).details) }, client });
    const requests = [
        { body: { grant_type: 'authorization_code', ...assertion, code: 'good', redirect_uri: 'https://app.test/cb', code_verifier: 'a'.repeat(43) } },
        { body: { grant_type: 'client_credentials', ...assertion, scope: SCOPES.management, resource: config.contract.operational.fhirBase } },
        { body: { grant_type: 'client_credentials', ...assertion, scope: SCOPES.management, resource: `${config.contract.operational.fhirBase}/introspect` }, client: { clientId: h.source.clientId, role: 'data-source', organizationId: h.source.dataSourceOrganization.id, scopes: ['introspection'] } },
        { body: h.body },
        contract('PCM-POLICY-PRESENCE-001', [h.patient], 'system/Patient.s', { clientId: presenceId }),
        contract('PCM-POLICY-PRESENCE-001', [h.patient, second], 'system/Patient.s', { clientId: presenceId }),
        contract('PCM-POLICY-PATIENT-AUTHENTICATION-001', [h.strongPatient], 'patient/Patient.s', { clientId: authId }),
        contract('PCM-POLICY-DEPENDENT-DISCOVERY-001', [], 'system/Patient.s system/RelatedPerson.s', { clientId: discoveryId }),
        contract(h.store.get('Contract', 'sandbox-patient-sampling-policy-v2').identifier[0].value, [], 'system/Patient.s')
    ];
    for (const input of requests) {
        if ([authId, discoveryId].includes(input.client?.clientId)) input[INTERNAL_INVOCATION] = { id: 'private-flow', clientId: input.client.clientId, identifier: h.strongPatient, homeHmoId: h.source.dataSourceOrganization.id, phase: input.client.clientId === authId ? 'authenticating' : 'authenticated', expiresAt: NOW + 15 };
        const result = h.service(input);
        assert.equal(result.status, 200, JSON.stringify({ input: input.body, result: result.body }));
        const log = h.logs.at(-1).details, issued = h.issued.at(-1);
        assert.equal(log.type, 'TOKEN_ISSUED'); assert.equal(log.access_token, result.body.access_token);
        assert.equal(log.access_token, issued.token); assert.deepEqual(log.issuanceRecord, issued.record);
        assert.notEqual(log.issuanceRecord, issued.record);
        const emitted = JSON.parse(fs.readFileSync(path.join(h.directory, 'logs/current.log'), 'utf8').trimEnd().split('\n').at(-1));
        assert.deepEqual(emitted.details.issuanceRecord, JSON.parse(JSON.stringify(issued.record)));
        assert.equal(log.issuanceRecord.iat, NOW); assert.equal(log.issuanceRecord.exp, NOW + result.body.expires_in);
        assert.ok(log.issuanceRecord.pcm_authentication_context);
        const before = JSON.stringify(log);
        issued.record.pcm_authentication_context.correlation_verified = 'later mutation';
        issued.record.active = false; issued.record.exp = 0;
        h.tokenStore.revoke(issued.token); h.tokenStore.delete(issued.token);
        assert.equal(JSON.stringify(log), before);
    }
    assert.deepEqual(h.logs.map(item => item.details.kind).sort(), [...TOKEN_KINDS].sort());
});

test('invalid requests and failed allocation do not emit successful issuance evidence', t => {
    const h = harness(t);
    assert.equal(h.service({ body: { ...h.body, authorization_details: '[]' } }).ok, false);
    h.store.update({ ...h.consent, status: 'inactive' });
    assert.equal(h.service({ body: h.body }).ok, false);
    assert.equal(h.logs.length, 0);
    h.tokenStore.issue = () => { throw new Error('owned synthetic disk failure'); };
    assert.throws(() => h.service({ body: { grant_type: 'client_credentials', ...assertion, scope: SCOPES.management, resource: h.config.contract.operational.fhirBase } }), /synthetic disk failure/);
    assert.equal(h.logs.length, 0);
});
