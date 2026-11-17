'use strict';

/** Pure PCM-IG 0.4.2 system-grant shape, identity and retained-pair conversion rules. */
const BASE = 'http://pcm.fhir.health.gov.il';
const SYSTEM_PROFILE = `${BASE}/StructureDefinition/pcm-system-authorization-contract`;
const BASIS_SYSTEM = `${BASE}/identifier/pcm-data-access-authorization-id`;
const SCENARIO_SYSTEM = `${BASE}/cs/pcm-authorization-scenario`;
const VOCABULARY = `${BASE}/cs/pcm-authorization-vocabulary`;
const EXAMPLE_QUERY = `${BASE}/StructureDefinition/ext-example-query`;
const TERMINAL = new Set(['revoked', 'terminated', 'entered-in-error']);
// These paths mirror the candidate concrete profile's max=0 differential. Tests
// bind this list to the immutable candidate, without a runtime vendor dependency.
const PROHIBITED = Object.freeze({
    Contract: ['implicitRules', 'contained', 'modifierExtension', 'url', 'version', 'legalState', 'instantiatesCanonical',
        'contentDerivative', 'expirationType', 'subject', 'authority', 'domain', 'site', 'name', 'subtitle', 'alias', 'scope',
        'topic[x]', 'contentDefinition', 'supportingInfo', 'relevantHistory', 'signer', 'friendly', 'legal', 'rule', 'legallyBinding[x]'],
    'Contract.term': ['modifierExtension', 'identifier', 'issued', 'applies', 'topic[x]', 'type', 'subType', 'securityLabel', 'group', 'action'],
    'Contract.term.offer': ['modifierExtension', 'identifier', 'topic', 'type', 'decision', 'decisionMode', 'answer', 'text', 'linkId', 'securityLabelNumber'],
    'Contract.term.offer.party': ['modifierExtension'],
    'Contract.term.asset': ['modifierExtension', 'scope', 'type', 'typeReference', 'subtype', 'relationship', 'condition', 'periodType', 'period',
        'usePeriod', 'text', 'linkId', 'answer', 'securityLabelNumber', 'valuedItem'],
    'Contract.term.asset.context': ['modifierExtension', 'code', 'text']
});

/** Reject only the concrete profile's prohibited content, preserving allowed Element metadata. */
function assertProhibited(value, path = 'Contract') {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(item => assertProhibited(item, path));
    for (const [key, child] of Object.entries(value)) {
        const name = key.startsWith('_') ? key.slice(1) : key;
        if (PROHIBITED[path]?.some(field => field.endsWith('[x]') ? name.startsWith(field.slice(0, -3)) : name === field)) {
            throw new TypeError(`Prohibited system Contract field ${path}.${key}`);
        }
        assertProhibited(child, `${path}.${key}`);
    }
}

/** Require one exact bound coding while allowing ordinary Coding/CodeableConcept metadata. */
function codingIs(value, system, code) {
    return Array.isArray(value?.coding) && value.coding.length === 1 && value.coding[0].system === system && value.coding[0].code === code;
}

/** Require a local Organization reference with no identifier alias. */
function organizationReference(value) {
    if (typeof value?.reference !== 'string' || !/^Organization\/[A-Za-z0-9.-]{1,64}$/.test(value.reference)
        || Object.hasOwn(value, 'identifier')) throw new TypeError('Expected local Organization reference');
    return value.reference.slice('Organization/'.length);
}

