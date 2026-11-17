require('../../../test-support/team-config').installTestRuntime();
/**
 * Common FHIR routing, DTO, persistence, and response contract tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LOG_DIR = process.env.LOG_DIR || '/tmp/pcm-core-test-logs';

const router = require('../src/routes/fhir');
const logger = require('../src/logger');
const sharedStore = require('../src/fhir/store');
const {
    FHIRStore,
    FHIRStoreError
} = require('../src/fhir/store');
const {
    FHIRContractError,
    FHIR_ROUTE_DEFINITIONS,
    operationOutcome,
    sendOutcome,
    sendResource,
    validateWriteRequest
} = require('../src/fhir/contract');

const EXPECTED_ROUTES = [
    ['/.well-known/smart-configuration', ['get']],
    ['/metadata', ['get']],
    ['/Organization', ['get', 'post']],
    ['/Organization/_search', ['post']],
    ['/Organization/:id', ['get', 'head', 'put']],
    ['/Endpoint', ['get', 'post']],
    ['/Endpoint/_search', ['post']],
    ['/Endpoint/:id', ['get', 'head', 'put']],
    ['/HealthcareService', ['get', 'post']],
    ['/HealthcareService/_search', ['post']],
    ['/HealthcareService/:id/$request-catalog-update', ['post']],
    ['/HealthcareService/:id', ['get', 'head', 'put']],
    ['/Consent', ['get', 'post']],
    ['/Consent/_search', ['post']],
    ['/Consent/:id', ['get', 'head', 'put']],
    ['/Contract', ['get']],
    ['/Contract/_search', ['post']],
    ['/Contract/:id', ['get', 'head']]
];

test('PCM FHIR bearer authorization accepts only active exact-audience management tokens', () => {
    const now = 1000;
    const audience = 'https://pcm.example/r4';
    const valid = { kind: 'management', active: true, aud: audience, exp: now + 30 };

    assert.equal(router._test.isPcmFhirToken(valid, audience, now), true);
    assert.equal(router._test.isPcmFhirToken({ ...valid, kind: 'data_source_access' }, audience, now), false);
    assert.equal(router._test.isPcmFhirToken({ ...valid, aud: 'https://source.example/fhir' }, audience, now), false);
    assert.equal(router._test.isPcmFhirToken({ ...valid, exp: now - 1 }, audience, now), false);
});

function runtimeInventory() {
    const inventory = new Map();
    for (const layer of router.stack.filter(item => item.route)) {
        const routePath = typeof layer.route.path === 'string'
            ? layer.route.path.replace('\\$', '$')
            : layer.route.path;
        const methods = inventory.get(routePath) || new Set();
        Object.keys(layer.route.methods).forEach(method => methods.add(method));
        inventory.set(routePath, methods);
    }
    return Array.from(inventory, ([path, methods]) => [path, Array.from(methods).sort()]);
}

function responseDouble() {
    return {
        statusCode: 200,
        headers: {},
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        type(value) { this.headers['content-type'] = value; return this; },
        set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
        json(body) { this.body = body; return this; },
        end() { this.ended = true; return this; }
    };
}

test('runtime and shared route inventories equal the 18-path, 31-operation OpenAPI contract', () => {
    assert.deepEqual(runtimeInventory().sort(), [...EXPECTED_ROUTES].sort());
    assert.deepEqual(
        FHIR_ROUTE_DEFINITIONS.map(({ path, methods }) => [path, [...methods].sort()]).sort(),
        [...EXPECTED_ROUTES].sort()
    );
    assert.equal(EXPECTED_ROUTES.length, 18);
    assert.equal(EXPECTED_ROUTES.reduce((total, [, methods]) => total + methods.length, 0), 31);
    assert.equal(EXPECTED_ROUTES.some(([path]) => /VerificationResult|Subscription/.test(path)), false);
});

test('CapabilityStatement resource interaction and operation inventory matches runtime routes', () => {
    const capability = JSON.parse(fs.readFileSync(path.resolve(
        __dirname,
        '../../../docs/FHIR-examples/CapabilityStatement-pcm-capabilitystatement.json'
    ), 'utf8'));
    const resources = Object.fromEntries(capability.rest[0].resource.map(resource => [resource.type, resource]));
    for (const type of ['Organization', 'Endpoint', 'HealthcareService', 'Consent', 'Contract']) {
        const runtime = new Set();
        const typePath = EXPECTED_ROUTES.find(([route]) => route === `/${type}`)?.[1] || [];
        const readPath = EXPECTED_ROUTES.find(([route]) => route === `/${type}/:id`)?.[1] || [];
        if (typePath.includes('get')) runtime.add('search-type');
        if (typePath.includes('post')) runtime.add('create');
        if (readPath.includes('get')) runtime.add('read');
        if (readPath.includes('put')) runtime.add('update');
        assert.deepEqual(
            new Set(resources[type].interaction.map(interaction => interaction.code)),
            runtime,
            `${type} interactions drifted`
        );
    }
    assert.deepEqual(
        resources.HealthcareService.operation.map(operation => operation.name),
        ['request-catalog-update']
    );
});

test('store clones boundaries and owns create id, version, and lastUpdated metadata', () => {
    const instants = [new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:01:00.000Z')];
    const store = new FHIRStore({ clock: () => instants.shift(), idGenerator: () => 'server-id' });
    const submitted = { resourceType: 'Organization', id: 'client-id', meta: { profile: ['urn:request'] }, name: 'A' };
    const created = store.create(submitted);

    assert.equal(submitted.id, 'client-id');
    assert.equal(created.id, 'server-id');
    assert.deepEqual(created.meta, {
        profile: ['urn:request'],
        versionId: '1',
        lastUpdated: '2026-01-01T00:00:00.000Z'
    });
    created.name = 'mutated outside';
    assert.equal(store.get('Organization', 'server-id').name, 'A');

    const read = store.get('Organization', 'server-id');
    read.name = 'also outside';
    assert.equal(store.get('Organization', 'server-id').name, 'A');

    const replaced = store.update({ resourceType: 'Organization', id: 'server-id', name: 'B' });
    assert.equal(replaced.meta.versionId, '2');
    assert.equal(replaced.meta.lastUpdated, '2026-01-01T00:01:00.000Z');
    assert.equal(replaced.meta.profile, undefined, 'omitted fields are removed by replacement');
});

test('failed validation and coupled transactions leave the store unchanged', () => {
    const store = new FHIRStore({ idGenerator: () => 'new-id' });
    store.add({ resourceType: 'Organization', id: 'existing', name: 'Before' });
    const before = store.get('Organization', 'existing');

    assert.throws(() => store.update(
        { resourceType: 'Organization', id: 'existing', name: 'After' },
        () => { throw new Error('candidate invalid'); }
    ), /candidate invalid/);
    assert.deepEqual(store.get('Organization', 'existing'), before);

    assert.throws(() => store.transaction(() => {
        store.add({ resourceType: 'Endpoint', id: 'temporary', status: 'active' });
        throw new Error('coupled failure');
    }), /coupled failure/);
    assert.equal(store.get('Endpoint', 'temporary'), null);
    assert.throws(() => store.update({ resourceType: 'Endpoint', id: 'missing' }), /Resource not found/);

    const collisions = new FHIRStore({ idGenerator: () => 'same-id' });
    collisions.create({ resourceType: 'Endpoint', status: 'active' });
    assert.throws(
        () => collisions.create({ resourceType: 'Endpoint', status: 'suspended' }),
        error => error instanceof FHIRStoreError && error.status === 409
    );
    assert.equal(collisions.get('Endpoint', 'same-id').status, 'active');
});

test('closed write validation covers metadata, ids, profiles, extensions, and unknown fields', () => {
    const base = {
        resourceType: 'Endpoint',
        status: 'active',
        connectionType: { system: 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type', code: 'hl7-fhir-rest' },
        payloadType: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/endpoint-payload-type', code: 'any' }] }],
        address: 'https://ds.example/fhir'
    };
    assert.doesNotThrow(() => validateWriteRequest({ ...base, id: 'ignored' }, { resourceType: 'Endpoint', interaction: 'create' }));
    assert.doesNotThrow(() => validateWriteRequest({ ...base, meta: { profile: ['urn:any'] } }, { resourceType: 'Endpoint', interaction: 'create' }));
    assert.doesNotThrow(() => validateWriteRequest({ ...base, extension: [{ url: 'urn:ordinary', valueString: 'accepted' }] }, { resourceType: 'Endpoint', interaction: 'create' }));
    assert.throws(() => validateWriteRequest({ ...base, meta: { versionId: '4' } }, { resourceType: 'Endpoint', interaction: 'create' }), /prohibited/);
    assert.throws(() => validateWriteRequest({ ...base, modifierExtension: [] }, { resourceType: 'Endpoint', interaction: 'create' }), /Unsupported Endpoint field/);
    assert.throws(() => validateWriteRequest({ ...base, extension: [{ url: 'urn:x', modifierExtension: [] }] }, { resourceType: 'Endpoint', interaction: 'create' }), /modifierExtension/);
    assert.throws(() => validateWriteRequest({ ...base, managingOrganization: {} }, { resourceType: 'Endpoint', interaction: 'create' }), /Unsupported Endpoint field/);
    assert.throws(() => validateWriteRequest({ ...base }, { resourceType: 'Endpoint', interaction: 'update', id: 'ep-1' }), /required Endpoint field\(s\): id/);
    assert.throws(() => validateWriteRequest({ ...base, id: 'ep-2' }, { resourceType: 'Endpoint', interaction: 'update', id: 'ep-1' }), /must match/);
});

test('every create and update interaction has an independently selectable closed DTO', () => {
    const endpoint = {
        resourceType: 'Endpoint',
        status: 'active',
        connectionType: { system: 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type', code: 'hl7-fhir-rest' },
        payloadType: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/endpoint-payload-type', code: 'any' }] }],
        address: 'https://ds.example/fhir'
    };
    const consentFixed = {
        scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'patient-privacy' }] },
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'INFA' }] }],
        policy: [{ authority: 'https://www.gov.il/', uri: 'https://pcm.fhir.health.gov.il/consent-policy/medical-information-mobility-law-2024' }]
    };
    const cases = [
        ['Organization', 'create', undefined, { resourceType: 'Organization', name: 'Child' }],
        ['Organization', 'update', 'org-1', { resourceType: 'Organization', id: 'org-1', name: 'Unchanged' }],
        ['Endpoint', 'create', undefined, endpoint],
        ['Endpoint', 'update', 'ep-1', { ...endpoint, id: 'ep-1', status: 'suspended' }],
        ['HealthcareService', 'create', undefined, {
            resourceType: 'HealthcareService',
            extension: [{
                url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-based-on-canonical-healthcareservice',
                valueReference: { reference: 'HealthcareService/catalog' }
            }]
        }],
        ['HealthcareService', 'update', 'svc-1', {
            resourceType: 'HealthcareService',
            id: 'svc-1',
            extension: [{
                url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-service-business-status',
                valueCoding: {
                    system: 'http://pcm.fhir.health.gov.il/cs/pcm-service-business-status',
                    code: 'suspended'
                }
            }]
        }],
        ['Consent', 'create', undefined, {
            resourceType: 'Consent',
            status: 'proposed',
            ...consentFixed,
            patient: { identifier: { system: 'urn:patient', value: '123' } },
            extension: [{ url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-pcm-service', valueReference: { reference: 'HealthcareService/svc-1' } }]
        }],
        ['Consent', 'update', 'consent-1', {
            resourceType: 'Consent',
            id: 'consent-1',
            status: 'inactive',
            ...consentFixed
        }]
    ];
    for (const [resourceType, interaction, id, body] of cases) {
        assert.doesNotThrow(
            () => validateWriteRequest(body, { resourceType, interaction, id }),
            `${resourceType}.${interaction}`
        );
    }
    assert.throws(() => validateWriteRequest(
        { ...cases.at(-1)[3], status: 'active' },
        { resourceType: 'Consent', interaction: 'update', id: 'consent-1' }
    ), /must be inactive/);
});

test('FHIR success and failure helpers emit authoritative metadata and OperationOutcome', () => {
    const req = { protocol: 'https', get: () => 'pcm.example' };
    const res = responseDouble();
    const resource = {
        resourceType: 'Organization',
        id: 'org-1',
        meta: { versionId: '7', lastUpdated: '2026-01-01T00:00:00.000Z' }
    };
    sendResource(req, res, resource, { status: 201, created: true });
    assert.equal(res.statusCode, 201);
    assert.equal(res.headers.location, 'https://pcm.example/r4/Organization/org-1');
    assert.equal(res.headers['content-location'], res.headers.location);
    assert.equal(res.headers.etag, 'W/"7"');
    assert.equal(res.headers['last-modified'], 'Thu, 01 Jan 2026 00:00:00 GMT');
    assert.equal(operationOutcome('no', 'forbidden').resourceType, 'OperationOutcome');
    assert.throws(() => { throw new FHIRContractError('closed'); }, /closed/);
});

test('HEAD uses the read decision and headers while stripping only the body', () => {
    sharedStore.clear();
    sharedStore.add({
        resourceType: 'Organization',
        id: 'pcm',
        active: true,
        type: [{ coding: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-org-type', code: 'pcm' }] }]
    });
    sharedStore.add({ resourceType: 'Organization', id: 'target', active: true, name: 'Target' });
    const request = {
        params: { id: 'target' },
        user: { organization_id: 'pcm' },
        protocol: 'https',
        headers: { host: 'pcm.example' },
        get: () => 'pcm.example'
    };
    const getLayer = router.stack.find(layer => layer.route?.path === '/Organization/:id' && layer.route.methods.get);
    const headLayer = router.stack.find(layer => layer.route?.path === '/Organization/:id' && layer.route.methods.head);
    const getResponse = responseDouble();
    const headResponse = responseDouble();
    getLayer.route.stack.at(-1).handle(request, getResponse);
    headLayer.route.stack.at(-1).handle(request, headResponse);
    assert.equal(headResponse.statusCode, getResponse.statusCode);
    assert.deepEqual(headResponse.headers, getResponse.headers);
    assert.equal(headResponse.body, undefined);
    assert.equal(headResponse.ended, true);
});

test('unsupported interactions and all declared error statuses return OperationOutcome without mutation', () => {
    const fallback = [...router.stack].reverse().find(layer => !layer.route && layer.handle.length === 2).handle;
    const before = sharedStore.getAll('Organization');
    for (const [method, path] of [
        ['PATCH', '/Organization/target'],
        ['DELETE', '/Consent/c-1'],
        ['POST', '/'],
        ['POST', '/register'],
        ['POST', '/Subscription'],
        ['GET', '/VerificationResult'],
        ['GET', '/.well-known/jwks.json']
    ]) {
        const res = responseDouble();
        fallback({ method, path }, res);
        assert.equal(res.statusCode, 405);
        assert.equal(res.body.resourceType, 'OperationOutcome');
    }
    assert.deepEqual(sharedStore.getAll('Organization'), before);

    for (const status of [400, 401, 403, 404, 409, 422]) {
        const res = responseDouble();
        sendOutcome(res, status, 'closed failure');
        assert.equal(res.statusCode, status);
        assert.equal(res.body.resourceType, 'OperationOutcome');
    }
});

test('If-Match is rejected before update business logic', () => {
    const layer = router.stack.find(item => item.route?.path === '/Endpoint/:id' && item.route.methods.put);
    const validator = layer.route.stack[0].handle;
    const res = responseDouble();
    let nextCalled = false;
    validator({ headers: { 'if-match': 'W/"1"' }, body: {}, params: { id: 'ep-1' } }, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.resourceType, 'OperationOutcome');
});

test('catalog-update operation accepts only a closed non-material proposal and never mutates live catalog', () => {
    sharedStore.clear();
    sharedStore.add({
        resourceType: 'Organization', id: 'parent', active: true,
        identifier: [{ use: 'official', system: 'http://pcm.fhir.health.gov.il/identifier/pcm-organization-id', value: 'PCM-PARENT' }],
        type: [{ coding: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-org-type', code: 'parent-org' }] }]
    });
    sharedStore.add({
        resourceType: 'Organization', id: 'sp', active: true,
        identifier: [{ use: 'official', system: 'http://pcm.fhir.health.gov.il/identifier/pcm-organization-id', value: 'PCM-SP' }],
        partOf: { reference: 'Organization/parent' },
        type: [{ coding: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-org-type', code: 'service-provider' }] }]
    });
    const canonical = sharedStore.add(JSON.parse(fs.readFileSync(path.resolve(
        __dirname, '../../../docs/FHIR-examples/HealthcareService-svc-catalog-cross-org-summary.json'
    ), 'utf8')));
    const handler = router.stack.find(layer =>
        String(layer.route?.path).replace('\\$', '$') === '/HealthcareService/:id/$request-catalog-update'
    ).route.stack.at(-1).handle;
    const operation = JSON.parse(fs.readFileSync(path.resolve(
        __dirname, '../../../docs/FHIR-examples/Parameters-parameters-request-catalog-update-cross-org-summary.json'
    ), 'utf8'));
    const request = {
        params: { id: canonical.id },
        user: { organization_id: 'sp' },
        body: operation
    };
    let res = responseDouble();
    handler(request, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.resourceType, 'Parameters');
    assert.equal(sharedStore.get('HealthcareService', canonical.id).name, canonical.name);

    res = responseDouble();
    const material = JSON.parse(JSON.stringify(request));
    material.body.parameter[0].resource.category = [{ coding: [{ code: '99' }] }];
    handler(material, res);
    assert.equal(res.statusCode, 422);
    assert.equal(res.body.resourceType, 'OperationOutcome');

    res = responseDouble();
    const malformed = JSON.parse(JSON.stringify(request));
    malformed.body.parameter.find(parameter => parameter.name === 'proposedCatalog').resource.id = 'other';
    handler(malformed, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.resourceType, 'OperationOutcome');
});

test('FHIR body-parser and uncaught failures remain OperationOutcome responses', () => {
    for (const status of [400, 500]) {
        const res = responseDouble();
        logger.errorLogger(
            Object.assign(new Error('sensitive parser detail'), { status }),
            { method: 'POST', originalUrl: '/api/fhir-service/r4/Consent', get: () => undefined },
            res,
            () => assert.fail('error should be handled')
        );
        assert.equal(res.statusCode, status);
        assert.equal(res.body.resourceType, 'OperationOutcome');
        assert.doesNotMatch(res.body.issue[0].diagnostics, /sensitive parser detail/);
    }
});
