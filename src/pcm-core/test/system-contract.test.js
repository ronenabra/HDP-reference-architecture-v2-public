'use strict';

/** Public-profile-bound normative grant lifecycle and pure retained-conversion regression coverage. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { FHIRStore } = require('../src/fhir/store');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { buildSeedResources } = require('../src/bootstrap');
const { syncDataSourcesToStore } = require('../src/data-sources');
const { buildSystemPolicies, provisionSystemPolicies, validatePolicy, evaluatePolicy, timestamp,
    updatePolicy, transitionPolicy, revokeWorkflow } = require('../src/fhir/system-policy');
const { SYSTEM_PROFILE, PROHIBITED, convertLegacySystemContract } = require('../src/fhir/system-contract');
const { CODE_SYSTEMS } = require('../../shared/pcm-contract');
const root = '../../../.contract-inputs/profiles/';
const candidate = require(`${root}StructureDefinition-pcm-system-authorization-contract.json`);
const base = require(`${root}StructureDefinition-pcm-data-access-authorization-contract.json`);
const NOW = Date.parse('2026-10-18T12:00:00Z') / 1000;

/** Create independent source, parent and Endpoint state before provisioning explicit membership. */
function fixture() {
    const config = buildTeamConfig();
    config.systemAuthorization.participatingHmos = config.healthOrganizations.map(source => source.id);
    const store = new FHIRStore();
    for (const resource of buildSeedResources(config)) store.add(resource);
    syncDataSourcesToStore(store, config, 'A'.repeat(43));
    provisionSystemPolicies(store, config, NOW);
    const contract = store.get('Contract', 'policy-presence');
    const targetOrganizationId = config.healthOrganizations[0].dataSourceOrganization.id;
    const request = { store, config, identifier: contract.identifier[0], clientId: config.oauthClients.presenceOrchestrator.clientId, targetOrganizationId, now: NOW };
    return { config, store, contract, request };
}

/** Assert the public differential's applicable cardinalities using existing repeated parents. */
function assertCardinalities(resource, definition) {
    for (const element of definition.differential.element) {
        if (element.id.includes(':') || element.path.includes('[x]') || element.path === 'Contract') continue;
        const parts = element.path.split('.').slice(1);
        let parents = [resource];
        for (const part of parts.slice(0, -1)) parents = parents.flatMap(parent => parent?.[part] || []);
        for (const parent of parents) {
            const field = parent[parts.at(-1)];
            const count = field === undefined ? 0 : Array.isArray(field) ? field.length : 1;
            if (element.min !== undefined) assert.ok(count >= element.min, element.path);
            if (element.max !== undefined && element.max !== '*') assert.ok(count <= Number(element.max), element.path);
        }
    }
}

test('all three generated grants match candidate base/concrete cardinalities, fixed type and lifecycle binding', () => {
    const { config, store } = fixture();
    const status = require(`${root}ValueSet-pcm-authorization-status.json`);
    const statuses = status.compose.include.flatMap(item => item.concept.map(concept => concept.code));
    assert.equal(base.abstract, true);
    assert.equal(candidate.baseDefinition, base.url);
    for (const contract of buildSystemPolicies(config, NOW)) {
        assert.equal(contract.meta.profile[0], candidate.url);
        assert.ok(statuses.includes(contract.status));
        assertCardinalities(contract, base); assertCardinalities(contract, candidate);
        assert.equal(validatePolicy(store, contract, config.organizations.pcm.id).service, undefined);
        assert.equal(contract.type.coding[0].code, base.differential.element.find(item => item.path === 'Contract.type').patternCodeableConcept.coding[0].code);
    }
    assert.deepEqual(Object.entries(PROHIBITED).flatMap(([path, fields]) => fields.map(field => `${path}.${field}`)).sort(),
        candidate.differential.element.filter(element => element.max === '0').map(element => element.path).sort());
});

test('every concrete-profile prohibited path is rejected, including primitive metadata forms', () => {
    const { contract, config, store } = fixture();
    for (const [path, fields] of Object.entries(PROHIBITED)) for (const field of fields) {
        for (const prefix of ['', '_']) {
            const changed = structuredClone(contract);
            let parent = changed;
            for (const part of path.split('.').slice(1)) {
                parent = Array.isArray(parent[part]) ? parent[part][0] : parent[part];
            }
            parent[`${prefix}${field.replace('[x]', 'Reference')}`] = {};
            assert.throws(() => validatePolicy(store, changed, config.organizations.pcm.id), /Prohibited/, `${path}.${field}`);
        }
    }
});