/** Validate a concrete system grant independently of current availability and without mutation. */
function validateSystemContract(store, contract, pcmOrganizationId) {
    const { timestamp, SCENARIOS } = require('./system-policy');
    const { organizationRole } = require('./participant-lifecycle');
    if (contract?.resourceType !== 'Contract' || !/^[A-Za-z0-9.-]{1,64}$/.test(contract.id || '')
        || !Array.isArray(contract.meta?.profile) || !contract.meta.profile.includes(SYSTEM_PROFILE) || !contract.meta.lastUpdated) throw new TypeError('Invalid system Contract profile/metadata');
    timestamp(contract.meta.lastUpdated);
    assertProhibited(contract);
    const scenario = Array.isArray(contract.subType) && contract.subType.length === 1 && contract.subType[0]?.coding?.length === 1 && contract.subType[0].coding[0].code;
    if (!Object.hasOwn(SCENARIOS, scenario) || !codingIs(contract.subType[0], SCENARIO_SYSTEM, scenario)
        || !codingIs(contract.type, VOCABULARY, 'data-access-authorization')) throw new TypeError('Invalid system Contract type or scenario binding');
    const ids = contract.identifier;
    if (!Array.isArray(ids) || ids.length !== 1 || ids[0].use !== 'official' || ids[0].system !== BASIS_SYSTEM
        || typeof ids[0].value !== 'string' || !ids[0].value.trim()) throw new TypeError('System Contract requires one official identifier');
    const issued = timestamp(contract.issued), start = timestamp(contract.applies?.start);
    const end = contract.applies?.end === undefined ? Infinity : timestamp(contract.applies.end);
    if (start >= end || issued > end) throw new TypeError('Invalid policy validity interval');
    if (!['executed', ...TERMINAL].includes(contract.status) || (contract.status === 'terminated' && end === Infinity)) throw new TypeError('Invalid system Contract lifecycle');
    if (organizationReference(contract.author) !== pcmOrganizationId || organizationRole(store.get('Organization', pcmOrganizationId)) !== 'pcm' || !Array.isArray(contract.term) || contract.term.length !== 1) throw new TypeError('Invalid PCM policy ownership');
    const term = contract.term[0], parties = term.offer?.party;
    if (!Array.isArray(parties) || parties.length !== 1 || !Array.isArray(parties[0].reference) || parties[0].reference.length !== 1
        || organizationReference(parties[0].reference[0]) !== pcmOrganizationId
        || !codingIs(parties[0].role, VOCABULARY, 'grantee')) throw new TypeError('Invalid immutable PCM grantee');
    if (typeof contract.title !== 'string' || !contract.title.trim() || typeof term.text !== 'string' || !term.text.trim()
        || !Array.isArray(contract.extension) || !contract.extension.length
        || contract.extension.some(item => item.url !== EXAMPLE_QUERY || typeof item.valueString !== 'string' || !item.valueString.trim()
            || Object.hasOwn(item, 'extension') || Object.keys(item).some(key => key.startsWith('value') && key !== 'valueString'))) throw new TypeError('Contract title, explanation and informational query examples required');
    if (term.asset !== undefined && !Array.isArray(term.asset)) throw new TypeError('Explicit source entries must be an array');
    const sources = (term.asset || []).map(asset => {
        if (!Array.isArray(asset.context) || asset.context.length !== 1) throw new TypeError('One source context required per asset');
        const id = organizationReference(asset.context[0].reference);
        if (organizationRole(store.get('Organization', id)) !== 'source') throw new TypeError('Unknown or foreign Data Source reference');
        return id;
    });
    if (new Set(sources).size !== sources.length) throw new TypeError('Duplicate source references');
    return { scenario, identifier: ids[0], start, end, issued, sources };
}

/** Validate a private maintenance change; changed identity/recipient/workflow/start or extended end needs a new grant. */
function validateSystemContractUpdate(store, current, updated, pcmOrganizationId) {
    if (!current) throw new TypeError('Policy is missing');
    const before = validateSystemContract(store, current, pcmOrganizationId);
    const after = validateSystemContract(store, updated, pcmOrganizationId);
    if (TERMINAL.has(current.status)) throw new TypeError('Policy is terminal');
    if (current.id !== updated.id || before.identifier.system !== after.identifier.system || before.identifier.value !== after.identifier.value
        || before.scenario !== after.scenario || current.author.reference !== updated.author.reference
        || current.term[0].offer.party[0].reference[0].reference !== updated.term[0].offer.party[0].reference[0].reference
        || before.start !== after.start || before.issued !== after.issued || after.end > before.end) {
        throw new TypeError('Immutable grant fields or validity extension require a new grant');
    }
    return after;
}

