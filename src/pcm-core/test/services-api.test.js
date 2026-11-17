'use strict';
/** Actual OAuth/mTLS/public FHIR calls and private service commands on disposable listeners. */
const test = require('node:test'), assert = require('node:assert/strict');
const { startServicesFixture } = require('../../../test-support/services-fixture');
const { csrf } = require('../src/sandbox-service-command');
const lifecycle = require('../src/fhir/healthcare-service-lifecycle');
const { EXTENSIONS } = require('../../shared/pcm-contract');

/** Minimal browser form; the server creates wrappers and retained scope metadata. */
function input() { return { name: 'API owned service', purpose: 'Disposable management qualification', category: '35', accessMode: 'continuous', duration: 6, durationUnit: 'mo', allowChanges: false,
    buckets: [{ code: 'laboratoryTests', history: 2, historyUnit: 'a', sensitivity: [] }], permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 's' }] }; }

test('actual selected-provider calls create, retain scopes, assign under separate certificates, toggle and delete safely', async () => {
    const f = await startServicesFixture();
    try {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-admin-password': f.password };
        const post = (path, body, extraHeaders = {}) => fetch(`${f.base}/admin/services${path}`, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
        assert.equal((await fetch(`${f.base}/admin/services`, { headers: { Accept: 'application/json' } })).status, 401);
        const page = await fetch(`${f.base}/admin/services`, { headers }); assert.equal(page.status, 200); assert.match(await page.text(), /Service catalog/);
        for (const permissions of [[{ type: 'Observation', actions: 'rs' }], [{ type: 'Patient', actions: 'r' }], [{ type: 'Patient', actions: 's' }]]) {
            assert.equal((await post('/create', { providerRole: 'serviceProvider', csrf: csrf('serviceProvider'), definition: { ...input(), permissions } })).status, 400);
        }
        const body = { providerRole: 'serviceProvider', csrf: csrf('serviceProvider'), definition: input() };
        for (const malformed of [{ ...body, csrf: 'bad' }, { ...body, providedBy: 'other' }, { ...body, providerRole: 'not-a-provider' }]) assert.ok([400, 403].includes((await post('/create', malformed)).status));
        assert.equal((await post('/create', body, { Origin: 'https://foreign.test' })).status, 403);
        const createdResponse = await post('/create', body); assert.equal(createdResponse.status, 200, await createdResponse.clone().text());
        const created = await createdResponse.json(); assert.equal(created.state, 'pending'); assert.match(created.message, /waiting for activation/);
        const instance = f.store.get('HealthcareService', created.id), catalogId = lifecycle.basedOnId(instance);
        assert.equal(lifecycle.ownerId(instance), f.config.organizations.serviceProvider.id);
        const catalog = f.store.get('HealthcareService', catalogId);
        const { readPolicy } = require('../../shared/service-confidentiality-policy');
        assert.deepEqual(f.store.privateRecords.services.getDefinition(catalog.id).confidentialityPolicy, { allowRestricted: false });
        assert.deepEqual(f.store.privateRecords.services.getDefinition(instance.id).confidentialityPolicy, { allowRestricted: false });
        const scope = f.store.privateRecords.services.getDefinition(catalog.id).options[0].extension.find(item => item.url === 'scope').valueString;
        assert.equal(scope, 'patient/Patient.rs patient/Observation.s');
        const { providerManagementClient } = require('../src/provider-management-client');
        const ordinaryA = await providerManagementClient({ config: f.config, providerRole: 'serviceProvider', tokenStore: f.tokens });
        await assert.rejects(ordinaryA.read(catalogId), error => error.status === 404);
        const preview = await (await fetch(`${f.base}/admin/services?target=${instance.id}`, { headers })).text();
        assert.match(preview, /Private authoring source/); assert.match(preview, new RegExp(`data-catalog-id="${catalogId}"`));
        /** Send a current-version private simulation using the actual displayed binding. */
        async function action(id, action, overrides = {}) {
            const version = f.store.get('HealthcareService', id)?.meta.versionId || '1';
            return post(`/${id}/sandbox`, { action, expectedVersion: version, csrf: csrf('', id, version), ...overrides });
        }
        assert.equal((await action(instance.id, 'activate')).status, 409);
        assert.equal((await action(catalogId, 'activate')).status, 200);
        assert.deepEqual(f.store.privateRecords.services.getDefinition((await ordinaryA.read(catalogId)).id).confidentialityPolicy, { allowRestricted: false });
        assert.equal((await action(instance.id, 'activate')).status, 200);
        const read = await ordinaryA.read(catalogId); require('../src/public-fhir').assertPublic(read); assert.equal(f.store.privateRecords.services.getDefinition(read.id).options[0].extension.find(item => item.url === 'scope').valueString, scope);
        const assignedResponse = await post('/assign', { providerRole: 'hospitalBServiceProvider', csrf: csrf('hospitalBServiceProvider'), catalogId });
        assert.equal(assignedResponse.status, 200, await assignedResponse.clone().text());
        const assigned = await assignedResponse.json();
        assert.equal(lifecycle.ownerId(f.store.get('HealthcareService', assigned.id)), f.config.organizations.hospitalBServiceProvider.id);
        assert.equal((await post('/assign', { providerRole: 'hospitalBServiceProvider', csrf: csrf('hospitalBServiceProvider'), catalogId })).status, 409);
        assert.equal((await action(assigned.id, 'activate')).status, 200);
        const old = f.store.get('HealthcareService', assigned.id).meta.versionId;
        assert.equal((await action(assigned.id, 'disable')).status, 200);
        assert.equal((await action(assigned.id, 'enable', { expectedVersion: old, csrf: csrf('', assigned.id, old) })).status, 409);
        assert.equal((await action(assigned.id, 'enable')).status, 200);
        assert.equal((await action(catalogId, 'disable')).status, 200);
        assert.equal((await action(catalogId, 'delete')).status, 409);
        assert.equal((await action(catalogId, 'enable')).status, 200);
        for (const id of [instance.id, assigned.id]) { assert.equal((await action(id, 'disable')).status, 200); assert.equal((await action(id, 'delete')).status, 200); }
        assert.equal((await action(catalogId, 'disable')).status, 200); assert.equal((await action(catalogId, 'delete')).status, 200);
        assert.equal((await action(catalogId, 'delete')).status, 404);
        const creates = f.requests.filter(request => request.method === 'POST' && request.path.endsWith('/HealthcareService') && request.status === 201);
        assert.equal(creates.length, 1);
        assert.deepEqual(new Set(creates.map(request => request.organization)), new Set([f.config.organizations.hospitalBServiceProvider.id]));
        assert.ok(f.events.some(event => event.operation === 'service-owner-create' && event.visibility === 'diagnostic' && event.provider === f.config.organizations.serviceProvider.id));
        assert.equal(new Set(creates.map(request => request.certificate)).size, 1);
        assert.ok(creates.every(request => request.certificate));
        assert.ok(f.events.some(event => event.action === 'delete' && event.operator === 'team-admin'));
        assert.equal(f.store.get('HealthcareService', catalogId), null);
    } finally { await f.close(); }
});

test('regular paging stays caller-bound; hidden ownership and missing credentials fail without privileged fallback', async () => {
    const f = await startServicesFixture();
    try {
        const { providerManagementClient } = require('../src/provider-management-client');
        const first = await providerManagementClient({ config: f.config, providerRole: 'serviceProvider', tokenStore: f.tokens });
        const second = await providerManagementClient({ config: f.config, providerRole: 'hospitalBServiceProvider', tokenStore: f.tokens });
        let hidden;
        const { serviceDefinition } = require('../src/service-definition-form');
        for (let index = 0; index < 53; index++) {
            hidden = lifecycle.registerHealthcareService({ store: f.store, callerOrganization: f.store.get('Organization', f.config.organizations.serviceProvider.id),
                request: serviceDefinition({ ...input(), name: `Paging owned service ${index}` }) }).instance;
        }
        await assert.rejects(second.read(hidden.id), error => error.status === 404);
        const page = await first.search(); assert.equal(page.entry.length, 50);
        const next = page.link.find(link => link.relation === 'next').url;
        const cursor = new URL(next).searchParams.get('_page'); assert.ok(cursor);
        assert.equal(first.nextPage(next), cursor);
        for (const invalid of [next.replace(new URL(next).origin, 'https://foreign.test'), next + '&extra=1', next + '&_page=duplicate', next.replace('/HealthcareService?', '/Organization?')]) assert.throws(() => first.nextPage(invalid), /invalid or cyclic/);
        assert.throws(() => first.nextPage(next, cursor), /cyclic/);
        const more = await first.search(cursor); assert.ok(more.entry.length > 0); assert.ok(more.entry.length < 50);
        await assert.rejects(second.search(cursor), error => error.status === 400);
        assert.equal((await second.search()).entry.some(entry => entry.resource.id === hidden.id), false);
        const fs = require('node:fs'), path = require('node:path');
        const key = path.join(process.env.CERTS_DIR, f.config.certificateRoles.serviceProvider.assertion.key);
        const original = fs.readFileSync(key); fs.unlinkSync(key);
        const requestCount = f.requests.length;
        await assert.rejects(providerManagementClient({ config: f.config, providerRole: 'serviceProvider', tokenStore: f.tokens }), /credentials or management permission are unavailable/);
        assert.equal(f.requests.length, requestCount);
        fs.writeFileSync(key, original);
        const owner = f.store.get('Organization', f.config.organizations.serviceProvider.id); f.store.update({ ...owner, active: false });
        await assert.rejects(providerManagementClient({ config: f.config, providerRole: 'serviceProvider', tokenStore: f.tokens }), /credentials or management permission are unavailable/);
        assert.ok((await second.search()).entry.length > 0); // Other provider access remains intact.
    } finally { await f.close(); }
});

test('strict still permits ordinary provider registration but rejects every private lifecycle action', async () => {
    const f = await startServicesFixture('strict');
    try {
        const { providerManagementClient } = require('../src/provider-management-client');
        const client = await providerManagementClient({ config: f.config, providerRole: 'serviceProvider', tokenStore: f.tokens });
        const instance = await client.register(require('../src/service-definition-form').serviceDefinition(input()));
        assert.equal(lifecycle.businessStatus(instance), 'pending');
        const headers = { 'Content-Type': 'application/json', 'x-admin-password': f.password };
        const html = await (await fetch(`${f.base}/admin/services`, { headers })).text();
        assert.match(html, /Private sandbox actions are unavailable in strict mode/);
        for (const action of ['activate', 'enable', 'disable', 'delete']) {
            const response = await fetch(`${f.base}/admin/services/${instance.id}/sandbox`, { method: 'POST', headers, body: JSON.stringify({ action, expectedVersion: instance.meta.versionId, csrf: csrf('', instance.id, instance.meta.versionId) }) });
            assert.equal(response.status, 403);
        }
    } finally { await f.close(); }
});

test('missing catalog prerequisite shows unavailable protected results without fallback or passive mutation', async () => {
    const f = await startServicesFixture();
    try {
        f.config.serviceCatalog = { file: 'missing-owned-catalog.json', bindings: [] };
        const response = await fetch(`${f.base}/admin/services`, { headers: { 'x-admin-password': f.password } });
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.match(html, /Service catalog/);
        assert.match(html, /Selected service catalog is missing/);
        assert.match(html, /existing results are unavailable/);
        assert.doesNotMatch(html, /data-catalog-id=/);
        assert.ok(f.store.getAll('HealthcareService').length > 0, 'unavailable projection does not erase runtime resources');
    } finally { await f.close(); }
});

/** Send an exact current ordinary owner form; no private command is involved. */
function ownerRequest(f, id, state, role = 'hospitalBServiceProvider', overrides = {}, headers = {}) {
    const current = f.store.get('HealthcareService', id), version = current?.meta.versionId || '1';
    return fetch(`${f.base}/admin/services/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': f.password, ...headers },
        body: JSON.stringify({ providerRole: role, csrf: csrf(role, id, version), expectedVersion: version, expectedState: lifecycle.businessStatus(current), state, ...overrides }) });
}

test('ordinary exact owner lifecycle captures closed certificate-authenticated PUTs and preserves shared/peer records', async () => {
    const f = await startServicesFixture();
    try {
        const { providerManagementClient } = require('../src/provider-management-client');
        const a = await providerManagementClient({ config: f.config, providerRole: 'serviceProvider', tokenStore: f.tokens });
        const b = await providerManagementClient({ config: f.config, providerRole: 'hospitalBServiceProvider', tokenStore: f.tokens });
        const shared = f.store.getAll('HealthcareService').find(item => lifecycle.serviceKind(item) === 'catalog' && lifecycle.businessStatus(item) === 'active'
            && !f.store.getAll('HealthcareService').some(peer => lifecycle.basedOnId(peer) === item.id && lifecycle.ownerId(peer) === f.config.organizations.hospitalBServiceProvider.id));
        assert.ok(shared, 'active definition available for Hospital B');
        const untouched = structuredClone(f.store.getAll('HealthcareService'));
        const pending = await b.register(require('../src/service-definition-form').existingRegistration(shared.id));
        assert.equal(lifecycle.businessStatus(pending), 'pending');
        assert.equal((await ownerRequest(f, pending.id, 'cancelled')).status, 200);
        assert.equal(lifecycle.businessStatus(await b.read(pending.id)), 'cancelled');
        assert.equal((await ownerRequest(f, pending.id, 'cancelled')).status, 200, 'same-state cancellation idempotent');
        assert.equal((await ownerRequest(f, pending.id, 'active')).status, 409, 'terminal cannot revive');
        const registration = await b.register(require('../src/service-definition-form').existingRegistration(shared.id));
        // Out-of-band approval supplies the existing PCM prerequisite only; owner work below is ordinary PUT.
        f.store.update({ ...registration, active: true, extension: registration.extension.map(item => item.url === EXTENSIONS.serviceBusinessStatus ? lifecycle.statusExtension('active') : item) });
        const original = await b.read(registration.id);
        // A decided approval cannot be rebound. Create and approve a new owned
        // request for this registration using the accepted snapshot transaction.
        const consentLifecycle = require('../src/fhir/consent-lifecycle');
        const request = structuredClone(require('../../../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json'));
        request.patient.identifier.value = '000000018';
        request.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference = `HealthcareService/${registration.id}`;
        const consent = consentLifecycle.createConsent({ store: f.store, config: f.config,
            callerOrganization: f.store.get('Organization', f.config.organizations.hospitalBServiceProvider.id), request,
            idGenerator: () => 'ordinary-owner-consent' });
        const approved = consentLifecycle.approveConsent({ store: f.store, consent, scopeChoice: 'service-provided',
            sourceOrganizationIds: [f.config.healthOrganizations[0].dataSourceOrganization.id] });
        const snapshot = f.store.privateRecords.approvals.getDecision(approved.id).snapshot;
        assert.equal(snapshot.service.id, registration.id);
        assert.equal(snapshot.scope, f.store.privateRecords.services.getDefinition(shared.id).grant.scope);
        assert.equal((await ownerRequest(f, registration.id, 'cancelled')).status, 409);
        for (const state of ['suspended', 'active', 'suspended', 'cancelled']) {
            assert.equal((await ownerRequest(f, registration.id, state)).status, 200);
            assert.equal(require('../src/fhir/consent-lifecycle').consentBusinessStatus(f.store.get('Consent', 'ordinary-owner-consent')), state === 'suspended' ? 'temporarily-inactive' : state === 'active' ? 'active' : 'permanently-inactive');
        }
        const ended = await b.read(registration.id);
        assert.deepEqual(ended.identifier, original.identifier); assert.equal(lifecycle.basedOnId(ended), shared.id);
        assert.equal((await ownerRequest(f, registration.id, 'active')).status, 409);
        for (const before of untouched) assert.deepEqual(f.store.get('HealthcareService', before.id), before);
        const writes = f.requests.filter(item => item.method === 'PUT' && item.path.endsWith(`/HealthcareService/${registration.id}`));
        assert.equal(writes.length, 4); assert.ok(writes.every(item => item.organization === f.config.organizations.hospitalBServiceProvider.id && item.certificate));
        for (const request of writes) {
            assert.deepEqual(Object.keys(request.body).sort(), ['extension', 'id', 'resourceType']);
            assert.equal(request.body.extension.length, 1); assert.equal(request.body.extension[0].url, EXTENSIONS.serviceBusinessStatus);
        }
        assert.ok((await a.search()).entry.length);
    } finally { await f.close(); }
});

test('ordinary owner route denies forged bindings, foreign/catalog/frozen IDs, stale state and unavailable credentials', async () => {
    const f = await startServicesFixture();
    try {
        const own = f.store.getAll('HealthcareService').find(item => lifecycle.serviceKind(item) === 'instance' && lifecycle.ownerId(item) === f.config.organizations.serviceProvider.id && lifecycle.businessStatus(item) === 'active');
        assert.ok(own);
        const role = 'serviceProvider';
        for (const [overrides, status] of [[{ csrf: 'forged' }, 403], [{ providedBy: 'forged' }, 400], [{ owner: 'forged' }, 400], [{ status: 'active' }, 400], [{ expectedState: 'suspended' }, 409], [{ state: 'frozen' }, 400]]) {
            assert.equal((await ownerRequest(f, own.id, 'suspended', role, overrides)).status, status);
        }
        assert.equal((await ownerRequest(f, own.id, 'suspended', role, {}, { Origin: 'https://foreign.test' })).status, 403);
        assert.equal((await ownerRequest(f, own.id, 'suspended')).status, 403);
        assert.equal((await ownerRequest(f, lifecycle.basedOnId(own), 'suspended', role)).status, 403);
        const version = own.meta.versionId;
        f.store.update({ ...own, active: false, extension: own.extension.map(item => item.url === EXTENSIONS.serviceBusinessStatus ? lifecycle.statusExtension('frozen') : item) });
        assert.equal((await ownerRequest(f, own.id, 'active', role)).status, 409);
        assert.equal((await ownerRequest(f, own.id, 'suspended', role, { expectedVersion: version, csrf: csrf(role, own.id, version) })).status, 409);
        assert.equal(f.requests.filter(item => item.method === 'PUT').length, 0);
        const fs = require('node:fs'), path = require('node:path');
        fs.unlinkSync(path.join(process.env.CERTS_DIR, f.config.certificateRoles.serviceProvider.assertion.key));
        assert.equal((await ownerRequest(f, own.id, 'suspended', role)).status, 503);
    } finally { await f.close(); }
});

test('strict ordinary owner withdrawal succeeds while all private commands remain denied', async () => {
    const f = await startServicesFixture('strict');
    try {
        const client = await require('../src/provider-management-client').providerManagementClient({ config: f.config, providerRole: 'serviceProvider', tokenStore: f.tokens });
        const pending = await client.register(require('../src/service-definition-form').serviceDefinition(input()));
        assert.equal((await ownerRequest(f, pending.id, 'cancelled', 'serviceProvider')).status, 200);
        assert.equal(lifecycle.businessStatus(await client.read(pending.id)), 'cancelled');
        const active = f.store.getAll('HealthcareService').find(item => lifecycle.serviceKind(item) === 'instance' && lifecycle.ownerId(item) === f.config.organizations.serviceProvider.id && lifecycle.businessStatus(item) === 'active');
        assert.ok(active);
        for (const state of ['suspended', 'active', 'suspended', 'cancelled']) assert.equal((await ownerRequest(f, active.id, state, 'serviceProvider')).status, 200);

        const version = f.store.get('HealthcareService', pending.id).meta.versionId;
        const response = await fetch(`${f.base}/admin/services/${pending.id}/sandbox`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': f.password }, body: JSON.stringify({ action: 'enable', expectedVersion: version, csrf: csrf('', pending.id, version) }) });
        assert.equal(response.status, 403);
    } finally { await f.close(); }
});

test('protected all-provider rendering stays separate from ordinary visibility and never invents missing definition authority', async () => {
    const f = await startServicesFixture();
    try {
        const provider = f.store.get('Organization', f.config.organizations.serviceProvider.id);
        const pair = lifecycle.registerHealthcareService({ store: f.store, callerOrganization: provider, request: require('../src/service-definition-form').serviceDefinition(input()) });
        const render = async (view, target) => (await fetch(`${f.base}/admin/services?view=${view}&providerRole=hospitalBServiceProvider&target=${target}`, { headers: { 'x-admin-password': f.password } })).text();
        const html = await render('assignments', pair.instance.id);
        assert.ok(html.includes(`data-service-group="${pair.canonical.id}"`));
        for (const role of ['serviceProvider', 'hospitalBServiceProvider']) assert.ok(html.includes(`data-provider-id="${f.config.organizations[role].id}"`));
        assert.match(html, /Protected provider inventory/);
        const foreign = await require('../src/provider-management-client').providerManagementClient({ config: f.config, providerRole: 'hospitalBServiceProvider', tokenStore: f.tokens });
        await assert.rejects(foreign.read(pair.instance.id), error => error.status === 404);
        f.store.data.HealthcareService.delete(pair.canonical.id); // Deliberate corrupt graph, never a supported delete.
        const broken = await render('catalog', pair.instance.id);
        assert.ok(!broken.includes(`data-catalog-id="${pair.canonical.id}"`));
        assert.notEqual(f.store.privateRecords.services.getDefinition(pair.instance.id).status, 'ok');
        assert.throws(() => require('../src/public-fhir').requireDefinition(f.store, pair.instance), /missing or invalid/);
        const remaining = f.store.getAll('HealthcareService').filter(row => lifecycle.serviceKind(row) === 'catalog');
        const absent = await render('catalog', 'absent-admin-target');
        for (const catalog of remaining) assert.ok(absent.includes(`data-catalog-id="${catalog.id}"`), 'unknown legacy target cannot replace the complete catalog');
    } finally { await f.close(); }
});

test('detached preview validates Admin/origin/CSRF, bounds payload, preserves exact custom text and creates no state', async () => {
    const f = await startServicesFixture();
    try {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'x-admin-password': f.password };
        const post = (body, extra = {}) => fetch(`${f.base}/admin/services/preview`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
        const text = ' patient/Patient.rs\npatient/Observation.s?status=final ';
        const body = { providerRole: 'serviceProvider', csrf: csrf('serviceProvider'), definition: { ...input(), scopeOrigin: 'custom', approvalScope: text } };
        const snapshot = JSON.stringify(['Organization', 'Endpoint', 'HealthcareService', 'Contract', 'Consent'].map(type => f.store.getAll(type)));
        const tokenCount = f.tokens.size;
        const counts = ['HealthcareService', 'Consent', 'Patient'].map(type => f.store.getAll(type).length);
        const requests = f.requests.length;
        const response = await post(body); assert.equal(response.status, 200, await response.clone().text());
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const preview = await response.json();
        assert.equal(preview.savedScope, text); assert.equal(preview.origin, 'custom'); assert.match(preview.effectiveScope, /status=final/);
        assert.equal(preview.effectiveScope, text); assert.equal(preview.previewIdentity, undefined); assert.equal(preview.requestCeiling, null, 'basic manual advice derives no executable ceiling');
        assert.deepEqual(['HealthcareService', 'Consent', 'Patient'].map(type => f.store.getAll(type).length), counts);
        assert.equal(JSON.stringify(['Organization', 'Endpoint', 'HealthcareService', 'Contract', 'Consent'].map(type => f.store.getAll(type))), snapshot); assert.equal(f.requests.length, requests); assert.equal(f.tokens.size, tokenCount);
        for (const [value, expected, extra] of [[{ ...body, csrf: 'wrong' }, 403], [body, 403, { Origin: 'https://foreign.test' }], [{ ...body, token: 'fake' }, 400], [{ ...body, definition: { ...body.definition, purpose: 'x'.repeat(33000) } }, 400]]) assert.equal((await post(value, extra)).status, expected);
        assert.equal((await post(body, { 'x-admin-password': 'wrong' })).status, 401);
    } finally { await f.close(); }
});


test('experimental create/read preserves exact diagnostic text beyond the generator without claiming access', async () => {
    const f = await startServicesFixture();
    const { readServiceGrant } = require('../../shared/service-grant');
    try {
        const headers = { 'Content-Type': 'application/json', 'x-admin-password': f.password };
        const post = (path, definition) => fetch(`${f.base}/admin/services/${path}`, { method: 'POST', headers,
            body: JSON.stringify({ providerRole: 'serviceProvider', csrf: csrf('serviceProvider'), definition }) });
        const envelopeRequests = f.requests.length;
        for (const approvalScope of ['', 'x'.repeat(16385)]) {
            const response = await post('create', { ...input(), scopeOrigin: 'custom', approvalScope });
            assert.equal(response.status, 400, await response.clone().text());
            assert.equal(f.requests.length, envelopeRequests, 'invalid envelope must reject before credentials or upstream mutation');
        }
        for (const [index, text] of ['suspect scope', 'patient/Patient.rs patient/Observation.s?unknown=retained',
            'patient/Patient.rs patient/DocumentReference.rs'].entries()) {
            const definition = { ...input(), name: `Experimental definition ${index}`, scopeOrigin: 'custom', approvalScope: text };
            const count = f.requests.length, before = JSON.stringify(f.store.getAll('HealthcareService'));
            const response = await post('preview', definition); assert.equal(response.status, 200);
            const preview = await response.json(); assert.equal(preview.savedScope, text); assert.equal(preview.diagnostics.syntax, index === 0 ? 'warning' : 'no-basic-issues');
            assert.deepEqual(Object.keys(preview.diagnostics).sort(), ['issues', 'syntax']);
            assert.equal(f.requests.length, count); assert.equal(JSON.stringify(f.store.getAll('HealthcareService')), before);
            const created = await post('create', definition); assert.equal(created.status, 200, await created.clone().text());
            const body = await created.json(); assert.equal(body.serviceGrant.scope, text);
            const stored = f.store.get('HealthcareService', body.id);
            assert.deepEqual(f.store.privateRecords.services.getDefinition(stored.id).grant, body.serviceGrant);
            assert.deepEqual(f.store.privateRecords.services.getDefinition(lifecycle.basedOnId(stored)).grant, body.serviceGrant);
        }
    } finally { await f.close(); }
});

test('reviewed preview binds its exact creation clock/draft/provider through real ordinary create and readback', async () => {
    const f = await startServicesFixture();
    const { readServiceGrant } = require('../../shared/service-grant');
    try {
        const role = 'serviceProvider', definition = { ...input(), scopeOrigin: 'generated' };
        const headers = { 'Content-Type': 'application/json', 'x-admin-password': f.password };
        const post = (path, body) => fetch(`${f.base}/admin/services/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
        const body = { providerRole: role, csrf: csrf(role), definition };
        const response = await post('preview', body); assert.equal(response.status, 200);
        const preview = await response.json(); assert.ok(preview.previewProof.signature);
        const requests = f.requests.length;
        for (const bad of [{ ...body, definition: { ...definition, duration: 8 }, previewProof: preview.previewProof },
            { ...body, previewProof: { ...preview.previewProof, anchor: '2000-01-01T00:00:00.000Z' } },
            { ...body, providerRole: 'hospitalBServiceProvider', csrf: csrf('hospitalBServiceProvider'), previewProof: preview.previewProof }]) {
            assert.equal((await post('create', bad)).status, 409);
        }
        assert.equal(f.requests.length, requests, 'forged/stale preview rejects before ordinary upstream calls');
        await new Promise(resolve => setTimeout(resolve, 1100));
        const savedResponse = await post('create', { ...body, previewProof: preview.previewProof });
        assert.equal(savedResponse.status, 200, await savedResponse.clone().text());
        const saved = await savedResponse.json(); assert.equal(saved.serviceGrant.scope, preview.savedScope);
        assert.equal(saved.serviceGrant.anchor, preview.calculatedAt);
        const client = await require('../src/provider-management-client').providerManagementClient({ config: f.config, providerRole: role, tokenStore: f.tokens });
        const instance = await client.read(saved.id); assert.deepEqual(f.store.privateRecords.services.getDefinition(instance.id).grant, saved.serviceGrant);
        // Pending canonical visibility remains ordinary policy; owned private activation permits its later ordinary read.
        const canonicalId = lifecycle.basedOnId(instance);
        const current = f.store.get('HealthcareService', canonicalId);
        require('../src/sandbox-service-command').applyServiceCommand({ store: f.store, config: f.config, id: canonicalId,
            action: 'activate', expectedVersion: current.meta.versionId, operator: 'owned-service-grant-proof', audit() {} });
        assert.deepEqual(f.store.privateRecords.services.getDefinition((await client.read(canonicalId)).id).grant, saved.serviceGrant);
        const assignment = await post('assign', { providerRole: 'hospitalBServiceProvider', csrf: csrf('hospitalBServiceProvider'), catalogId: canonicalId });
        assert.equal(assignment.status, 200, await assignment.clone().text());
        assert.deepEqual(f.store.privateRecords.services.getDefinition((await assignment.json()).id).grant, saved.serviceGrant);
        assert.ok(f.requests.some(item => item.method === 'GET' && item.status === 200 && item.certificate && item.organization === f.config.organizations.serviceProvider.id));
        assert.ok(f.events.some(event => event.operation === 'service-owner-create' && event.visibility === 'diagnostic'));
    } finally { await f.close(); }
});