test('allowed Element, Coding, Reference and primitive metadata survive validation', () => {
    const { contract, config, store } = fixture();
    const metadata = [{ url: 'urn:operator:annotation', valueString: 'reviewed' }];
    contract._title = { extension: metadata };
    contract.instantiatesUri = 'https://policy.example/arrangement';
    contract.type.id = 'type'; contract.type.text = 'Informational label';
    contract.type.coding[0].display = 'Authorization';
    contract.type.coding[0].extension = metadata;
    contract.term[0].id = 'term'; contract.term[0].extension = metadata;
    contract.term[0].offer.party[0].reference[0].display = 'PCM';
    contract.term[0].asset[0].context[0].reference.display = 'Source';
    contract.term[0].asset[0].context[0].reference.extension = metadata;
    assert.ok(validatePolicy(store, contract, config.organizations.pcm.id));
});

test('missing bindings, unknown workflows, multiple recipients and malformed/duplicate/foreign source refs fail', () => {
    const { contract, config, store } = fixture();
    const invalid = [
        value => delete value.type,
        value => value.type.coding[0].system = 'urn:foreign',
        value => value.type.coding.push({ system: 'urn:extra', code: 'extra' }),
        value => value.subType[0].coding[0].code = 'unknown',
        value => value.subType[0].coding[0].code = 'constructor',
        value => value.term[0].offer.party.push(structuredClone(value.term[0].offer.party[0])),
        value => value.term[0].offer.party[0].reference.push({ reference: 'Organization/other' }),
        value => value.term[0].asset.push(structuredClone(value.term[0].asset[0])),
        value => value.term[0].asset[0].context[0].reference.reference = 'Organization/missing',
        value => value.term[0].asset[0].context[0].reference.reference = `Organization/${config.organizations.serviceProvider.id}`,
        value => value.term[0].asset[0].context[0].reference.reference = 'https://foreign/Organization/source',
        value => value.term[0].asset[0].context[0].reference.reference = 'Organization/source/_history/1',
        value => value.term[0].asset[0].context[0].reference.identifier = { system: 'urn:alias', value: 'x' },
        value => value.term[0].asset[0].context.push(structuredClone(value.term[0].asset[0].context[0])),
        value => delete value.title,
        value => value.title = ' ',
        value => delete value.term[0].text,
        value => delete value.extension,
        value => value.extension.push({ url: 'urn:foreign', valueString: 'not allowed' }),
        value => value.meta.profile = [],
        value => value.identifier.push(structuredClone(value.identifier[0])),
        value => value.identifier = { length: 1, 0: value.identifier[0] },
        value => value.type.coding = { length: 1, 0: value.type.coding[0] },
        value => value.term[0].offer.party = { length: 1, 0: value.term[0].offer.party[0] },
        value => value.term[0].asset[0].context = { length: 1, 0: value.term[0].asset[0].context[0] }
    ];
    for (const mutate of invalid) {
        const changed = structuredClone(contract); mutate(changed);
        assert.throws(() => validatePolicy(store, changed, config.organizations.pcm.id));
    }
    const pcm = store.get('Organization', config.organizations.pcm.id);
    store.update({ ...pcm, type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: 'service-provider' }] }] });
    assert.throws(() => validatePolicy(store, contract, config.organizations.pcm.id), /ownership/);
});

test('Contract period uses inclusive instants, optional end, fractional seconds and timezone offsets', () => {
    const { contract, config, store, request } = fixture();
    contract.applies = { start: '2026-10-18T15:00:00.125+03:00', end: '2026-10-18T12:00:01.625Z' };
    store.add(contract);
    for (const [now, allowed] of [[NOW + 0.124, false], [NOW + 0.125, true], [NOW + 1.625, true], [NOW + 1.626, false]]) {
        assert.equal(Boolean(evaluatePolicy({ ...request, now })), allowed);
    }
    delete contract.applies.end; store.add(contract);
    assert.equal(validatePolicy(store, contract, config.organizations.pcm.id).end, Infinity);
    assert.ok(evaluatePolicy({ ...request, now: NOW + 1e9 }));
    assert.equal(timestamp('2026-10-18T12:00:00.123456Z'), NOW + 0.123456);
    for (const invalid of ['2026-10-18', '2026-10-18T12:00Z', '2026-10-18T12:00:00', '2026-02-30T12:00:00Z',
        '2026-13-01T12:00:00Z', '2026-10-18T24:00:00Z', '2026-10-18T12:00:60Z', '2026-10-18T12:00:00+15:00', '2026-10-18T12:00:00+14:01']) assert.throws(() => timestamp(invalid));
    for (const end of [contract.applies.start, '2026-10-18T11:59:00Z']) assert.throws(() => validatePolicy(store,
        { ...contract, applies: { ...contract.applies, end } }, config.organizations.pcm.id), /interval/);
});

