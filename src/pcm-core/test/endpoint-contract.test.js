/** Endpoint create/update and transition contract tests. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FHIRStore } = require('../src/fhir/store');
const { validateWriteRequest } = require('../src/fhir/contract');
const {
    ParticipantLifecycleError,
    createEndpoint,
    endpointIsReferenced,
    replaceEndpoint
} = require('../src/fhir/participant-lifecycle');
const { CODE_SYSTEMS, EXTENSIONS, IDENTIFIER_SYSTEMS, PROFILES, validateSeedResource } = require('../../shared/pcm-contract');

const THUMBPRINT = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const official = value => [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value }];
const endpointRequest = (status = 'active', address = 'https://new.example/fhir') => ({
    resourceType: 'Endpoint',
    status,
    connectionType: { system: CODE_SYSTEMS.endpointConnectionType, code: 'hl7-fhir-rest' },
    payloadType: [{ coding: [{ system: CODE_SYSTEMS.endpointPayloadType, code: 'any' }] }],
    address
});

function fixture() {
    const ids = ['new-endpoint', 'replacement'];
    const store = new FHIRStore({ idGenerator: () => ids.shift() });
    const source = store.add({
        resourceType: 'Organization', id: 'source', active: true,
        identifier: official('PCM-ORG-SOURCE'),
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: 'source' }] }],
        endpoint: [{ reference: 'Endpoint/old' }]
    });
    const old = store.add({
        resourceType: 'Endpoint', id: 'old', status: 'active',
        connectionType: endpointRequest().connectionType,
        payloadType: endpointRequest().payloadType,
        address: 'https://old.example/fhir',
        managingOrganization: { reference: 'Organization/source' },
        extension: [{
            url: EXTENSIONS.applicableCertificates,
            extension: [{ url: 'thumbprint', valueString: THUMBPRINT }]
        }]
    });
    const other = store.add({
        resourceType: 'Organization', id: 'other', active: true,
        identifier: official('PCM-ORG-OTHER'),
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: 'service-provider' }] }]
    });
    return { store, source, old, other };
}

test('Endpoint create accepts only source-owned active/suspended fixed HTTPS DTO and derives owner/certificates', () => {
    const { store, source, other } = fixture();
    const created = createEndpoint({ store, callerOrganization: source, request: endpointRequest('suspended') });
    assert.equal(created.id, 'new-endpoint');
    assert.equal(created.status, 'suspended');
    assert.equal(created.managingOrganization.reference, 'Organization/source');
    assert.equal(created.extension[0].extension[0].valueString, THUMBPRINT);
    assert.throws(() => createEndpoint({ store, callerOrganization: other, request: endpointRequest() }), error => error.status === 403);
    assert.throws(() => createEndpoint({ store, callerOrganization: source, request: endpointRequest('active') }), error => error.status === 409);

    for (const request of [
        endpointRequest('off'),
        endpointRequest('active', 'http://not-secure.example/fhir'),
        { ...endpointRequest(), connectionType: { system: CODE_SYSTEMS.endpointConnectionType, code: 'ihe-xca' } },
        { ...endpointRequest(), payloadType: [{ coding: [{ system: CODE_SYSTEMS.endpointPayloadType, code: 'any', display: 'not accepted' }] }] },
        { ...endpointRequest(), managingOrganization: { reference: 'Organization/other' } }
    ]) {
        assert.throws(() => validateWriteRequest(request, { resourceType: 'Endpoint', interaction: 'create' }));
    }
    assert.throws(() => createEndpoint({
        store,
        callerOrganization: source,
        request: { ...endpointRequest('active', 'https://managed.example/fhir'), extension: [{ url: EXTENSIONS.applicableCertificates }] }
    }), /PCM-managed/);
});

test('Endpoint transition table permits active/suspended and terminal off with same-state idempotency', () => {
    for (const [from, to, allowed] of [
        ['active', 'active', true], ['active', 'suspended', true], ['active', 'off', true],
        ['suspended', 'active', true], ['suspended', 'suspended', true], ['suspended', 'off', true],
        ['off', 'off', true], ['off', 'active', false], ['off', 'suspended', false]
    ]) {
        const { store, source, old } = fixture();
        const start = store.update({ ...old, status: from });
        if (to === 'off') store.update({ ...source, endpoint: [{ reference: 'Endpoint/replacement' }] });
        const request = { ...endpointRequest(to, start.address), id: 'old' };
        if (allowed) {
            const result = replaceEndpoint({ store, callerOrganization: source, existing: start, request });
            assert.equal(result.status, to, `${from}->${to}`);
            if (from === to) assert.equal(result.meta.versionId, start.meta.versionId, 'same state is idempotent');
        } else {
            assert.throws(() => replaceEndpoint({ store, callerOrganization: source, existing: start, request }), ParticipantLifecycleError, `${from}->${to}`);
        }
    }
});

test('address changes require current suspended state and immediately replace the stored audience', () => {
    const { store, source, old } = fixture();
    assert.throws(() => replaceEndpoint({
        store, callerOrganization: source, existing: old,
        request: { ...endpointRequest('active', 'https://changed.example/fhir'), id: 'old' }
    }), /only while/);
    const suspended = store.update({ ...old, status: 'suspended' });
    const changed = replaceEndpoint({
        store, callerOrganization: source, existing: suspended,
        request: { ...endpointRequest('suspended', 'https://changed.example/fhir'), id: 'old' }
    });
    assert.equal(changed.address, 'https://changed.example/fhir');
    assert.equal(changed.extension[0].extension[0].valueString, THUMBPRINT);
});

test('referenced-off conflict enforces create, validate, relink, activate, retire ordering', () => {
    const { store, source, old } = fixture();
    assert.equal(endpointIsReferenced(store, 'old'), true);
    assert.throws(() => replaceEndpoint({
        store, callerOrganization: source, existing: old,
        request: { ...endpointRequest('off', old.address), id: 'old' }
    }), error => error.status === 409);
    const replacement = createEndpoint({ store, callerOrganization: source, request: endpointRequest('suspended') });
    const linked = store.update({ ...source, endpoint: [{ reference: `Endpoint/${replacement.id}` }] });
    const activeReplacement = replaceEndpoint({
        store, callerOrganization: linked, existing: replacement,
        request: { ...endpointRequest('active'), id: replacement.id }
    });
    assert.equal(activeReplacement.status, 'active');
    const retired = replaceEndpoint({
        store, callerOrganization: linked, existing: old,
        request: { ...endpointRequest('off', old.address), id: 'old' }
    });
    assert.equal(retired.status, 'off');
});

test('duplicate address and same-state retries are deterministic under sequential contention', () => {
    const { store, source, old } = fixture();
    const first = createEndpoint({ store, callerOrganization: source, request: endpointRequest('active') });
    assert.throws(() => createEndpoint({ store, callerOrganization: source, request: endpointRequest('active') }), error => error.status === 409);
    const retry = replaceEndpoint({
        store, callerOrganization: source, existing: first,
        request: { ...endpointRequest('active'), id: first.id }
    });
    assert.deepEqual(retry, first);
    assert.equal(store.getAll('Endpoint').filter(endpoint => endpoint.address === first.address).length, 1);
    assert.equal(store.get('Endpoint', old.id).address, 'https://old.example/fhir');
});

test('all imported Endpoint response examples validate, preserve exact thumbprints, and round-trip', () => {
    const directory = path.resolve(__dirname, '../../../docs/FHIR-examples');
    const files = fs.readdirSync(directory)
        .filter(name => /^Endpoint-.*\.json$/.test(name))
        .filter(name => {
            const resource = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
            return resource.meta?.profile?.some(profile => [PROFILES.endpoint, PROFILES.endpointSystem].includes(profile));
        });
    assert.equal(files.length, 2);
    for (const file of files) {
        const resource = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
        assert.deepEqual(validateSeedResource(resource), [], file);
        for (const extension of resource.extension || []) {
            if (extension.url !== EXTENSIONS.applicableCertificates) continue;
            assert.equal(extension.extension.every(value => /^[A-Za-z0-9_-]{43}$/.test(value.valueString)), true, file);
        }
        const store = new FHIRStore();
        const persisted = store.add(resource);
        assert.deepEqual(store.get('Endpoint', resource.id), persisted, file);
    }
});