// Conversion accepts the known legacy permission package, rather than merely
// checking codes and then throwing away possible additional restrictions. These
// closed shapes mirror the non-prohibited 0.4.0 base/profile fields. Ordinary
// non-modifier Element metadata is allowed, including on the removed structures.
const LEGACY_SHAPES = Object.freeze({
    Contract: { resourceType: 'string', id: 'string', meta: 'Meta', text: 'Narrative', identifier: ['Identifier'],
        status: 'string', issued: 'string', applies: 'Period', author: 'Reference', topicReference: 'Reference',
        type: 'CodeableConcept', subType: ['CodeableConcept'], term: ['Term'] },
    Term: { id: 'string', extension: ['Extension'], offer: 'Offer', asset: ['Asset'], action: ['Action'] },
    Offer: { id: 'string', extension: ['Extension'], party: ['Party'] },
    Party: { id: 'string', extension: ['Extension'], reference: ['Reference'], role: 'CodeableConcept' },
    Asset: { id: 'string', extension: ['Extension'], type: ['CodeableConcept'] },
    Action: { id: 'string', extension: ['Extension'], type: 'CodeableConcept', intent: 'CodeableConcept', status: 'CodeableConcept' },
    Reference: { id: 'string', extension: ['Extension'], reference: 'string', type: 'string', display: 'string' },
    CodeableConcept: { id: 'string', extension: ['Extension'], coding: ['Coding'], text: 'string' },
    Coding: { id: 'string', extension: ['Extension'], system: 'string', version: 'string', code: 'string', display: 'string', userSelected: 'boolean' },
    Identifier: { id: 'string', extension: ['Extension'], use: 'string', type: 'CodeableConcept', system: 'string', value: 'string',
        period: 'Period', assigner: 'Reference' },
    Period: { id: 'string', extension: ['Extension'], start: 'string', end: 'string' },
    Meta: { id: 'string', extension: ['Extension'], versionId: 'string', lastUpdated: 'string', source: 'string',
        profile: ['string'], security: ['Coding'], tag: ['Coding'] },
    Narrative: { id: 'string', extension: ['Extension'], status: 'string', div: 'string' },
    PrimitiveMetadata: { id: 'string', extension: ['Extension'] },
    HealthcareService: { resourceType: 'string', id: 'string', meta: 'Meta', text: 'Narrative', extension: ['Extension'],
        identifier: ['Identifier'], active: 'boolean', providedBy: 'Reference', type: ['CodeableConcept'], name: 'string', extraDetails: 'string' }
});