test('source additions/removals and shortened validity preserve identity; extension or immutable changes require replacement', () => {
    const { contract, config, store, request } = fixture();
    const ids = contract.identifier;
    const changed = structuredClone(contract);
    changed.term[0].asset = [];
    const removed = updatePolicy(store, changed, config);
    assert.deepEqual(removed.identifier, ids); assert.equal(removed.id, contract.id);
    assert.equal(evaluatePolicy(request), null);
    const added = updatePolicy(store, contract, config);
    assert.deepEqual(added.identifier, ids); assert.ok(evaluatePolicy(request));
    const shortened = { ...added, applies: { ...added.applies, end: new Date((NOW + 60) * 1000).toISOString() } };
    updatePolicy(store, shortened, config);
    for (const mutate of [value => value.identifier[0].value = 'replacement', value => value.subType[0].coding[0].code = 'patient-authentication',
        value => value.applies.start = new Date((NOW - 1) * 1000).toISOString(), value => delete value.applies.end,
        value => value.applies.end = new Date((NOW + 61) * 1000).toISOString(), value => value.author.reference = 'Organization/other',
        value => value.term[0].offer.party[0].reference[0].reference = `Organization/${config.organizations.serviceProvider.id}`]) {
        const invalid = structuredClone(shortened); mutate(invalid);
        const before = store.get('Contract', contract.id);
        assert.throws(() => updatePolicy(store, invalid, config));
        assert.deepEqual(store.get('Contract', contract.id), before);
    }
    assert.ok(evaluatePolicy({ ...request, now: NOW + 60 }));
    assert.equal(evaluatePolicy({ ...request, now: NOW + 60.001 }), null);
});

test('source/parent/Endpoint suspension denies without rewriting lifecycle; terminal states never reactivate', () => {
    const { contract, config, store, request } = fixture();
    const source = store.get('Organization', request.targetOrganizationId);
    const parent = store.get('Organization', source.partOf.reference.slice('Organization/'.length));
    const endpoint = store.get('Endpoint', source.endpoint[0].reference.slice('Endpoint/'.length));
    for (const [resource, field, value] of [[source, 'active', false], [parent, 'active', false], [endpoint, 'status', 'suspended']]) {
        store.add({ ...resource, [field]: value });
        assert.equal(evaluatePolicy(request), null);
        assert.equal(store.get('Contract', contract.id).status, 'executed');
        store.add(resource); assert.ok(evaluatePolicy(request));
    }
    for (const status of ['terminated', 'revoked', 'entered-in-error']) {
        const local = fixture();
        transitionPolicy(local.store, local.contract.id, status, local.config);
        assert.equal(evaluatePolicy(local.request), null);
        for (const next of ['executed', ...['terminated', 'revoked', 'entered-in-error']]) assert.throws(() => transitionPolicy(local.store, local.contract.id, next, local.config), /terminal/);
    }
    delete contract.applies.end;
    store.add(contract);
    assert.throws(() => transitionPolicy(store, contract.id, 'terminated', config), /lifecycle/);
    assert.equal(revokeWorkflow(store, 'presence-check', config).length, 1);
    assert.equal(store.get('Contract', contract.id).status, 'revoked');
    assert.equal(revokeWorkflow(store, 'presence-check', config).length, 0);
    assert.throws(() => revokeWorkflow(store, 'unknown', config));
    assert.throws(() => revokeWorkflow(store, 'constructor', config));
    assert.equal(evaluatePolicy({ ...request, identifier: null }), null);
});

test('catalog reconciliation preserves source removals, shortened validity and terminal state', () => {
    const { store, config, contract } = fixture();
    const { previewCatalog, reconcileCatalog } = require('../src/catalog-bootstrap');
    contract.term[0].asset = [];
    contract.applies.end = new Date((NOW + 60) * 1000).toISOString();
    updatePolicy(store, contract, config);
    transitionPolicy(store, contract.id, 'revoked', config);
    const proposed = buildSystemPolicies(config, NOW + 30);
    reconcileCatalog(store, proposed, previewCatalog(store, proposed).versions, () => {});
    const current = store.get('Contract', contract.id);
    assert.equal(current.status, 'revoked'); assert.deepEqual(current.applies, contract.applies);
    assert.deepEqual(current.term[0].asset, []); assert.deepEqual(current.identifier, contract.identifier);
});

