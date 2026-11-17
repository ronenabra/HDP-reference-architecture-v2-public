'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildCatalogUpdateParameters,
    buildConsentDeactivate,
    buildConsentSubmit,
    buildEndpointWrite,
    buildExistingServiceRegistration,
    buildNewServiceRegistration,
    buildOrganizationCreate,
    buildOrganizationUpdate,
    buildServiceStatusUpdate,
    validateAuthoritativeResource,
    validateCatalogUpdateResponse,
    validateConsentSubmit
} = require('../src/fhir-builders');
const { CODE_SYSTEMS, EXTENSIONS, IDENTIFIER_SYSTEMS } = require('../src/constants');

const definitionExtensions = () => [
    { url: EXTENSIONS.accessMode, valueCode: 'continuous' },
    { url: EXTENSIONS.accessDuration, valueDuration: { value: 1, unit: 'month', system: 'http://unitsofmeasure.org', code: 'mo' } },
    { url: EXTENSIONS.exampleQuery, valueString: 'Observation?category=laboratory' },
    { url: EXTENSIONS.allowPatientBucketChange, valueBoolean: false },
    {
        url: EXTENSIONS.informationBucket,
        extension: [
            { url: 'bucket', valueCodeableConcept: { coding: [{ system: CODE_SYSTEMS.informationBucket, code: 'laboratory' }] } },
            { url: 'historyDepth', valueDuration: { value: 1, unit: 'year', system: 'http://unitsofmeasure.org', code: 'a' } }
        ]
    }
];

test('SP-001 write profiles produce closed Organization, Endpoint, HCS, Parameters, and Consent requests', () => {
    const orgCreate = buildOrganizationCreate({ name: 'Child SP' });
    assert.deepEqual(Object.keys(orgCreate).sort(), ['meta', 'name', 'resourceType']);
    const orgUpdate = buildOrganizationUpdate({ resourceType: 'Organization', id: 'org-1', name: 'SP', active: true, type: [] });
    assert.deepEqual(orgUpdate, { resourceType: 'Organization', id: 'org-1', name: 'SP' });
    const endpoint = buildEndpointWrite({
        resourceType: 'Endpoint', id: 'ep-1', status: 'suspended',
        connectionType: { system: CODE_SYSTEMS.endpointConnectionType, code: 'hl7-fhir-rest' },
        payloadType: [{ coding: [{ system: CODE_SYSTEMS.endpointPayloadType, code: 'any' }] }],
        address: 'https://ho.example/r4'
    });
    assert.equal(endpoint.managingOrganization, undefined);
    assert.match(buildExistingServiceRegistration('catalog-1').extension[0].valueReference.reference, /catalog-1$/);
    assert.equal(buildServiceStatusUpdate('service-1', 'suspended').extension[0].valueCoding.code, 'suspended');
    const consent = buildConsentSubmit({ system: IDENTIFIER_SYSTEMS.israelNationalId, value: '324573740' }, 'service-1');
    assert.deepEqual(consent.policy, [{ authority: 'https://www.gov.il/', uri: 'https://pcm.fhir.health.gov.il/consent-policy/medical-information-mobility-law-2024' }]);
    assert.equal(buildConsentDeactivate('consent-1').status, 'inactive');
});

test('SP-001 closed write profiles reject server-field smuggling and malformed fixed values before network use', () => {
    const consent = buildConsentSubmit({ system: IDENTIFIER_SYSTEMS.israelNationalId, value: '324573740' }, 'service-1');
    assert.throws(() => validateConsentSubmit({ ...consent, identifier: [{ value: 'client' }] }), /unknown fields/);
    assert.throws(() => validateConsentSubmit({ ...consent, policyRule: {} }), /unknown fields/);
    assert.throws(() => buildOrganizationCreate({ name: 'SP', active: true }), /unknown fields/);
    assert.throws(() => buildOrganizationCreate({
        name: 'SP', extension: [{ url: EXTENSIONS.applicableCertificates }]
    }), /PCM-managed/);
    assert.throws(() => buildConsentSubmit({ system: IDENTIFIER_SYSTEMS.israelNationalId, value: '324573741' }, 'service-1'), /check digit/);
    assert.throws(() => buildEndpointWrite({ resourceType: 'Endpoint', id: 'ep', status: 'off' }), /missing fields|fixed fields/);
    assert.throws(() => buildEndpointWrite({
        resourceType: 'Endpoint', id: 'ep', status: 'suspended',
        connectionType: { system: CODE_SYSTEMS.endpointConnectionType, code: 'hl7-fhir-rest' },
        payloadType: [{ coding: [{ system: CODE_SYSTEMS.endpointPayloadType, code: 'any' }] }],
        address: 'https://ho.example/r4', managingOrganization: { reference: 'Organization/source' }
    }), /unknown fields/);
    assert.throws(() => buildServiceStatusUpdate('service', 'frozen'), /Unsupported/);
});