/** Reject unsupported legacy content recursively before any permission-bearing fields are removed. */
function assertLegacyShape(value, shape, path) {
    const fail = () => { throw new TypeError(`Unsupported legacy permission content at ${path}`); };
    if (Array.isArray(shape)) {
        if (!Array.isArray(value)) fail();
        return value.forEach((item, index) => assertLegacyShape(item, shape[0], `${path}[${index}]`));
    }
    if (shape === 'string' || shape === 'boolean') {
        if (typeof value !== shape) fail();
        return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    if (shape === 'Extension') {
        // A normal FHIR extension cannot alter the meaning of its containing
        // element. Modifier extensions are never accepted by these closed shapes.
        for (const key of Object.keys(value)) {
            if (key === 'extension') assertLegacyShape(value[key], ['Extension'], `${path}.${key}`);
            else if (key === 'id' || key === 'url') assertLegacyShape(value[key], 'string', `${path}.${key}`);
            else if (key === '_url') assertLegacyShape(value[key], 'PrimitiveMetadata', `${path}.${key}`);
            else if (!/^_?value[A-Z]/.test(key)) fail();
        }
        if (typeof value.url !== 'string') fail();
        return;
    }
    const fields = LEGACY_SHAPES[shape];
    for (const [key, child] of Object.entries(value)) {
        let childShape = Object.hasOwn(fields, key) ? fields[key] : undefined;
        if (key.startsWith('_')) {
            const primitive = Object.hasOwn(fields, key.slice(1)) ? fields[key.slice(1)] : undefined;
            const type = Array.isArray(primitive) ? primitive[0] : primitive;
            if (type !== 'string' && type !== 'boolean') {
                throw new TypeError(`Unsupported legacy permission content at ${path}.${key}`);
            }
            childShape = Array.isArray(primitive) ? ['PrimitiveMetadata'] : 'PrimitiveMetadata';
        }
        if (!childShape) throw new TypeError(`Unsupported legacy permission content at ${path}.${key}`);
        assertLegacyShape(child, childShape, `${path}.${key}`);
    }
}

/** Preview one known legacy normative pair as a new shape; never write retained resources or infer membership. */
function convertLegacySystemContract({ store, contract, service, pcmOrganizationId, sourceOrganizationIds }) {
    const { SCENARIOS, scenarioOf, timestamp } = require('./system-policy');
    assertLegacyShape(contract, 'Contract', 'Contract');
    assertLegacyShape(service, 'HealthcareService', 'HealthcareService');
    const scenario = scenarioOf(contract), owner = `Organization/${pcmOrganizationId}`;
    const definition = SCENARIOS[scenario];
    if (!definition || contract.meta?.profile?.length !== 1
        || contract.meta.profile[0] !== `${BASE}/StructureDefinition/pcm-${definition.suffix}-authorization-contract`
        || contract.topicReference?.reference !== `HealthcareService/${service?.id}`
        || service?.resourceType !== 'HealthcareService' || service.providedBy?.reference !== owner
        || !require('./system-policy').isSystemService(service) || !codingIs(service.type?.[0], SCENARIO_SYSTEM, scenario)
        || service.type?.length !== 1 || contract.author?.reference !== owner
        || contract.term?.length !== 1 || contract.term[0].offer?.party?.length !== 1
        || contract.term[0].offer.party[0].reference?.length !== 1 || contract.term[0].offer.party[0].reference[0].reference !== owner
        || !codingIs(contract.term[0].offer.party[0].role, VOCABULARY, 'grantee')
        || !codingIs(contract.type, VOCABULARY, 'data-access-authorization') || !Array.isArray(sourceOrganizationIds)
        || !['policy', ...TERMINAL].includes(contract.status)) throw new TypeError('Unsupported legacy normative Contract/service conversion');
    if (service.extension?.some(item => item.url !== EXAMPLE_QUERY)) throw new TypeError('Unsupported legacy permission content at HealthcareService.extension');
    const legacyTerm = contract.term[0], legacyAction = legacyTerm.action;
    const target = scenario === 'presence-check' ? 'all-active-data-sources' : 'participating-hmos';
    if (legacyTerm.asset?.length !== 1 || legacyTerm.asset[0].type?.length !== 1
        || !codingIs(legacyTerm.asset[0].type[0], `${BASE}/cs/pcm-authorization-target`, target)
        || legacyAction?.length !== 1 || !codingIs(legacyAction[0].type, VOCABULARY, 'access-fhir-data')
        || !codingIs(legacyAction[0].intent, SCENARIO_SYSTEM, scenario)
        || !codingIs(legacyAction[0].status, VOCABULARY, 'authorized')
        || (contract.status === 'policy' && service.active !== true)) throw new TypeError('Legacy permission meaning or suspended service requires explicit resolution');
    // Historical periods are preserved byte-for-byte, even for terminal records.
    timestamp(contract.issued); timestamp(contract.applies?.start);
    if (contract.applies?.end !== undefined) timestamp(contract.applies.end);
    const converted = structuredClone(contract);
    converted.meta.profile = [SYSTEM_PROFILE];
    converted.status = contract.status === 'policy' ? 'executed' : contract.status;
    converted.title = service.name;
    converted.extension = structuredClone((service.extension || []).filter(item => item.url === EXAMPLE_QUERY));
    converted.term = [{ ...structuredClone(contract.term[0]), text: service.extraDetails,
        asset: sourceOrganizationIds.map(id => ({ context: [{ reference: { reference: `Organization/${id}` } }] })) }];
    delete converted.topicReference;
    delete converted.term[0].action;
    validateSystemContract(store, converted, pcmOrganizationId);
    return converted;
}

module.exports = { SYSTEM_PROFILE, PROHIBITED, validateSystemContract, validateSystemContractUpdate, convertLegacySystemContract };