test('pure legacy conversion preserves known grant meaning/identity/dates/terminals and rejects sampling or suspension ambiguity', () => {
    const { store, config } = fixture();
    const oldFiles = ['presence', 'patient-authentication', 'dependent-discovery'];
    for (const suffix of oldFiles) {
        const contract = structuredClone(require(`${root}0.4.0/fhir/resources/Contract-policy-${suffix}.json`));
        const service = structuredClone(require(`${root}0.4.0/fhir/resources/HealthcareService-system-service-${suffix}.json`));
        const owner = `Organization/${config.organizations.pcm.id}`;
        contract.author.reference = owner; contract.term[0].offer.party[0].reference[0].reference = owner;
        service.providedBy.reference = owner;
        const sourceOrganizationIds = [config.healthOrganizations[0].dataSourceOrganization.id];
        const input = { store, contract, service, pcmOrganizationId: config.organizations.pcm.id, sourceOrganizationIds };
        const before = JSON.stringify({ contract, service, state: store.getAll('Contract') });
        const result = convertLegacySystemContract(input);
        assert.equal(result.status, 'executed'); assert.equal(result.id, contract.id);
        assert.deepEqual(result.identifier, contract.identifier); assert.deepEqual(result.applies, contract.applies);
        assert.equal(result.issued, contract.issued); assert.equal(result.meta.profile[0], SYSTEM_PROFILE);
        assert.equal(result.topicReference, undefined); assert.equal(result.term[0].action, undefined);
        assert.equal(JSON.stringify({ contract, service, state: store.getAll('Contract') }), before);
        for (const status of ['terminated', 'revoked', 'entered-in-error']) {
            assert.equal(convertLegacySystemContract({ ...input, contract: { ...contract, status } }).status, status);
        }
        assert.deepEqual(convertLegacySystemContract({ ...input, sourceOrganizationIds: [] }).term[0].asset, []);
        assert.throws(() => convertLegacySystemContract({ ...input, sourceOrganizationIds: [...sourceOrganizationIds, ...sourceOrganizationIds] }), /Duplicate/);
        assert.throws(() => convertLegacySystemContract({ ...input, service: { ...service, active: false } }), /suspended/);
        assert.throws(() => convertLegacySystemContract({ ...input, contract: { ...contract, status: 'draft' } }), /Unsupported/);
        assert.throws(() => convertLegacySystemContract({ ...input, contract: { ...contract, subType: [] } }), /Unsupported/);
    }
});

/** Bind a vendored legacy pair to the independent local store without persisting it. */
function legacyConversionFixture() {
    const { store, config } = fixture();
    const contract = structuredClone(require(`${root}0.4.0/fhir/resources/Contract-policy-presence.json`));
    const service = structuredClone(require(`${root}0.4.0/fhir/resources/HealthcareService-system-service-presence.json`));
    const owner = `Organization/${config.organizations.pcm.id}`;
    contract.author.reference = owner; contract.term[0].offer.party[0].reference[0].reference = owner;
    service.providedBy.reference = owner;
    return { store, contract, service, pcmOrganizationId: config.organizations.pcm.id,
        sourceOrganizationIds: [config.healthOrganizations[0].dataSourceOrganization.id] };
}

test('legacy conversion rejects every profile-prohibited field before removal, including primitive companions', () => {
    const input = legacyConversionFixture();
    const definitions = [
        ['Contract', require(`${root}0.4.0/fhir/resources/StructureDefinition-pcm-data-access-authorization-contract.json`)],
        ['HealthcareService', require(`${root}0.4.0/fhir/resources/StructureDefinition-pcm-system-healthcareservice.json`)]
    ];
    for (const [resourceType, definition] of definitions) {
        for (const element of definition.differential.element.filter(item => item.max === '0')) {
            for (const prefix of ['', '_']) {
                const contract = structuredClone(input.contract), service = structuredClone(input.service);
                const parts = element.path.split('.').slice(1).map(part => part.replace('[x]', 'Reference'));
                let parent = resourceType === 'Contract' ? contract : service;
                for (const part of parts.slice(0, -1)) parent = Array.isArray(parent[part]) ? parent[part][0] : parent[part];
                const field = `${prefix}${parts.at(-1)}`;
                // These are the reviewer's actual counterexamples, not just
                // schema placeholders that a later validator might reject.
                parent[field] = field === 'doNotPerform' ? true : field === 'condition' ? 'Only for the approved investigation' : {};
                const before = JSON.stringify({ contract, service, state: input.store.getAll('Contract') });
                assert.throws(() => convertLegacySystemContract({ ...input, contract, service }), /Unsupported legacy permission content/, `${element.path} (${prefix || 'value'})`);
                assert.equal(JSON.stringify({ contract, service, state: input.store.getAll('Contract') }), before);
            }
        }
    }
});

