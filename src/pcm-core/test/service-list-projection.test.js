'use strict';
/** Ordinary-only grouping and finite linked-definition loading regressions. */
const test = require('node:test'), assert = require('node:assert/strict');
const { projectServices, loadServicesPage } = require('../src/service-list-projection');
const { CODE_SYSTEMS, EXTENSIONS, IDENTIFIER_SYSTEMS, PROFILES } = require('../../shared/pcm-contract');
const lifecycle = require('../src/fhir/healthcare-service-lifecycle');

/** Construct a small valid returned FHIR service with deliberate duplicate display names. */
function service(id, owner, definition, state = 'active') {
    return { resourceType: 'HealthcareService', id, name: 'Shared name', active: state === 'active',
        meta: { profile: [owner ? PROFILES.healthcareServiceInstance : PROFILES.healthcareServiceCanonical], tag: [{ system: CODE_SYSTEMS.metaTag, code: owner ? 'instance' : 'catalog' }] },
        identifier: [{ use: 'official', system: owner ? IDENTIFIER_SYSTEMS.healthcareServiceInstance : IDENTIFIER_SYSTEMS.healthcareServiceCatalog, value: id }],
        ...(owner ? { providedBy: { reference: `Organization/${owner}` } } : {}),
        extension: [lifecycle.statusExtension(state), ...(owner ? [{ url: EXTENSIONS.basedOnCanonicalHealthcareService, valueReference: { reference: `HealthcareService/${definition}` } }] : [])] };
}

test('five definitions and two providers group exact owned registrations without duplicate definitions or foreign rows', () => {
    const definitions = Array.from({ length: 5 }, (_, index) => service(`d${index}`));
    const resources = [...definitions, service('a', 'A', 'd0'), service('b', 'B', 'd0'), service('pending', 'B', 'hidden', 'pending')];
    const result = projectServices({ resources, providerId: 'B', providers: [{ id: 'A', name: 'Hospital A' }] });
    assert.deepEqual(result.owned.map(row => row.service.id), ['b', 'pending']);
    assert.equal(result.owned[0].definition.id, 'd0'); assert.equal(result.owned[0].availability, 'Ready to use');
    assert.equal(result.owned[1].definitionState, 'unavailable'); assert.equal(result.owned[1].availability, 'Not ready to use');
    assert.deepEqual(result.available.map(row => row.service.id), ['d1', 'd2', 'd3', 'd4']);
    assert.equal(result.others[0].ownerName, 'Hospital A');
    assert.equal(projectServices({ resources, providerId: 'A' }).owned[0].service.id, 'a');
});

test('stored active is distinct from usable; suspended, frozen and terminal records never become ready', () => {
    for (const state of ['pending', 'suspended', 'frozen', 'rejected', 'cancelled']) {
        const instance = service('b', 'B', 'd', state);
        const rows = projectServices({ resources: [service('d'), instance], providerId: 'B' });
        assert.equal(rows.owned[0].availability, 'Not ready to use'); assert.equal(rows.owned[0].state, state);
    }
    for (const state of ['pending', 'frozen', 'rejected', 'cancelled']) {
        const rows = projectServices({ resources: [service('d', null, null, state), service('b', 'B', 'd')], providerId: 'B' });
        assert.equal(rows.owned[0].availability, 'Not ready to use'); assert.equal(rows.available.length, 0);
    }
    const inactive = service('b', 'B', 'd'); inactive.active = false;
    assert.equal(projectServices({ resources: [service('d'), inactive], providerId: 'B' }).owned[0].availability, 'Not ready to use');
});

/** One search page with a transport stub that cannot access a private store. */
function clientFor(resources, read = async id => service(id)) {
    return { search: async () => ({ resourceType: 'Bundle', type: 'searchset', entry: resources.map(resource => ({ resource })) }), read };
}

