'use strict';
/** Ordinary service discovery never confuses a partial catalog page with owned executable registrations. */
const test = require('node:test'), assert = require('node:assert/strict');
const { EXTENSIONS, CODE_SYSTEMS, PROFILES } = require('../../shared/pcm-contract');
const directory = require('../src/service-directory');
const { ServiceListState } = require('../src/service-list-state');
const base = 'https://pcm.example/api/fhir-service/r4';
/** Make only the public instance/canonical facts consumed by the projection. */
function resource(id, { owner = 'sp', state = 'active', definition = 'catalog', version = '1' } = {}) {
    return { resourceType: 'HealthcareService', id, name: id, extraDetails: 'Clinical purpose', active: state === 'active',
        meta: { versionId: version, profile: [owner ? PROFILES.healthcareServiceInstance : PROFILES.healthcareServiceCanonical] },
        ...(owner ? { providedBy: { reference: 'Organization/' + owner } } : {}),
        extension: [{ url: EXTENSIONS.serviceBusinessStatus, valueCoding: { system: CODE_SYSTEMS.serviceBusinessStatus, code: state } },
            ...(owner ? [{ url: EXTENSIONS.basedOnCanonicalHealthcareService, valueReference: { reference: 'HealthcareService/' + definition } }] : [])] };
}
const provider = { resourceType: 'Organization', id: 'sp', active: true };
const bundle = (resources, cursor) => ({ resourceType: 'Bundle', type: 'searchset', entry: resources.map(resource => ({ resource })),
    ...(cursor ? { link: [{ relation: 'next', url: base + '/HealthcareService?_page=' + cursor }] } : {}) });
const options = client => ({ client, providerId: 'sp', logicalBase: base });

test('catalog, foreign and pending registrations never execute; known canonical/provider prerequisites control readiness', () => {
    const resources = [resource('catalog', { owner: null }), resource('mine'), resource('pending', { state: 'pending' }), resource('foreign', { owner: 'other' })];
    let result = directory.projectOwnedServices(bundle(resources), 'sp', provider);
    assert.deepEqual(result.map(item => [item.id, item.available]), [['mine', true], ['pending', false]]);
    assert.equal(result[0].definitionReference, 'HealthcareService/catalog'); assert.equal(result[0].definitionVersion, '1');
    result = directory.projectOwnedServices(bundle(resources), 'sp', { ...provider, active: false });
    assert.equal(result[0].available, false);
    resources[0].active = false; resources[0].extension[0].valueCoding.code = 'frozen';
    assert.match(directory.projectOwnedServices(bundle(resources), 'sp', provider)[0].readiness, /Definition frozen/);
    assert.equal(directory.projectOwnedServices(bundle(resources.slice(1)), 'sp', provider)[0].available, false);
    assert.equal(directory.providerRole('untrusted'), null); assert.equal(directory.providerRole('untrusted-assertion'), null);
});

test('page one with no owned registrations retains a real next link and a later owned match is usable', async () => {
    const calls = [];
    const client = async query => { calls.push(query); return query.type === 'Organization' ? provider : query.id ? resource('catalog', { owner: null }) : query.page ? bundle([resource('later')]) : bundle([resource('catalog', { owner: null })], 'opaque'); };
    const first = await directory.loadServicesPage(options(client));
    assert.deepEqual(first.services, []); assert.equal(first.complete, false); assert.equal(first.next, base + '/HealthcareService?_page=opaque');
    const second = await directory.loadServicesPage({ ...options(client), page: first.next, pages: first.pages, used: first.used, seen: [first.next] });
    assert.equal(second.services[0].id, 'later'); assert.equal(second.services[0].available, true); assert.equal(second.complete, true);
    assert.deepEqual(calls.filter(call => !call.id).map(call => call.page), ['', base + '/HealthcareService?_page=opaque']);
});

for (const link of ['https://evil.example/HealthcareService?_page=x', base + '/Consent?_page=x', base + '/HealthcareService?_page=x#f', '/HealthcareService?_page=x', base + '/HealthcareService?cursor=old']) {
    test('reject invalid/foreign/cyclic advertised continuation: ' + link, () => assert.throws(() => directory.nextPage(link, base, base + '/HealthcareService?cursor=old', [base + '/HealthcareService?cursor=old']), /continuation/));
}

test('bad next links retain current valid entries as an explicit incomplete list', async () => {
    const client = async query => query.type === 'Organization' ? provider : query.id ? resource('catalog', { owner: null }) : { ...bundle([resource('mine')]), link: [{ relation: 'next', url: 'https://foreign.example' }] };
    const result = await directory.loadServicesPage(options(client));
    assert.equal(result.services[0].available, true); assert.equal(result.complete, false); assert.equal(result.next, ''); assert.match(result.warnings[0], /incomplete/);
});