test('legacy conversion fails closed on unknown nested fields, aliases, extra profiles and malformed collections', () => {
    const input = legacyConversionFixture();
    const mutations = [
        value => value.contract.permission = { deny: true },
        value => value.contract.term[0].permission = { condition: 'approval' },
        value => value.contract.term[0].asset[0].customRestriction = 'approval',
        value => value.contract.term[0].action[0].customRestriction = 'approval',
        value => value.contract.term[0].action[0].constructor = {},
        value => value.contract.term[0].asset[0].type[0].coding[0].doNotPerform = true,
        value => value.contract.term[0].action[0].intent.condition = 'approval',
        value => value.contract.topicReference.identifier = { system: 'urn:alias', value: 'other-service' },
        value => value.contract.term[0].offer.party[0].reference[0]._identifier = { extension: [] },
        value => value.contract.term[0].asset[0]._type = { extension: [] },
        value => value.contract.term[0].action[0].type._text = { modifierExtension: [{ url: 'urn:restriction' }] },
        value => value.contract.meta.profile.push('urn:additional-permission-profile'),
        value => value.contract.term[0].action = { length: 1, 0: value.contract.term[0].action[0] },
        value => value.service.extension.push({ url: 'urn:unsupported-service-permission', valueString: 'approval' })
    ];
    for (const mutate of mutations) {
        const changed = { ...input, contract: structuredClone(input.contract), service: structuredClone(input.service) };
        mutate(changed);
        const before = JSON.stringify({ contract: changed.contract, service: changed.service, state: input.store.getAll('Contract') });
        assert.throws(() => convertLegacySystemContract(changed), /Unsupported legacy/);
        assert.equal(JSON.stringify({ contract: changed.contract, service: changed.service, state: input.store.getAll('Contract') }), before);
    }
});

test('legacy conversion allows ordinary Element, Coding, Reference and primitive metadata without changing historical identity', () => {
    const input = legacyConversionFixture(), { contract, service } = input;
    const annotation = [{ url: 'urn:operator:annotation', valueString: 'reviewed' }];
    contract.meta.versionId = 'historical-2';
    contract.meta.tag = [{ system: 'urn:annotation', code: 'reviewed', display: 'Reviewed' }];
    contract.identifier[0].id = 'business-id';
    contract.identifier[0]._value = { extension: annotation };
    contract.author.display = 'PCM'; contract.author.extension = annotation;
    contract.topicReference.display = 'Historical system service';
    contract.topicReference._reference = { extension: annotation };
    contract.type.text = 'Data access'; contract.type.coding[0]._display = { extension: annotation };
    contract.term[0].id = 'legacy-term'; contract.term[0].extension = annotation;
    contract.term[0].offer.party[0].reference[0].display = 'Recipient';
    contract.term[0].asset[0].id = 'legacy-target'; contract.term[0].asset[0].extension = annotation;
    contract.term[0].asset[0].type[0].coding[0].display = 'All active sources';
    contract.term[0].action[0].id = 'legacy-action'; contract.term[0].action[0].extension = annotation;
    contract.term[0].action[0].type.coding[0].userSelected = false;
    contract.term[0].action[0].intent._text = { extension: annotation };
    contract.applies._start = { extension: annotation };
    service._name = { extension: annotation }; service.type[0].coding[0].display = 'Presence';
    const before = JSON.stringify({ contract, service, state: input.store.getAll('Contract') });
    const result = convertLegacySystemContract(input);
    assert.deepEqual(result.identifier, contract.identifier); assert.deepEqual(result.applies, contract.applies);
    assert.deepEqual(result.author, contract.author); assert.deepEqual(result.meta.tag, contract.meta.tag);
    assert.deepEqual(result.type, contract.type); assert.equal(result.meta.versionId, 'historical-2');
    assert.equal(result.term[0].id, 'legacy-term'); assert.deepEqual(result.term[0].extension, annotation);
    assert.deepEqual(result.term[0].offer, contract.term[0].offer);
    assert.equal(JSON.stringify({ contract, service, state: input.store.getAll('Contract') }), before);
});
