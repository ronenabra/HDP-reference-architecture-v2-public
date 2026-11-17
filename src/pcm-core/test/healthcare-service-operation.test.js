/** HealthcareService catalog-update operation and example tests. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FHIRStore } = require('../src/fhir/store');
const {
    HealthcareServiceLifecycleError,
    requestCatalogUpdate
} = require('../src/fhir/healthcare-service-lifecycle');
const { CODE_SYSTEMS, IDENTIFIER_SYSTEMS } = require('../../shared/pcm-contract');

const examples = path.resolve(__dirname, '../../../docs/FHIR-examples');
const read = name => JSON.parse(fs.readFileSync(path.join(examples, name), 'utf8'));

function fixture() {
    const store = new FHIRStore();
    store.add({
        resourceType: 'Organization', id: 'parent', active: true,
        identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value: 'PCM-PARENT' }],
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: 'parent-org' }] }]
    });
    const sp = store.add({
        resourceType: 'Organization', id: 'sp', active: true,
        identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value: 'PCM-SP' }],
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: 'service-provider' }] }],
        partOf: { reference: 'Organization/parent' }
    });
    const catalog = store.add(read('HealthcareService-svc-catalog-cross-org-summary.json'));
    return { store, sp, catalog };
}

function operationBody() {
    return read('Parameters-parameters-request-catalog-update-cross-org-summary.json');
}

test('imported catalog update request returns the closed 200 receipt without mutating the catalog', () => {
    const { store, sp, catalog } = fixture();
    const before = store.get('HealthcareService', catalog.id);
    const result = requestCatalogUpdate({
        store, callerOrganization: sp, targetId: catalog.id, body: operationBody(),
        requestIdGenerator: () => 'catalog-update-request-1'
    });
    assert.equal(result.reason.includes('patient-facing'), true);
    assert.deepEqual(result.receipt.parameter.map(parameter => parameter.name), ['requestId', 'status', 'message']);
    assert.equal(result.receipt.parameter[0].valueString, 'catalog-update-request-1');
    assert.equal(result.receipt.parameter[1].valueCode, 'received');
    assert.deepEqual(store.get('HealthcareService', catalog.id), before);

    const importedReceipt = read('Parameters-parameters-request-catalog-update-cross-org-summary-accepted.json');
    assert.equal(importedReceipt.meta.profile[0], result.receipt.meta.profile[0]);
    assert.deepEqual(importedReceipt.parameter.map(parameter => parameter.name), result.receipt.parameter.map(parameter => parameter.name));
});

test('name, purpose, and exampleQuery changes are semantic while representation order/display is neutral', () => {
    const { store, sp, catalog } = fixture();
    const body = operationBody();
    const proposed = body.parameter[0].resource;
    proposed.name = 'Renamed Summary';
    proposed.extension.find(extension => extension.url.endsWith('ext-example-query')).valueString = 'GET [FHIR BASE]/Condition';
    proposed.category[0].coding[0].display = 'Neutral display';
    proposed.extension.reverse();
    body.parameter = [body.parameter[1], body.parameter[0]];
    assert.doesNotThrow(() => requestCatalogUpdate({
        store, callerOrganization: sp, targetId: catalog.id, body
    }));
});

test('known protected changes are material and duplicate proposed names conflict', () => {
    for (const mutate of [
        proposed => { proposed.active = false; },
        proposed => { proposed.category[0].coding[0].code = '99'; },
        proposed => { proposed.identifier[0].value = 'CHANGED'; },
        proposed => { proposed.extension.find(extension => extension.url.endsWith('ext-access-mode')).valueCode = 'one-time'; }
    ]) {
        const { store, sp, catalog } = fixture();
        const body = operationBody();
        mutate(body.parameter[0].resource);
        assert.throws(() => requestCatalogUpdate({
            store, callerOrganization: sp, targetId: catalog.id, body
        }), error => error instanceof HealthcareServiceLifecycleError && error.status === 422);
    }

    const { store, sp, catalog } = fixture();
    const duplicate = read('HealthcareService-svc-catalog-extended-medication-safety.json');
    store.add(duplicate);
    const body = operationBody();
    body.parameter[0].resource.name = duplicate.name;
    assert.throws(() => requestCatalogUpdate({
        store, callerOrganization: sp, targetId: catalog.id, body
    }), error => error.status === 409);
});

test('catalog update Parameters is closed, reason is optional, and proposal must be complete', () => {
    const cases = [
        body => { body.unexpected = true; },
        body => { body.meta.versionId = '1'; },
        body => { body.parameter.push({ name: 'unknown', valueString: 'x' }); },
        body => { body.parameter.push({ name: 'reason', valueString: 'duplicate' }); },
        body => { body.parameter[0].resource.id = 'other'; },
        body => { delete body.parameter[0].resource.identifier; },
        body => { body.parameter[0].resource.modifierExtension = []; }
    ];
    for (const mutate of cases) {
        const { store, sp, catalog } = fixture();
        const body = operationBody();
        mutate(body);
        assert.throws(() => requestCatalogUpdate({
            store, callerOrganization: sp, targetId: catalog.id, body
        }), error => (error instanceof HealthcareServiceLifecycleError || error instanceof require('../src/public-fhir').PublicMetadataError) && error.status === 400);
        assert.deepEqual(store.get('HealthcareService', catalog.id), catalog, 'rejected public payload cannot alter catalog authority');
    }
    const { store, sp, catalog } = fixture();
    const body = operationBody();
    body.parameter = body.parameter.filter(parameter => parameter.name !== 'reason');
    assert.doesNotThrow(() => requestCatalogUpdate({ store, callerOrganization: sp, targetId: catalog.id, body }));
});

test('every imported HealthcareService OperationOutcome is a closed FHIR error example', () => {
    const files = fs.readdirSync(examples).filter(name => /^OperationOutcome-outcome-healthcareservice-.*\.json$/.test(name));
    assert.equal(files.length, 7);
    for (const file of files) {
        const outcome = read(file);
        assert.equal(outcome.resourceType, 'OperationOutcome', file);
        assert.equal(outcome.issue.length, 1, file);
        assert.equal(outcome.issue[0].severity, 'error', file);
        assert.equal(typeof outcome.issue[0].diagnostics, 'string', file);
    }
});

test('every imported Parameters example is exercised without exposing lifecycle state as a public resource', () => {
    const files = fs.readdirSync(examples).filter(name => /^Parameters-.*\.json$/.test(name));
    assert.equal(files.length, 6);
    for (const file of files) {
        const parameters = read(file);
        assert.equal(parameters.resourceType, 'Parameters', file);
        assert.ok(parameters.parameter.length > 0, file);
        assert.equal(new Set(parameters.parameter.map(parameter => parameter.name)).size, parameters.parameter.length, file);
        for (const parameter of parameters.parameter) {
            assert.equal(typeof parameter.name, 'string', file);
            assert.equal(
                ['resource', 'valueString', 'valueCode'].filter(field => parameter[field] !== undefined).length,
                1,
                `${file}:${parameter.name}`
            );
        }
    }
});