test('finite request, page, byte and elapsed-time budgets fail closed without background scans', async () => {
    let calls = 0;
    const client = async query => { calls++; return query.type === 'Organization' ? provider : bundle([resource('mine')], 'more'); };
    const result = await directory.loadServicesPage({ ...options(client), limits: { ...directory.LIMITS, requests: 1 } });
    assert.equal(calls, 1); assert.equal(result.services[0].available, false); assert.equal(result.next, ''); assert.equal(result.complete, false);
    await assert.rejects(directory.loadServicesPage({ ...options(client), pages: directory.LIMITS.pages }), /page budget/);
    await assert.rejects(directory.loadServicesPage({ ...options(client), limits: { ...directory.LIMITS, bytes: 10 } }), /byte budget/);
    let time = 0;
    await assert.rejects(directory.loadServicesPage({ ...options(client), now: () => time += 16000 }), /time budget/);
});

test('off-page exact read resolves only the owned instance; hidden canonical stays unavailable and transient failure is not missing', async () => {
    const calls = [];
    let hidden = false, transient = false;
    const client = async query => { calls.push(query.type + '/' + query.id); if (transient) throw Object.assign(new Error('temporary'), { status: 503 });
        if (query.type === 'Organization') return provider;
        if (query.id === 'catalog') { if (hidden) throw Object.assign(new Error('hidden'), { status: 404 }); return resource('catalog', { owner: null }); }
        return resource(query.id, { owner: query.id === 'foreign' ? 'other' : 'sp' }); };
    const service = await directory.readOwnedService({ ...options(client), id: 'offpage' });
    assert.equal(service.available, true); assert.deepEqual(calls, ['HealthcareService/offpage', 'HealthcareService/catalog', 'Organization/sp']);
    await assert.rejects(directory.readOwnedService({ ...options(client), id: 'foreign' }), /owned/);
    hidden = true; assert.equal((await directory.readOwnedService({ ...options(client), id: 'offpage' })).available, false);
    transient = true; await assert.rejects(directory.readOwnedService({ ...options(client), id: 'offpage' }), /temporary/);
});

test('provider-bound local continuations, changed versions and failed loads preserve honest per-provider state', async () => {
    let revision = 0, fail = false, version = '1';
    const changes = [];
    const load = async () => { if (fail) throw new Error('503 temporary'); return { services: [{ id: 'mine', available: true, signature: version }], next: 'opaque', pages: 1, used: { requests: 1, bytes: 100 }, warnings: [], complete: false }; };
    const state = new ServiceListState(load, (identity, id) => { revision++; changes.push([identity, id]); }, () => revision);
    const first = await state.update('a'), cursor = first.continuation;
    await assert.rejects(state.update('b', { continuation: cursor }), /provider/);
    await state.update('b'); version = '2'; await state.update('a');
    assert.ok(changes.some(item => item[0] === 'a')); assert.equal(state.get('b').services[0].signature, '1');
    await assert.rejects(state.update('a', { continuation: cursor }), /current list/);
    fail = true; await assert.rejects(state.update('a'), /503/);
    assert.equal(state.get('a').services[0].id, 'mine'); assert.equal(state.get('a').services[0].available, false);
    assert.equal(state.get('a').stale, true); assert.equal(state.get('b').services[0].available, true);
});

test('newer refresh/selection/cancellation fences late list responses', async () => {
    let revision = 0, finish;
    const state = new ServiceListState(() => new Promise(resolve => { finish = resolve; }), () => {}, () => revision);
    const pending = state.update('a'); revision++;
    finish({ services: [], next: '', used: { requests: 1, bytes: 1 }, warnings: [], pages: 1, complete: true });
    await assert.rejects(pending, /superseded/); assert.equal(state.get('a'), undefined);
    const controller = new AbortController(), cancelled = state.update('a', { signal: controller.signal }); controller.abort();
    finish({ services: [], next: '', used: { requests: 1, bytes: 1 }, warnings: [], pages: 1, complete: true });
    await assert.rejects(cancelled, /superseded/); assert.equal(state.get('a'), undefined);
});
module.exports = { resource, bundle, provider };