test('missing and failed linked reads preserve registration rows and explicitly mark unknown usability', async () => {
    for (const status of [404, 503]) {
        const loaded = await loadServicesPage({ client: clientFor([service('b', 'B', 'hidden')], async () => { throw Object.assign(Error('unavailable'), { status }); }) });
        assert.equal(loaded.resources.length, 1); assert.equal(loaded.warnings.length, 1);
        assert.match(projectServices({ ...loaded, providerId: 'B' }).owned[0].availability, /unknown/);
    }
    await assert.rejects(loadServicesPage({ client: { search: async () => { throw Error('credentials unavailable'); } } }), /credentials unavailable/);
    assert.equal((await loadServicesPage({ client: clientFor([]) })).resources.length, 0);
});

test('one page only, deduplicated linked reads, finite request, byte and deadline budgets', async () => {
    let reads = 0;
    const resources = [service('a', 'B', 'd'), service('b', 'B', 'd'), service('c', 'B', 'd2')];
    const client = clientFor(resources, async id => { reads++; return service(id); });
    const loaded = await loadServicesPage({ client, maxReads: 1 });
    assert.equal(reads, 1); assert.match(loaded.warnings[0], /budget/);
    assert.equal(projectServices({ ...loaded, providerId: 'B' }).owned.length, 3);
    await assert.rejects(loadServicesPage({ client, maxBytes: 1 }), /budget/);
    reads = 0;
    const timed = await loadServicesPage({ client, now: (() => { let n = 0; return () => n++ * 15000; })() });
    assert.equal(reads, 0); assert.match(timed.warnings[0], /budget/);
    await assert.rejects(loadServicesPage({ client: clientFor(Array.from({ length: 51 }, (_, i) => service(`d${i}`))) }), /budget/);
});

test('later-page ownership is projected without claiming prior-page duplicate absence', async () => {
    let searches = 0;
    const client = clientFor([]);
    client.search = async cursor => { searches++; assert.equal(cursor, 'caller-bound'); return { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: service('later', 'B', 'd') }] }; };
    const loaded = await loadServicesPage({ client, page: 'caller-bound' });
    assert.equal(searches, 1); assert.equal(projectServices({ ...loaded, providerId: 'B' }).owned[0].service.id, 'later');
});

test('malformed search and ambiguous continuations fail; oversized or mismatched linked reads remain explicit partial results', async () => {
    await assert.rejects(loadServicesPage({ client: { search: async () => ({ resourceType: 'OperationOutcome' }) } }), /unexpected/);
    await assert.rejects(loadServicesPage({ client: { search: async () => ({ resourceType: 'Bundle', type: 'searchset', link: [{ relation: 'next', url: 'a' }, { relation: 'next', url: 'b' }] }) } }), /ambiguous/);
    const oversized = await loadServicesPage({ client: clientFor([service('a', 'B', 'd')], async () => ({ ...service('d'), extraDetails: 'x'.repeat(2000) })), maxBytes: 1800 });
    assert.equal(oversized.resources.length, 1); assert.match(oversized.warnings[0], /byte budget/);
    const wrong = await loadServicesPage({ client: clientFor([service('a', 'B', 'd')], async () => service('other')) });
    assert.equal(wrong.resources.length, 1); assert.match(wrong.warnings[0], /could not be read/);
});

test('row history remains creation provenance and one-time access names the client/source boundary', () => {
    for (const mode of ['continuous', 'one-time']) {
        const definition = service('display');
        definition.extension.push({ url: EXTENSIONS.informationBucket, extension: [
            { url: 'bucket', valueCodeableConcept: { coding: [{ code: 'laboratoryTests' }] } },
            { url: 'historyDepth', valueDuration: { value: 2, code: 'a' } }
        ] }, { url: EXTENSIONS.accessDuration, valueDuration: { value: 6, code: 'mo' } }, { url: EXTENSIONS.accessMode, valueCode: mode });
        const row = projectServices({ resources: [definition, service('registration', 'A', 'display')], providerId: 'A' }).owned[0];
        assert.equal(row.access.summary, 'Laboratory tests');
        assert.match(row.access.history[0], /2 years at creation \(generator input\)/);
        assert.match(row.access.period, /^6 months/);
        assert.match(row.access.period, mode === 'continuous' ? /ongoing within the approved period/ : /one hour per client and source from first qualifying use/);
    }
    assert.equal(projectServices({ resources: [service('unknown', 'A', 'missing')], providerId: 'A' }).owned[0].access.period, 'Not available');
});
