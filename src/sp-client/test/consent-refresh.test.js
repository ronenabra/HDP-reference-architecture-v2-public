'use strict';
/** Polling membership changes drops cached clinical authority and refreshes exact endpoint discovery. */
const test = require('node:test'), assert = require('node:assert/strict');
const { refreshConsent } = require('../src/consent-refresh');
const consent = ids => ({ id: 'one', provision: { actor: ids.map(id => ({ role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'CST' }] }, reference: { reference: `Organization/${id}` } })) } });
test('A → A+B → B → empty clears tokens/results and never keeps removed endpoints', async () => {
    const record = { owner: 'hospital-a', consent: { ...consent(['A']), discoveredEndpoint: 'A' }, data: { private: true } };
    let resets = 0;
    for (const ids of [['A', 'B'], ['B'], []]) {
        record.data = { private: true };
        assert.equal(await refreshConsent(record, consent(ids), { resetCache: owner => { assert.equal(owner, 'hospital-a'); resets++; }, discover: async (id, owner) => {
            assert.equal(owner, 'hospital-a'); return { ...consent(ids), discoveredEndpoints: ids };
        } }), true);
        assert.equal(record.data, null); assert.deepEqual(record.consent.discoveredEndpoints, ids);
    }
    assert.equal(resets, 3);
});
test('unchanged set preserves results; discovery failure clears stale endpoints on a change', async () => {
    const record = { consent: { ...consent(['A']), discoveredEndpoint: 'A' }, data: 7 };
    assert.equal(await refreshConsent(record, consent(['A']), { resetCache: () => assert.fail(), discover: () => assert.fail() }), false);
    assert.equal(record.data, 7);
    await refreshConsent(record, consent([]), { resetCache() {}, discover: async () => { throw Error('unavailable'); } });
    assert.equal(record.data, null); assert.equal(record.consent.discoveredEndpoint, undefined);
});

test('overlapping discoveries and older poll versions cannot restore removed source projections', async () => {
    const record = { consent: { ...consent(['A']), meta: { versionId: '2' } }, data: 7 };
    let finish;
    const first = refreshConsent(record, { ...consent(['A', 'B']), meta: { versionId: '3' } }, { resetCache() {}, discover: () => new Promise(resolve => { finish = resolve; }) });
    await refreshConsent(record, { ...consent([]), meta: { versionId: '4' } }, { resetCache() {}, discover: async () => ({ ...consent([]), meta: { versionId: '4' }, discoveredEndpoints: [] }) });
    finish({ ...consent(['A', 'B']), meta: { versionId: '3' }, discoveredEndpoint: 'A' }); await first;
    assert.equal(record.sourceRevision, 2); assert.equal(record.consent.meta.versionId, '4'); assert.equal(record.consent.discoveredEndpoint, undefined);
    await refreshConsent(record, { ...consent(['A']), meta: { versionId: '2' } }, { resetCache: () => assert.fail(), discover: () => assert.fail() });
    assert.equal(record.consent.meta.versionId, '4'); assert.equal(record.data, null);
});

test('provider cancellation with unchanged sources clears cached tokens/results and rejects late discovery', async () => {
    const { businessStatusExtension } = require('../../pcm-core/src/fhir/consent-lifecycle');
    const active = { ...consent(['A']), status: 'active', extension: [businessStatusExtension('active')], meta: { versionId: '2' }, discoveredEndpoint: 'A' };
    const record = { owner: 'hospital-a', consent: active, data: { clinical: true } };
    let resets = 0;
    const cancelled = { ...active, status: 'inactive', extension: [businessStatusExtension('service-provider-cancelled')], meta: { versionId: '3' } };
    delete cancelled.discoveredEndpoint;
    assert.equal(await refreshConsent(record, cancelled, { resetCache: owner => { assert.equal(owner, 'hospital-a'); resets++; }, discover: () => assert.fail('cancelled Consent must not discover') }), true);
    assert.equal(record.data, null); assert.equal(record.consent.discoveredEndpoint, undefined); assert.equal(record.sourceRevision, 1); assert.equal(resets, 1);
    assert.equal(await refreshConsent(record, active, { resetCache: () => assert.fail(), discover: () => assert.fail() }), false);
    assert.equal(record.consent.status, 'inactive');
});

test('removed source membership clears a previously selected source address', async () => {
    const record = { owner: 'a', consent: { status: 'active', provision: { actor: [] } }, selectedEndpoint: 'https://removed.example/fhir', data: { old: true } };
    await refreshConsent(record, { id: 'c', status: 'inactive', provision: { actor: [] } }, { discover: async () => null, resetCache() {} });
    assert.equal(record.selectedEndpoint, null);
    assert.equal(record.data, null);
});

test('changed permission or Patient context with unchanged sources clears old success and owning cache', async () => {
    const URL = require('../../shared/pcm-contract').EXTENSIONS.pcmService;
    for (const change of ['service', 'patient', 'period']) {
        const before = { ...consent(['A']), status: 'active', patient: { identifier: { value: 'before' } }, extension: [{ url: URL, valueReference: { reference: 'HealthcareService/old' } }], provision: { ...consent(['A']).provision, period: { end: '2028-01-01' } } };
        const after = structuredClone(before);
        if (change === 'service') after.extension[0].valueReference.reference = 'HealthcareService/new';
        if (change === 'patient') after.patient.identifier.value = 'after';
        if (change === 'period') after.provision.period.end = '2027-01-01';
        const record = { owner: 'hospital-b', consent: before, data: { oldSuccess: true }, selectedEndpoint: 'old' }, resets = [];
        await refreshConsent(record, after, { resetCache: owner => resets.push(owner), discover: async () => after });
        assert.equal(record.data, null); assert.equal(record.selectedEndpoint, null); assert.deepEqual(resets, ['hospital-b']);
    }
});

test('unknown private-looking extensions do not become cache authority or refresh triggers', async () => {
    const record = { consent: { ...consent(['A']), extension: [{ url: 'urn:pcm:sandbox:consent-scope-snapshot', valueString: 'opaque ignored data' }] }, data: 7 };
    const next = structuredClone(record.consent); next.extension[0].valueString = 'changed';
    assert.equal(await refreshConsent(record, next, { resetCache: () => assert.fail(), discover: () => assert.fail() }), false);
    assert.equal(record.data, 7);
});

test('logical Consent identity remains part of the public cache/context binding even for conflicting business IDs', () => {
    const { permissionSignature } = require('../src/consent-refresh');
    const first = { id: 'First-ID', identifier: [{ system: 'urn:business', value: 'same' }], patient: { identifier: { system: 'urn:patient', value: 'same' } } };
    assert.notEqual(permissionSignature(first), permissionSignature({ ...first, id: 'second.id' }));
});
