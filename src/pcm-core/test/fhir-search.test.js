require('../../../test-support/team-config').installTestRuntime();
/**
 * Typed PCM FHIR search grammar and authorization-ceiling tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_DIR = process.env.LOG_DIR || '/tmp/pcm-core-search-logs';

const sharedStore = require('../src/fhir/store');
const { FHIRStore } = require('../src/fhir/store');
const router = require('../src/routes/fhir');
const {
    FHIRSearchError,
    INCLUDE_ALLOWLIST,
    SEARCH_PARAMETERS,
    SearchPageCodec,
    executeSearch,
    parseSearch
} = require('../src/fhir/search');

const URLS = {
    certificates: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-applicable-certificates',
    basedOn: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-based-on-canonical-healthcareservice',
    serviceStatus: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-service-business-status',
    consentStatus: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-consent-business-status',
    pcmService: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-pcm-service'
};
const THUMBPRINT = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

test('typed definitions exactly cover the pinned OpenAPI search inventory', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(SEARCH_PARAMETERS).map(([type, definitions]) => [
        type,
        Object.keys(definitions)
    ])), {
        Contract: ['_id', 'identifier', 'status', 'issued', '_lastUpdated'],
        Organization: ['_id', 'identifier', 'active', 'type', 'partof', '_lastUpdated'],
        Endpoint: ['_id', '_lastUpdated', 'thumbprint'],
        HealthcareService: ['_id', 'active', 'identifier', 'service-category', 'service-type', 'name', 'organization', '_tag', 'based-on', 'pcm-business-status', '_lastUpdated'],
        Consent: ['_id', 'identifier', 'status', 'patient', 'patient:identifier', 'pcm-service', 'pcm-business-status', '_lastUpdated']
    });
    assert.deepEqual([...INCLUDE_ALLOWLIST.Organization.direct], ['Organization:endpoint', 'Organization:partof']);
    assert.deepEqual([...INCLUDE_ALLOWLIST.Consent.direct], ['Consent:actor']);
    assert.deepEqual([...INCLUDE_ALLOWLIST.Consent.iterate], ['Organization:endpoint', 'Organization:partof']);
});

function fixtureStore() {
    let instant = Date.parse('2026-01-01T00:00:00.000Z');
    const store = new FHIRStore({
        clock: () => new Date(instant += 24 * 60 * 60 * 1000),
        idGenerator: () => { throw new Error('fixtures provide ids'); }
    });
    store.add({
        resourceType: 'Organization',
        id: 'parent',
        active: true,
        identifier: [{ system: 'urn:org', value: 'parent-business' }],
        type: [{ coding: [{ system: 'urn:org-type', code: 'parent-org' }] }]
    });
    store.add({
        resourceType: 'Organization',
        id: 'org-a',
        active: true,
        identifier: [
            { system: 'urn:org', value: 'alpha' },
            { system: 'urn:other', value: 'second' },
            { value: 'unscoped' }
        ],
        type: [{ coding: [{ system: 'urn:org-type', code: 'service-provider' }] }],
        partOf: { reference: 'Organization/parent' },
        endpoint: [{ reference: 'Endpoint/ep-a' }]
    });
    store.add({
        resourceType: 'Endpoint',
        id: 'ep-a',
        status: 'active',
        managingOrganization: { reference: 'Organization/org-a' },
        extension: [{
            url: URLS.certificates,
            extension: [{ url: 'thumbprint', valueString: THUMBPRINT }]
        }]
    });
    store.add({
        resourceType: 'HealthcareService',
        id: 'catalog',
        active: true,
        identifier: [{ system: 'urn:catalog', value: 'CAT-1' }],
        name: 'Cross Organization Summary',
        category: [{ coding: [{ system: 'urn:category', code: '35' }] }],
        type: [{ coding: [{ system: 'urn:type', code: 'INFA' }] }],
        meta: { tag: [{ system: 'urn:tag', code: 'catalog' }] },
        extension: [{ url: URLS.serviceStatus, valueCoding: { system: 'urn:service-status', code: 'active' } }]
    });
    store.add({
        resourceType: 'HealthcareService',
        id: 'instance',
        active: false,
        providedBy: { reference: 'Organization/org-a' },
        extension: [
            { url: URLS.basedOn, valueReference: { reference: 'HealthcareService/catalog' } },
            { url: URLS.serviceStatus, valueCoding: { system: 'urn:service-status', code: 'suspended' } }
        ]
    });
    store.add({
        resourceType: 'Consent',
        id: 'consent-a',
        identifier: [{ system: 'urn:consent', value: 'CONS-1' }],
        status: 'active',
        patient: {
            reference: 'Patient/local-123',
            identifier: { system: 'urn:patient', value: '123' }
        },
        provision: { actor: [{ reference: { reference: 'Organization/org-a' } }] },
        extension: [
            { url: URLS.pcmService, valueReference: { reference: 'HealthcareService/instance' } },
            { url: URLS.consentStatus, valueCoding: { system: 'urn:consent-status', code: 'approved' } }
        ]
    });
    return store;
}

function ids(store, type, raw) {
    return store.search(type, raw).map(resource => resource.id);
}

test('token grammar supports code, system, system|code, empty-system, OR, and repeated AND', () => {
    const store = fixtureStore();
    assert.deepEqual(ids(store, 'Organization', { identifier: 'alpha' }), ['org-a']);
    assert.deepEqual(ids(store, 'Organization', { identifier: 'urn:org|' }), ['parent', 'org-a']);
    assert.deepEqual(ids(store, 'Organization', { identifier: 'urn:org|alpha' }), ['org-a']);
    assert.deepEqual(ids(store, 'Organization', { identifier: '|unscoped' }), ['org-a']);
    assert.deepEqual(ids(store, 'Organization', { identifier: 'missing,urn:org|alpha' }), ['org-a']);
    assert.deepEqual(ids(store, 'Organization', { identifier: ['urn:org|alpha', 'urn:other|second'] }), ['org-a']);
    assert.deepEqual(ids(store, 'Organization', { identifier: ['urn:org|alpha', 'missing'] }), []);
    assert.throws(() => parseSearch('Organization', { identifier: '|' }), /system or code/);
    assert.throws(() => parseSearch('Organization', { identifier: 'a|b|c' }), /multiple separators/);
    assert.throws(() => parseSearch('Organization', { identifier: 'a,,b' }), /empty OR/);
});

test('every advertised Organization and Endpoint parameter has typed positive and empty-result behavior', () => {
    const store = fixtureStore();
    const organizationCases = {
        _id: ['org-a', 'missing'],
        identifier: ['urn:org|alpha', 'urn:org|missing'],
        active: ['true', 'false'],
        type: ['urn:org-type|service-provider', 'urn:org-type|source'],
        partof: ['Organization/parent', 'Organization/missing'],
        _lastUpdated: ['2026-01-03', 'lt2020']
    };
    for (const [parameter, [positive, empty]] of Object.entries(organizationCases)) {
        assert.equal(ids(store, 'Organization', { [parameter]: positive }).includes('org-a'), true, parameter);
        assert.deepEqual(ids(store, 'Organization', { [parameter]: empty }), [], parameter);
    }
    assert.deepEqual(ids(store, 'Endpoint', { _id: 'ep-a' }), ['ep-a']);
    assert.deepEqual(ids(store, 'Endpoint', { thumbprint: THUMBPRINT }), ['ep-a']);
    assert.deepEqual(ids(store, 'Endpoint', { _lastUpdated: 'ge2026-01-04' }), ['ep-a']);
    assert.deepEqual(ids(store, 'Endpoint', { thumbprint: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }), []);
});

test('every advertised HealthcareService parameter matches its typed source', () => {
    const store = fixtureStore();
    const cases = {
        _id: ['catalog', 'catalog'],
        active: ['true', 'catalog'],
        identifier: ['urn:catalog|CAT-1', 'catalog'],
        'service-category': ['urn:category|35', 'catalog'],
        'service-type': ['INFA', 'catalog'],
        name: ['organization summary', 'catalog'],
        organization: ['Organization/org-a', 'instance'],
        _tag: ['urn:tag|catalog', 'catalog'],
        'based-on': ['HealthcareService/catalog', 'instance'],
        'pcm-business-status': ['urn:service-status|suspended', 'instance'],
        _lastUpdated: ['ge2026-01-05', 'catalog']
    };
    for (const [parameter, [value, expected]] of Object.entries(cases)) {
        assert.equal(ids(store, 'HealthcareService', { [parameter]: value }).includes(expected), true, parameter);
        assert.deepEqual(ids(store, 'HealthcareService', parameter === '_id'
            ? { _id: 'definitely-missing' }
            : { [parameter]: value, _id: 'definitely-missing' }), [], parameter);
    }
});

test('every advertised Consent parameter matches references, identifiers, status, and business state', () => {
    const store = fixtureStore();
    const cases = {
        _id: 'consent-a',
        identifier: 'urn:consent|CONS-1',
        status: 'active',
        patient: 'Patient/local-123',
        'patient:identifier': 'urn:patient|123',
        'pcm-service': 'HealthcareService/instance',
        'pcm-business-status': 'urn:consent-status|approved',
        _lastUpdated: 'ge2026-01-07'
    };
    for (const [parameter, value] of Object.entries(cases)) {
        assert.deepEqual(ids(store, 'Consent', { [parameter]: value }), ['consent-a'], parameter);
        assert.deepEqual(ids(store, 'Consent', parameter === '_id'
            ? { _id: 'definitely-missing' }
            : { [parameter]: value, _id: 'definitely-missing' }), [], parameter);
    }
});

test('date prefixes and precision are deterministic and malformed values fail closed', () => {
    const store = fixtureStore();
    assert.deepEqual(ids(store, 'Organization', { _lastUpdated: 'eq2026' }), ['parent', 'org-a']);
    assert.deepEqual(ids(store, 'Organization', { _lastUpdated: 'ne2026-01-03' }), ['parent']);
    assert.deepEqual(ids(store, 'Organization', { _lastUpdated: 'gt2026-01-02' }), ['org-a']);
    assert.deepEqual(ids(store, 'Organization', { _lastUpdated: 'lt2026-01-03' }), ['parent']);
    assert.deepEqual(ids(store, 'Organization', { _lastUpdated: 'ge2026-01-03' }), ['org-a']);
    assert.deepEqual(ids(store, 'Organization', { _lastUpdated: 'le2026-01-02' }), ['parent']);
    assert.deepEqual(ids(store, 'Organization', { _lastUpdated: 'sa2026-01-02' }), ['org-a']);
    assert.deepEqual(ids(store, 'Organization', { _lastUpdated: 'eb2026-01-03' }), ['parent']);
    assert.equal(ids(store, 'Organization', { _lastUpdated: 'ap2026-01-03' }).includes('org-a'), true);
    for (const value of ['', 'not-a-date', '2026-13', '2026-02-30']) {
        assert.throws(() => parseSearch('Organization', { _lastUpdated: value }), FHIRSearchError);
    }
});

test('malformed values and unsupported controls never broaden a search', () => {
    const malformed = [
        ['Organization', { active: 'yes' }],
        ['Organization', { partof: 'https://outside.example/Organization/1' }],
        ['Endpoint', { thumbprint: 'short' }],
        ['Consent', { patient: 'Patient/' }],
        ['Consent', { _include: 'Consent:organization' }],
        ['Consent', { '_include:iterate': 'Consent:actor' }],
        ['HealthcareService', { _count: '1000' }],
        ['HealthcareService', { unknown: 'ignored-before' }]
    ];
    for (const [type, raw] of malformed) assert.throws(() => parseSearch(type, raw), FHIRSearchError);
    for (const [type, definitions] of Object.entries(SEARCH_PARAMETERS)) {
        for (const name of Object.keys(definitions)) {
            assert.throws(() => parseSearch(type, { [name]: '' }), FHIRSearchError, `${type}.${name}`);
        }
    }
});

test('authorization is applied before total, matching, includes, fullUrl, and opaque paging', () => {
    const store = fixtureStore();
    store.add({
        resourceType: 'Consent',
        id: 'consent-b',
        status: 'active',
        provision: { actor: [{ reference: { reference: 'Organization/org-a' } }] }
    });
    store.add({
        resourceType: 'Consent',
        id: 'consent-forbidden',
        status: 'active',
        provision: { actor: [{ reference: { reference: 'Organization/forbidden' } }] }
    });
    store.add({ resourceType: 'Organization', id: 'forbidden', endpoint: [{ reference: 'Endpoint/forbidden' }] });
    store.add({ resourceType: 'Endpoint', id: 'forbidden' });

    const allowed = new Set(['consent-a', 'consent-b', 'org-a', 'parent', 'ep-a']);
    const authorize = resource => allowed.has(resource.id);
    const codec = new SearchPageCodec('01234567890123456789012345678901');
    const options = {
        store,
        type: 'Consent',
        raw: {
            status: 'active',
            _include: 'Consent:actor',
            '_include:iterate': ['Organization:endpoint', 'Organization:partof']
        },
        authorize,
        baseUrl: 'https://pcm.example/r4',
        callerKey: 'caller-a',
        pageSize: 1,
        pageCodec: codec
    };
    const first = executeSearch(options);
    assert.equal(first.total, 2);
    assert.deepEqual(first.entry.map(entry => entry.resource.id), ['consent-a', 'org-a', 'ep-a', 'parent']);
    assert.equal(first.entry.every(entry => entry.fullUrl.startsWith('https://pcm.example/r4/')), true);
    assert.equal(first.entry[0].search.mode, 'match');
    assert.equal(first.entry.slice(1).every(entry => entry.search.mode === 'include'), true);
    assert.equal(first.entry.some(entry => entry.resource.id === 'forbidden'), false);
    const next = new URL(first.link.find(link => link.relation === 'next').url);
    const second = executeSearch({ ...options, raw: { ...options.raw, _page: next.searchParams.get('_page') } });
    assert.equal(second.total, 2);
    assert.equal(second.entry[0].resource.id, 'consent-b');
    assert.equal(second.link.some(link => link.relation === 'next'), false);
    assert.throws(() => executeSearch({ ...options, callerKey: 'caller-b', raw: { ...options.raw, _page: next.searchParams.get('_page') } }), /caller or query/);
    assert.throws(() => executeSearch({ ...options, raw: { status: 'proposed', _page: next.searchParams.get('_page') } }), /caller or query/);
    const token = next.searchParams.get('_page');
    assert.throws(() => executeSearch({ ...options, raw: { ...options.raw, _page: `${token.slice(0, -1)}x` } }), /Invalid or expired/);
    allowed.delete('consent-b');
    const afterAuthorizationLoss = executeSearch({ ...options, raw: { ...options.raw, _page: token } });
    assert.equal(afterAuthorizationLoss.total, 1);
    assert.deepEqual(afterAuthorizationLoss.entry, []);

    const empty = executeSearch({ ...options, raw: { status: 'proposed' } });
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.entry, []);
    assert.equal(empty.link.length, 1);
});

function responseDouble() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        type() { return this; },
        set() { return this; }
    };
}

test('GET and form POST _search use one authorized query model for every resource', () => {
    sharedStore.clear();
    sharedStore.add({
        resourceType: 'Organization',
        id: 'pcm',
        active: true,
        type: [{ coding: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-org-type', code: 'pcm' }] }]
    });
    sharedStore.add({
        resourceType: 'Organization',
        id: 'child',
        active: true,
        identifier: [{ system: 'urn:org', value: 'child' }]
    });
    sharedStore.add({ resourceType: 'Endpoint', id: 'endpoint', status: 'active' });
    sharedStore.add({ resourceType: 'HealthcareService', id: 'service', active: true });
    sharedStore.add({ resourceType: 'Consent', id: 'consent', status: 'active' });
    const common = {
        user: { client_id: 'client', organization_id: 'pcm' },
        protocol: 'https',
        headers: { host: 'pcm.example' },
        get: () => 'pcm.example'
    };
    for (const [type, query, expected] of [
        ['Organization', { identifier: 'urn:org|child' }, 'child'],
        ['Endpoint', { _id: 'endpoint' }, 'endpoint'],
        ['HealthcareService', { _id: 'service' }, 'service'],
        ['Consent', { _id: 'consent' }, 'consent']
    ]) {
        const getHandler = router.stack.find(layer => layer.route?.path === `/${type}` && layer.route.methods.get).route.stack.at(-1).handle;
        const postHandler = router.stack.find(layer => layer.route?.path === `/${type}/_search` && layer.route.methods.post).route.stack.at(-1).handle;
        const getResponse = responseDouble();
        getHandler({ ...common, method: 'GET', query }, getResponse);
        const postResponse = responseDouble();
        postHandler({ ...common, method: 'POST', body: query }, postResponse);
        assert.deepEqual(postResponse.body, getResponse.body, type);
        assert.equal(getResponse.body.total, 1, type);
        assert.equal(getResponse.body.entry[0].resource.id, expected, type);
    }
});

test('route authorization ceilings prevent cross-organization totals, includes, and errors from leaking resources', () => {
    sharedStore.clear();
    const orgType = code => [{ coding: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-org-type', code }] }];
    sharedStore.add({ resourceType: 'Organization', id: 'sp', active: true, type: orgType('service-provider') });
    sharedStore.add({ resourceType: 'Organization', id: 'other-sp', active: true, type: orgType('service-provider') });
    for (const selected of [true, false]) {
        const suffix = selected ? 'selected' : 'forbidden';
        sharedStore.add({
            resourceType: 'Organization',
            id: `source-${suffix}`,
            active: true,
            type: orgType('source'),
            endpoint: [{ reference: `Endpoint/endpoint-${suffix}` }]
        });
        sharedStore.add({
            resourceType: 'Endpoint',
            id: `endpoint-${suffix}`,
            status: 'active',
            managingOrganization: { reference: `Organization/source-${suffix}` }
        });
    }
    sharedStore.add({
        resourceType: 'Consent',
        id: 'visible-consent',
        status: 'active',
        extension: [{
            url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-consent-business-status',
            valueCoding: { system: 'http://pcm.fhir.health.gov.il/cs/pcm-consent-business-status', code: 'active' }
        }],
        provision: { period: { start: '2020-01-01T00:00:00Z', end: '2030-01-01T00:00:00Z' }, actor: [
            { role: { coding: [{ code: 'IRCP' }] }, reference: { reference: 'Organization/sp' } },
            { role: { coding: [{ code: 'CST' }] }, reference: { reference: 'Organization/source-selected' } }
        ] }
    });
    sharedStore.add({
        resourceType: 'Consent',
        id: 'forbidden-consent',
        status: 'active',
        extension: [{
            url: 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-consent-business-status',
            valueCoding: { system: 'http://pcm.fhir.health.gov.il/cs/pcm-consent-business-status', code: 'active' }
        }],
        provision: { period: { start: '2020-01-01T00:00:00Z', end: '2030-01-01T00:00:00Z' }, actor: [
            { role: { coding: [{ code: 'IRCP' }] }, reference: { reference: 'Organization/other-sp' } },
            { role: { coding: [{ code: 'CST' }] }, reference: { reference: 'Organization/source-forbidden' } }
        ] }
    });
    const common = {
        method: 'GET',
        user: { client_id: 'sp-client', organization_id: 'sp' },
        protocol: 'https',
        headers: { host: 'pcm.example' },
        get: () => 'pcm.example'
    };
    const search = (type, query = {}) => {
        const handler = router.stack.find(layer => layer.route?.path === `/${type}` && layer.route.methods.get).route.stack.at(-1).handle;
        const res = responseDouble();
        handler({ ...common, query }, res);
        return res;
    };

    const consents = search('Consent', {
        _include: 'Consent:actor',
        '_include:iterate': 'Organization:endpoint'
    });
    assert.equal(consents.body.total, 1);
    assert.deepEqual(new Set(consents.body.entry.map(entry => entry.resource.id)), new Set([
        'visible-consent', 'sp', 'source-selected', 'endpoint-selected'
    ]));
    assert.equal(JSON.stringify(consents.body).includes('forbidden'), false);

    const organizations = search('Organization');
    assert.equal(organizations.body.entry.some(entry => entry.resource.id === 'source-forbidden'), false);
    assert.equal(organizations.body.total, organizations.body.entry.filter(entry => entry.search.mode === 'match').length);
    const endpoints = search('Endpoint');
    assert.deepEqual(endpoints.body.entry.map(entry => entry.resource.id), ['endpoint-selected']);

    const invalid = search('Consent', { unsupported: 'source-forbidden' });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.body.resourceType, 'OperationOutcome');
    assert.equal(JSON.stringify(invalid.body).includes('forbidden-consent'), false);
});
