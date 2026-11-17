'use strict';
/** Actual protected Admin commands plus unchanged exact-provider OAuth/FHIR on disposable listeners. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServicesFixture } = require('../../../test-support/services-fixture');
const command = require('../src/sandbox-service-command');
const lifecycle = require('../src/fhir/healthcare-service-lifecycle');
const { snapshot } = require('../src/migration-checkpoint');

/** Complete bounded authoring input, leaving server identity/lifecycle/ownership absent. */
function definition(name = 'API independent catalog') {
    return { name, purpose: 'Disposable independent catalog qualification', category: '35', accessMode: 'continuous', duration: 6, durationUnit: 'mo', allowChanges: false,
        buckets: [{ code: 'laboratoryTests', history: 2, historyUnit: 'a', sensitivity: [] }], permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 's' }] };
}
/** Requests remain authenticated, target-bound and same-origin, like the existing Admin mount. */
function client(f) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-admin-password': f.password };
    const get = async path => { const response = await fetch(`${f.base}/admin/services${path}`, { headers }); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
    const post = (path, body, extra = {}) => fetch(`${f.base}/admin/services${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const createBody = () => ({ expectedRevision: f.store.privateState.revision, definition: definition(), csrf: command.csrf('', 'catalog-create', String(f.store.privateState.revision)) });
    const action = (id, action, changes = {}) => { const version = f.store.get('HealthcareService', id)?.meta.versionId || '1'; return post(`/${id}/sandbox`, { action, expectedVersion: version, csrf: command.csrf('', id, version), ...changes }); };
    return { headers, get, post, createBody, action };
}

test('protected zero-instance lifecycle, exact provider calls, three identities and missing credentials stay separate', async () => {
    const f = await startServicesFixture();
    try {
        const api = client(f);
        assert.equal((await fetch(`${f.base}/admin/services/inventory`)).status, 401);
        const owner = f.store.get('Organization', f.config.organizations.serviceProvider.id);
        f.store.add({ ...owner, id: 'registered-third', name: 'Third registered provider', identifier: [{ ...owner.identifier[0], value: 'PCM-THIRD' }] });
        const initial = await api.get('/inventory'); assert.equal(initial.creation.authority, 'Admin');
        const body = api.createBody();
        for (const forged of [{ ...body, providedBy: 'registered-third' }, { ...body, csrf: 'forged' }, { ...body, definition: { ...body.definition, purpose: '' } }]) assert.ok([400, 403].includes((await api.post('/catalog', forged)).status));
        assert.equal((await api.post('/catalog', body, { Origin: 'https://foreign.invalid' })).status, 403);
        const count = f.requests.length, result = await api.post('/catalog', body); assert.equal(result.status, 200, await result.clone().text());
        const created = await result.json(); assert.equal(created.registrationCount, 0); assert.equal(created.state, 'pending');
        assert.equal(f.requests.length, count, 'private creation makes no OAuth/FHIR calls');
        assert.equal((await api.post('/catalog', body)).status, 409, 'replayed creation revision is stale');
        assert.equal((await api.post('/catalog', api.createBody())).status, 409, 'duplicate name with fresh revision');
        const validateBody = { expectedVersion: created.version, csrf: command.csrf('', created.id, created.version) };
        const validated = await api.post(`/catalog/${created.id}/validate`, validateBody); assert.equal(validated.status, 200, await validated.clone().text());
        assert.equal((await validated.json()).definitionValid, true); assert.equal(f.requests.length, count);
        assert.equal((await api.post(`/catalog/${created.id}/validate`, validateBody, { Origin: 'https://foreign.invalid' })).status, 403);
        const { providerManagementClient } = require('../src/provider-management-client');
        const { requestJson } = require('../src/system-workflow-client');
        let authorization;
        const ordinary = await providerManagementClient({ config: f.config, providerRole: 'serviceProvider', tokenStore: f.tokens, transport: async (url, request) => {
            const response = await requestJson(url, request);
            if (response.access_token) authorization = { token: response.access_token, tls: request.tls };
            return response;
        } });
        await assert.rejects(ordinary.read(created.id), error => error.status === 404);
        assert.equal((await api.action(created.id, 'activate')).status, 200);
        const publicResource = await ordinary.read(created.id); require('../src/public-fhir').assertPublic(publicResource);
        const beforeDelete = snapshot(f.store, { privateState: true });
        const refusal = await requestJson(`${f.config.internalBaseUrls.pcmFhir}/HealthcareService/${created.id}`, { method: 'DELETE', timeoutMilliseconds: 10000, tls: authorization.tls, acceptedStatuses: [405], headers: { Authorization: `Bearer ${authorization.token}`, Accept: 'application/fhir+json' } });
        assert.equal(refusal.resourceType, 'OperationOutcome'); assert.deepEqual(snapshot(f.store, { privateState: true }), beforeDelete);
        assert.equal(publicResource.providedBy, undefined); assert.equal(JSON.stringify(publicResource).includes('pcm-service-grant/1'), false);
        const assigned = [];
        for (const role of ['serviceProvider', 'hospitalBServiceProvider']) {
            const response = await api.post('/assign', { providerRole: role, csrf: command.csrf(role), catalogId: created.id });
            assert.equal(response.status, 200, await response.clone().text()); const saved = await response.json(); assigned.push(saved.id);
            assert.equal(saved.state, 'pending'); assert.equal(lifecycle.ownerId(f.store.get('HealthcareService', saved.id)), f.config.organizations[role].id);
            if (role === 'hospitalBServiceProvider') {
                const provider = f.store.get('Organization', f.config.organizations[role].id); f.store.update({ ...provider, active: false });
                const before = snapshot(f.store, { privateState: true });
                assert.equal((await api.action(saved.id, 'activate')).status, 409); assert.deepEqual(snapshot(f.store, { privateState: true }), before);
                f.store.update({ ...f.store.get('Organization', provider.id), active: true });
            }
            assert.equal((await api.action(saved.id, 'activate')).status, 200);
        }
        const group = await api.get(`/inventory/${created.id}/providers`); assert.equal(group.total, 3); assert.equal(group.complete, true);
        const third = group.items.find(row => row.id === 'registered-third'); assert.equal(third.connection, 'not-connected'); assert.equal(third.connect.available, false); assert.match(third.unavailableReason, /credentials/);
        assert.equal((await api.post('/assign', { providerRole: 'registered-third', csrf: command.csrf('registered-third'), catalogId: created.id })).status, 400);
        const beforeUnavailable = f.requests.length;
        for (const providerRole of ['registered-third', 'pcm']) await assert.rejects(providerManagementClient({ config: f.config, providerRole, tokenStore: f.tokens }), /credentials or management permission/);
        assert.equal(f.requests.length, beforeUnavailable, 'unavailable or non-provider identity causes no borrowed request');
        const calls = f.requests.filter(row => row.method === 'POST' && row.path.endsWith('/HealthcareService'));
        assert.deepEqual(new Set(calls.map(row => row.organization)), new Set([owner.id, f.config.organizations.hospitalBServiceProvider.id]));
        assert.equal(new Set(calls.map(row => row.certificate)).size, 2); assert.ok(calls.every(row => row.status === 201));
        assert.ok(f.events.some(event => event.operation === 'admin-catalog-create' && event.visibility === 'diagnostic'));
        assert.ok(f.events.some(event => event.operation === 'admin-catalog-validate' && event.visibility === 'diagnostic'));
        const version = f.store.get('HealthcareService', assigned[0]).meta.versionId;
        assert.equal((await api.action(assigned[1], 'disable', { csrf: command.csrf('', assigned[0], version) })).status, 403);
        assert.equal((await api.action(created.id, 'disable')).status, 200);
        assert.equal((await api.post(`/catalog/${created.id}/validate`, validateBody)).status, 409);
        assert.equal((await api.action(created.id, 'enable', { expectedVersion: created.version, csrf: command.csrf('', created.id, created.version) })).status, 409);
        const fs = require('node:fs'), keyPath = require('../src/team-config').certPath(f.config, 'serviceProvider', 'key', 'assertion'), keyBytes = fs.readFileSync(keyPath);
        try {
            fs.unlinkSync(keyPath); const before = snapshot(f.store, { privateState: true }), requests = f.requests.length;
            assert.equal((await api.get('/providers')).items.find(row => row.id === owner.id).standardManagement, false);
            assert.equal((await api.post('/assign', { providerRole: 'serviceProvider', csrf: command.csrf('serviceProvider'), catalogId: created.id })).status, 503);
            assert.equal(f.requests.length, requests); assert.deepEqual(snapshot(f.store, { privateState: true }), before);
        } finally { fs.writeFileSync(keyPath, keyBytes); }
        // Existing public active facts remain visible; management still requires the exact owner.
        const second = await providerManagementClient({ config: f.config, providerRole: 'hospitalBServiceProvider', tokenStore: f.tokens });
        require('../src/public-fhir').assertPublic(await second.read(assigned[0]));
        await assert.rejects(second.status(assigned[0], 'suspended'), error => error.status === 403);
    } finally { await f.close(); }
});

test('Strict exposes privileged reads but refuses every new private validation/create/activation command', async () => {
    const f = await startServicesFixture('strict');
    try {
        const api = client(f), inventory = await api.get('/inventory'), before = snapshot(f.store, { privateState: true });
        assert.equal(inventory.creation.available, false); assert.ok(inventory.items.every(item => item.admin.actions.length === 0));
        assert.equal((await api.post('/catalog', api.createBody())).status, 403);
        const target = inventory.items[0];
        assert.equal((await api.post(`/catalog/${target.id}/validate`, { expectedVersion: target.version, csrf: target.admin.csrf })).status, 403);
        assert.equal((await api.action(target.id, 'disable')).status, 403);
        assert.deepEqual(snapshot(f.store, { privateState: true }), before);
    } finally { await f.close(); }
});

test('forged direct deletion protects fixed builtin identity, seed and terminal references; eligible ordinary deletion succeeds', async () => {
    const f = await startServicesFixture();
    try {
        const api = client(f), authored = require('../src/service-definition-form').serviceDefinitionCommand(definition('Fixture built-in'));
        const builtin = lifecycle.createCatalogDefinition({ store: f.store, request: authored.resource, privateDefinition: authored.definition, idGenerator: () => require('../src/services-admin-model').BUILTIN_CATALOG_ID });
        f.store.update({ ...builtin, name: 'A misleading ordinary name' });
        assert.equal((await api.action(builtin.id, 'delete')).status, 409);
        const seed = f.store.getAll('HealthcareService').find(item => lifecycle.serviceKind(item) === 'catalog' && item.id !== builtin.id);
        assert.equal((await api.action(seed.id, 'disable')).status, 200); assert.equal((await api.action(seed.id, 'delete')).status, 409);
        const created = await (await api.post('/catalog', api.createBody())).json();
        assert.equal((await api.action(created.id, 'activate')).status, 200); assert.equal((await api.action(created.id, 'delete')).status, 409);
        assert.equal((await api.action(created.id, 'disable')).status, 200);
        f.store.add({ resourceType: 'Consent', id: 'ended-service-reference', status: 'inactive', extension: [{ url: require('../../shared/pcm-contract').EXTENSIONS.pcmService, valueReference: { reference: `HealthcareService/${created.id}` } }] });
        assert.equal((await api.action(created.id, 'delete')).status, 409);
        const body = api.createBody(); body.definition.name = 'Deletable ordinary';
        const ordinary = await (await api.post('/catalog', body)).json();
        assert.equal((await api.action(ordinary.id, 'delete')).status, 200); assert.equal(f.store.get('HealthcareService', ordinary.id), null);
        assert.equal(f.store.privateRecords.lifecycle.getState('HealthcareService', ordinary.id).deleted, true);
    } finally { await f.close(); }
});

test('private audit persistence failure returns no partial catalog or lifecycle mutation through actual protected API', async () => {
    const f = await startServicesFixture();
    try {
        const api = client(f), original = f.store.privateRecords.append.bind(f.store.privateRecords), before = snapshot(f.store, { privateState: true });
        f.store.privateRecords.append = () => { throw Error('owned private audit storage failure'); };
        const response = await api.post('/catalog', api.createBody()); assert.equal(response.status, 503); assert.match(await response.text(), /audit storage failure/);
        assert.deepEqual(snapshot(f.store, { privateState: true }), before);
        f.store.privateRecords.append = original;
    } finally { await f.close(); }
});