test('configuration/caller changes discard cached lists and fence pending continuations', async () => {
    let stamp = 'client1', invalidated = 0;
    const state = new ServiceListState(async () => ({ services: [], next: 'cursor', pages: 1, used: { requests: 1, bytes: 1 }, warnings: [], complete: false }), () => invalidated++, () => '', () => stamp);
    const first = await state.update('a');
    stamp = 'client2'; assert.equal(state.get('a'), undefined); assert.equal(invalidated, 1);
    await assert.rejects(state.update('a', { continuation: first.continuation }), /current list/);
});

test('a failed later page preserves earlier choices as an incomplete list without inferring deletion', async () => {
    let calls = 0;
    const state = new ServiceListState(async () => {
        if (calls++) throw new Error('503 next page unavailable');
        return { services: [{ id: 'mine', available: true, signature: 'one' }], next: 'opaque', pages: 1, used: { requests: 1, bytes: 1 }, warnings: [], complete: false };
    }, () => assert.fail('A failed next page does not revoke previously loaded service facts'));
    const first = await state.update('a');
    await assert.rejects(state.update('a', { continuation: first.continuation }), /503/);
    assert.equal(state.get('a').services[0].available, true); assert.equal(state.get('a').complete, false);
    assert.equal(state.get('a').continuation, ''); assert.match(state.get('a').error, /next page/);
});

test('a newer service refresh wins even when an older cancelled request finishes last', async () => {
    const finish = [];
    const state = new ServiceListState(() => new Promise(resolve => finish.push(resolve)), () => {});
    const old = state.update('a'), current = state.update('a');
    finish[1]({ services: [{ id: 'new', available: true, signature: 'new' }], next: '', pages: 1, used: { requests: 1, bytes: 1 }, warnings: [], complete: true });
    await current;
    finish[0]({ services: [{ id: 'old', available: true, signature: 'old' }], next: '', pages: 1, used: { requests: 1, bytes: 1 }, warnings: [], complete: true });
    await assert.rejects(old, /superseded/); assert.equal(state.get('a').services[0].id, 'new');
});

test('permission defaults follow only readable canonical versions, independently of stale instance copies', async () => {
    const publicDefinition = require('../../../test-support/doctor-public-fixture').doctorPublicFixture().canonical;
    const canonical = { ...publicDefinition, ...resource('catalog', { owner: null }), extension: [...publicDefinition.extension.filter(value => value.url !== EXTENSIONS.serviceBusinessStatus), ...resource('catalog', { owner: null }).extension] };
    const instance = resource('off-page'), foreign = resource('foreign', { owner: 'other' });
    instance.extension.push({ url: 'urn:pcm:sandbox:service-grant', valueString: '{}' });
    let current = canonical;
    const client = async query => query.type === 'Organization' ? provider : query.id === 'catalog' ? current : instance;
    const first = await directory.readOwnedService({ ...options(client), id: instance.id });
    assert.equal(first.permissions.usable, true); assert.equal(first.scope, 'patient/Patient.rs patient/Observation.rs patient/DiagnosticReport.rs patient/MedicationRequest.rs patient/MedicationStatement.rs patient/MedicationAdministration.rs patient/MedicationDispense.rs');
    assert.match(first.scope, /DiagnosticReport/);
    current = { ...canonical, meta: { ...canonical.meta, versionId: '2' } };
    const changed = await directory.readOwnedService({ ...options(client), id: instance.id });
    assert.notEqual(changed.signature, first.signature); assert.equal(changed.definitionVersion, '2');
    assert.equal(changed.permissions.scope, first.permissions.scope);
    assert.equal(directory.projectOwnedServices(bundle([canonical, foreign]), 'sp', provider).length, 0);
    current = null;
    assert.equal((await directory.readOwnedService({ ...options(client), id: instance.id })).scope, '');
});

test('continuation follows opaque same-search query bytes without inventing a page parameter', () => {
    const link = base + '/HealthcareService?cursor=Q%2Bcase.a-b&providedBy=Organization%2Fsp';
    assert.equal(directory.nextPage(link, base, '', []), link);
});

test('private-looking service extensions/tags do not affect request intent or stale/cache signatures', () => {
    const canonical = resource('catalog', { owner: null }), instance = resource('mine');
    const before = directory.projectOwnedServices(bundle([canonical, instance]), 'sp', provider)[0];
    canonical.extension.push({ url: 'urn:pcm:sandbox:service-grant', valueString: '{"scope":"untrusted"}' });
    canonical.meta.tag = [{ system: 'urn:pcm:sandbox:seed-definition', display: 'private metadata changed' }];
    const after = directory.projectOwnedServices(bundle([canonical, instance]), 'sp', provider)[0];
    assert.equal(after.signature, before.signature); assert.equal(after.scope, before.scope);
});