test('SP-001 HealthcareService profiles keep new-service and catalog-update projections distinct', () => {
    const newService = buildNewServiceRegistration({
        resourceType: 'HealthcareService', name: 'New service', category: [{}],
        type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'INFA', display: 'information access' }] }],
        extraDetails: 'Purpose', extension: definitionExtensions()
    });
    assert.equal(newService.meta.profile.length, 1);
    const catalog = {
        resourceType: 'HealthcareService', id: 'catalog-1',
        meta: {
            profile: ['http://pcm.fhir.health.gov.il/StructureDefinition/pcm-healthcareservice-catalog-update-proposal'],
            tag: [{ system: CODE_SYSTEMS.metaTag, code: 'catalog' }]
        },
        identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.healthcareServiceCatalog, value: 'PCM-CATALOG-1' }],
        active: true, name: 'Canonical service', category: [{}],
        type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'INFA', display: 'information access' }] }],
        extraDetails: 'Purpose', extension: [
            { url: EXTENSIONS.serviceBusinessStatus, valueCoding: { system: CODE_SYSTEMS.serviceBusinessStatus, code: 'active' } },
            ...definitionExtensions()
        ]
    };
    const parameters = buildCatalogUpdateParameters(catalog, 'Clarify purpose');
    assert.deepEqual(parameters.parameter.map(parameter => parameter.name), ['proposedCatalog', 'reason']);
    assert.throws(() => buildNewServiceRegistration({ ...newService, basedOn: true }), /unknown fields/);
    assert.throws(() => buildCatalogUpdateParameters({ ...catalog, providedBy: { reference: 'Organization/org-1' } }), /unknown fields/);
    assert.throws(() => buildConsentDeactivate('../bad'), /logical id/);
});

test('SP-001 closed PCM write responses are validated before client use', () => {
    const endpoint = {
        resourceType: 'Endpoint', id: 'ep-1',
        meta: { profile: ['http://pcm.fhir.health.gov.il/StructureDefinition/pcm-endpoint'], versionId: '1', lastUpdated: '2026-01-01T00:00:00Z' },
        status: 'active', connectionType: { system: CODE_SYSTEMS.endpointConnectionType, code: 'hl7-fhir-rest' },
        payloadType: [{ coding: [{ system: CODE_SYSTEMS.endpointPayloadType, code: 'any' }] }],
        address: 'https://ho.example/r4', managingOrganization: { reference: 'Organization/ho-1' }
    };
    assert.equal(validateAuthoritativeResource(endpoint, 'Endpoint').id, 'ep-1');
    assert.throws(() => validateAuthoritativeResource({ ...endpoint, meta: { ...endpoint.meta, versionId: undefined } }, 'Endpoint'), /version metadata/);

    const receipt = {
        resourceType: 'Parameters',
        meta: { profile: ['http://pcm.fhir.health.gov.il/StructureDefinition/pcm-request-catalog-update-response'] },
        parameter: [{ name: 'requestId', valueString: 'request-1' }, { name: 'status', valueCode: 'received' }]
    };
    assert.equal(validateCatalogUpdateResponse(receipt).parameter[0].valueString, 'request-1');
    assert.throws(() => validateCatalogUpdateResponse({
        ...receipt, parameter: [{ name: 'requestId', valueString: 'request-1', extra: true }, receipt.parameter[1]]
    }), /unknown fields/);
});

test('0.4.2 Doctor builder preserves every tagged category and rejects unbound codings', () => {
    const extension = definitionExtensions();
    const bucket = extension.find(part => part.url === EXTENSIONS.informationBucket);
    const tags = require('../../shared/information-buckets').SENSITIVITY_LABELS.slice(0, 3).map(coding => ({ url: 'taggedDetails', valueCodeableConcept: { coding: [coding] } }));
    bucket.extension.push(...tags);
    const definition = { resourceType: 'HealthcareService', name: 'Plural tags', category: [{}], type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'INFA', display: 'information access' }] }], extraDetails: 'test purpose', extension };
    const result = buildNewServiceRegistration(definition);
    assert.deepEqual(result.extension.find(part => part.url === EXTENSIONS.informationBucket).extension.filter(part => part.url === 'taggedDetails'), tags);
    tags[0].valueCodeableConcept.coding[0] = { system: 'urn:unbound', code: 'unknown' };
    assert.throws(() => buildNewServiceRegistration(definition), /sensitivity/);
    const pna = { system: IDENTIFIER_SYSTEMS.palestinianNationalId, value: '0'.repeat(129) };
    assert.deepEqual(buildConsentSubmit(pna, 'service-1').patient.identifier, pna);
});
