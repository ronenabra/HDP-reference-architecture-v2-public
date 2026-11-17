'use strict';
/** Actual public FHIR read/search/write/operation seams with disposable owned state. */
const config = require('../../../test-support/team-config').installTestRuntime({ serviceCatalog: {
    file: 'config/demo-services.json', bindings: [{ serviceKey: 'lab-follow-up', application: 'serviceProvider', providerRole: 'serviceProvider', instanceId: 'public-boundary-instance', instanceIdentifier: 'PUBLIC-BOUNDARY-INSTANCE' }] } });
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const store = require('../src/fhir/store');
const { publicDto, publishNewResource } = require('../src/public-fhir');
const { EXTENSIONS, PROFILES, SCOPES } = require('../../shared/pcm-contract');
const { PCM_PATH, environmentEndpoints } = require('../../shared/pcm-environment');
const { tokens } = require('../src/store');
const clock = () => new Date();

/** Own a complete graph, one management token and one ephemeral listener. */
async function fixture() {
    store.reset();
    require('../src/data-sources').syncDataSourcesToStore(store, config, 'A'.repeat(43));
    for (const resource of require('../src/bootstrap').buildSeedDrafts(config, {}, clock)) publishNewResource(store, resource);
    require('../src/fhir/system-policy').provisionSystemPolicies(store, config);
    require('../src/team-config').loadTeamConfig();
    const issued = tokens.issue('management', { client_id: config.organizations.serviceProvider.clientId, organization_id: config.organizations.serviceProvider.id,
        aud: environmentEndpoints(config.contract.environment).fhirBase, scope: SCOPES.management }, 300);
    const app = express(); app.use(express.json({ type: ['application/json', 'application/fhir+json'] })); app.use(express.urlencoded({ extended: false }));
    app.use(PCM_PATH, require('../src/routes/fhir'));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}${PCM_PATH}`;
    return { base, async request(route, options = {}) {
        const response = await fetch(base + route, { ...options, headers: { authorization: `Bearer ${issued.token}`, ...options.headers } });
        const body = await response.json(); return { response, body };
    }, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); tokens.clear(); store.reset(); } };
}

test('actual public GET/POST search/includes, direct reads, writes, operation and metadata return clean DTOs', async () => {
    const f = await fixture();
    try {
        for (const [route, options] of [
            ['/HealthcareService/public-boundary-instance', {}],
            ['/Organization?_include=Organization:endpoint', {}],
            ['/Organization/_search', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '_include=Organization%3Aendpoint' }],
            ['/metadata', {}]
        ]) {
            const { response, body } = await f.request(route, options);
            assert.equal(response.status, 200, JSON.stringify(body)); assert.deepEqual(publicDto(body), body);
        }
        const command = require('../src/service-definition-form').serviceDefinition({ name: 'Public API laboratory service', purpose: 'Public data only', category: '35', accessMode: 'continuous', duration: 1, durationUnit: 'a', allowChanges: false,
            buckets: [{ code: 'laboratoryTests', history: 1, historyUnit: 'a', sensitivity: [] }], permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 'rs' }] });
        const created = await f.request('/HealthcareService', { method: 'POST', headers: { 'content-type': 'application/fhir+json' }, body: JSON.stringify(command) });
        assert.equal(created.response.status, 201, JSON.stringify(created.body)); assertPublicResponse(created.body);
        assert.ok(created.response.headers.get('etag'));
        assert.equal(store.privateRecords.services.getDefinition(created.body.id).status, 'ok');
        const updated = await f.request(`/HealthcareService/${created.body.id}`, { method: 'PUT', headers: { 'content-type': 'application/fhir+json' }, body: JSON.stringify({ resourceType: 'HealthcareService', id: created.body.id, extension: [require('../src/fhir/healthcare-service-lifecycle').statusExtension('cancelled')] }) });
        assert.equal(updated.response.status, 200, JSON.stringify(updated.body)); assertPublicResponse(updated.body);
        const canonical = store.get('HealthcareService', 'service-catalog-1');
        const proposal = { ...canonical, meta: { ...canonical.meta, profile: ['http://pcm.fhir.health.gov.il/StructureDefinition/pcm-healthcareservice-catalog-update-request'] }, name: 'Reviewed public name' };
        // The maintained operation profile is the authority, not an assumed URL.
        proposal.meta.profile = [require('../src/fhir/healthcare-service-lifecycle').CATALOG_PROPOSAL_PROFILE];
        const operation = await f.request(`/HealthcareService/${canonical.id}/$request-catalog-update`, { method: 'POST', headers: { 'content-type': 'application/fhir+json' }, body: JSON.stringify({ resourceType: 'Parameters', parameter: [{ name: 'proposedCatalog', resource: proposal }] }) });
        assert.equal(operation.response.status, 200, JSON.stringify(operation.body)); assertPublicResponse(operation.body);
        const sourceEndpoint = store.getAll('Endpoint').find(item => item.managingOrganization?.reference !== `Organization/${config.organizations.pcm.id}`);
        assert.ok(sourceEndpoint.extension.some(item => item.url === EXTENSIONS.applicableCertificates)); assertPublicResponse(sourceEndpoint);
    } finally { await f.close(); }
});

/** Shared public result assertion includes every nested resource in an envelope. */
function assertPublicResponse(body) { assert.deepEqual(publicDto(body), body); }

test('actual public writes and operation reject nested/JSON private payloads with no partial mutation', async () => {
    const f = await fixture();
    try {
        const before = require('../src/migration-checkpoint').snapshot(store, { privateState: true });
        const request = { resourceType: 'HealthcareService', extension: [{ url: EXTENSIONS.basedOnCanonicalHealthcareService, valueReference: { reference: 'HealthcareService/service-catalog-1' } },
            { url: 'https://third.party/ordinary', valueString: '{"authoring":{"approvalScope":"forged"}}' }] };
        const result = await f.request('/HealthcareService', { method: 'POST', headers: { 'content-type': 'application/fhir+json' }, body: JSON.stringify(request) });
        assert.equal(result.response.status, 400); assert.equal(result.body.resourceType, 'OperationOutcome');
        const proposal = store.get('HealthcareService', 'service-catalog-1');
        proposal.name = JSON.stringify({ approvalSnapshot: { scope: 'forged' } });
        const result2 = await f.request('/HealthcareService/service-catalog-1/$request-catalog-update', { method: 'POST', headers: { 'content-type': 'application/fhir+json' }, body: JSON.stringify({ resourceType: 'Parameters', parameter: [{ name: 'proposedCatalog', resource: proposal }] }) });
        assert.equal(result2.response.status, 400, JSON.stringify(result2.body));
        assert.deepEqual(require('../src/migration-checkpoint').snapshot(store, { privateState: true }), before);
    } finally { await f.close(); }
});

test('existing protected Services writer saves exact private authoring atomically and distinguishes conflicting private definitions', async () => {
    const oldPassword = process.env.TEAM_ADMIN_PASSWORD; process.env.TEAM_ADMIN_PASSWORD = 'owned-fixture-password';
    store.reset();
    for (const resource of require('../src/bootstrap').buildSeedDrafts(config, {}, clock)) publishNewResource(store, resource);
    require('node:fs').cpSync(require('../../../test-support/certificates').certificates(), process.env.CERTS_DIR, { recursive: true });
    const audit = [], requests = [];
    const client = { async search() { requests.push('public-search'); return { resourceType: 'Bundle', type: 'searchset', entry: store.getAll('HealthcareService').map(resource => ({ resource })) }; },
        async read(id) { requests.push('public-read'); return store.get('HealthcareService', id); },
        async register(request) { requests.push('public-existing-registration'); return require('../src/fhir/healthcare-service-lifecycle').registerHealthcareService({ store, callerOrganization: store.get('Organization', config.organizations.serviceProvider.id), request }).instance; } };
    const app = express(); app.use(express.json()); app.use('/services', require('../src/routes/services').servicesRouter({ store, getConfig: () => config, tokenStore: tokens,
        audit: event => audit.push(event), clientFactory: async () => client }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
        const V = '_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V';
        const exact = `patient/Patient.rs?${V} patient/Observation.s?status=final&${V}`;
        const definition = { name: 'Owned private writer test', purpose: 'Protected exact custom authoring', category: '35', accessMode: 'continuous', duration: 1, durationUnit: 'a', allowChanges: false,
            buckets: [{ code: 'laboratoryTests', history: 1, historyUnit: 'a', sensitivity: [] }], permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 's' }], scopeOrigin: 'custom', approvalScope: exact };
        const body = { providerRole: 'serviceProvider', csrf: require('../src/sandbox-service-command').csrf('serviceProvider'), definition };
        const submit = () => fetch(`http://127.0.0.1:${server.address().port}/services/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const response = await submit(), created = await response.json();
        assert.equal(response.status, 200, JSON.stringify(created));
        assert.equal(store.privateRecords.services.getDefinition(created.id).grant.scope, exact);
        assert.ok(requests.includes('public-search')); assert.ok(audit.every(event => event.visibility === 'diagnostic'));
        store.getAll('HealthcareService').forEach(resource => publicDto(resource));
        const repeated = await submit(), existing = await repeated.json();
        assert.equal(repeated.status, 200, JSON.stringify(existing)); assert.equal(existing.alreadyAdded, true);
        const before = require('../src/migration-checkpoint').snapshot(store, { privateState: true });
        body.definition.approvalScope = exact.replace('status=final', 'status=preliminary');
        const conflict = await submit(); assert.equal(conflict.status, 409, await conflict.text());
        assert.deepEqual(require('../src/migration-checkpoint').snapshot(store, { privateState: true }), before);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.reset();
        if (oldPassword === undefined) delete process.env.TEAM_ADMIN_PASSWORD; else process.env.TEAM_ADMIN_PASSWORD = oldPassword; }
});
