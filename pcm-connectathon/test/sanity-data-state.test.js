'use strict';

/** Presence qualification distinguishes absent, verified, unverified and unknown data. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { hasPositiveObservation, presencePrerequisite } = require('../scripts/sanity-data-state');

test('Doctor sanity selects explicit owned ordinary services and rejects missing or ambiguous catalog ownership', () => {
    const { doctorServiceId } = require('../scripts/sanity-data-state');
    assert.equal(doctorServiceId({ service: { id: 'legacy' } }, 'hospital-a'), 'legacy');
    const bindings = [
        { application: 'doctor', providerRole: 'serviceProvider', serviceKey: 'lab-follow-up', instanceId: 'lab-a' },
        { application: 'doctor-b', providerRole: 'hospitalBServiceProvider', serviceKey: 'lab-follow-up', instanceId: 'lab-b' },
        { application: 'doctor', providerRole: 'serviceProvider', serviceKey: 'sandbox-full-access', instanceId: 'full' }
    ];
    const config = { serviceCatalog: { bindings } };
    assert.equal(doctorServiceId(config, 'hospital-a'), 'lab-a');
    assert.equal(doctorServiceId(config, 'hospital-b'), 'lab-b');
    assert.throws(() => doctorServiceId(config, 'unknown'), /owned ordinary/);
    assert.throws(() => doctorServiceId({ serviceCatalog: { bindings: bindings.slice(1) } }, 'hospital-a'), /owned ordinary/);
    assert.throws(() => doctorServiceId({ serviceCatalog: { bindings: [...bindings, bindings[0]] } }, 'hospital-a'), /owned ordinary/);
});

test('verified Patient supplies its own presence identifier', () => {
    assert.deepEqual(presencePrerequisite({ idSystem: 'urn:test', idValue: 'A' }), {
        state: 'populated-verified', expectedTotal: 1, identifier: 'urn:test|A'
    });
});

test('exact zero Patient count independently establishes absence', () => {
    for (const resources of [0, 4010]) {
        const result = presencePrerequisite(null, { statusCode: 200, json: { actualResourceCount: resources, actualCounts: { Patient: 0 } } });
        assert.equal(result.expectedTotal, 0);
        assert.equal(result.state, resources ? 'populated-without-patients' : 'empty');
    }
});

test('unverified Patient data never becomes an assumed zero', () => {
    const result = presencePrerequisite(null, { statusCode: 200, json: { actualResourceCount: 4010, actualCounts: { Patient: 1 } } });
    assert.equal(result.state, 'populated-unverified');
    assert.equal(result.expectedTotal, undefined);
});

test('errors, missing and malformed counts remain unavailable', () => {
    for (const response of [null, { statusCode: 502 }, ...[undefined, -1, 0.5, '0'].map(Patient => ({ statusCode: 200, json: { actualCounts: { Patient } } }))]) {
        const result = presencePrerequisite(null, response);
        assert.equal(result.state, 'unavailable');
        assert.equal(result.expectedTotal, undefined);
    }
});


test('clinical qualification requires a concrete Observation rather than an empty or unrelated Bundle', () => {
    const observation = { resourceType: 'Observation', id: 'known-observation', status: 'final', subject: { reference: 'Patient/known-patient' } };
    assert.equal(hasPositiveObservation(observation), true);
    assert.equal(hasPositiveObservation({ resourceType: 'Bundle', entry: [{ resource: observation }] }), true);
    for (const data of [null, {}, { resourceType: 'Bundle' }, { resourceType: 'Bundle', entry: [] },
        { resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Patient', id: 'known-patient' } }] },
        { ...observation, id: undefined }, { ...observation, status: undefined }, { ...observation, subject: {} }]) {
        assert.equal(hasPositiveObservation(data), false);
    }
});

test('presence sanity uses exact Contract RAR and rejects ambiguous identifiers', () => {
    const { presenceAuthorizationDetails } = require('../scripts/sanity-data-state');
    const { parseAuthorizationDetails, validateScenarioRequest } = require('../../src/pcm-core/src/rar-request');
    const details = presenceAuthorizationDetails('http://fhir.health.gov.il/identifier/il-hdp-test-id|1');
    const parsed = parseAuthorizationDetails(JSON.stringify(details));
    assert.doesNotThrow(() => validateScenarioRequest(parsed, 'system/Patient.s', 'presence-check'));
    assert.equal(parsed.basis.identifier.value, 'PCM-POLICY-PRESENCE-001');
    assert.deepEqual(parsed.patients, [{ system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' }]);
    for (const identifier of ['', 'one', '|one', 'urn:test|', 'urn:test|one|two']) {
        assert.throws(() => presenceAuthorizationDetails(identifier), /exact/);
    }
});

test('explicit presence eligibility is validated before saving and ordinary configs stay empty', t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { configurePresenceEligibility } = require('../scripts/bootstrap-local-team');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-presence-config-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'team-config.json');
    const eligibilityFile = path.join(directory, 'patients.json');
    const original = JSON.stringify(require('../example-team-config.json'));
    fs.writeFileSync(configPath, original);
    assert.deepEqual(JSON.parse(original).systemAuthorization.presenceEligiblePatients, []);
    fs.writeFileSync(eligibilityFile, JSON.stringify([{ system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' }]));
    assert.equal(configurePresenceEligibility(configPath, eligibilityFile).systemAuthorization.presenceEligiblePatients.length, 1);
    const saved = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(eligibilityFile, JSON.stringify([{ system: '', value: '1' }]));
    assert.throws(() => configurePresenceEligibility(configPath, eligibilityFile));
    assert.equal(fs.readFileSync(configPath, 'utf8'), saved);
});

test('ordinary empty-team presence remains unconfigured until the exact typed identity is eligible', () => {
    const { presenceIsConfigured } = require('../scripts/sanity-data-state');
    const config = structuredClone(require('../example-team-config.json'));
    const identity = 'http://fhir.health.gov.il/identifier/il-hdp-test-id|1';
    assert.equal(presenceIsConfigured(config, identity), false);
    config.systemAuthorization.presenceEligiblePatients = [{ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' }];
    assert.equal(presenceIsConfigured(config, identity), false);
    config.systemAuthorization.presenceEligiblePatients.push({ system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' });
    assert.equal(presenceIsConfigured(config, identity), true);
    assert.equal(presenceIsConfigured(config, identity.replace('|1', '|2')), false);
});

test('JWKS absence requires an authenticated unsupported/not-found FHIR response', () => {
    const { jwksIsAbsent } = require('../scripts/sanity-data-state');
    const unsupported = { statusCode: 405, json: { resourceType: 'OperationOutcome', issue: [{ code: 'not-supported' }] } };
    assert.equal(jwksIsAbsent(unsupported), true);
    assert.equal(jwksIsAbsent({ statusCode: 404, json: { resourceType: 'OperationOutcome', issue: [{ code: 'not-found' }] } }), true);
    for (const response of [null, { statusCode: 401 }, { statusCode: 404 },
        { ...unsupported, statusCode: 200 }, { ...unsupported, json: { keys: [] } },
        { ...unsupported, json: { ...unsupported.json, keys: [] } },
        { ...unsupported, json: { resourceType: 'OperationOutcome', issue: [{ code: 'security' }] } }]) {
        assert.equal(jwksIsAbsent(response), false);
    }
});


test('presence sanity resolves shared modules in the Admin container without a PCM checkout', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const sharedRoot = path.resolve(__dirname, '../../src/shared');
    const sandbox = { module: { exports: {} }, require(name) {
        if (name === './lib') return { sharedModuleRoot: () => sharedRoot };
        if (name === 'node:path' || name.startsWith(sharedRoot + path.sep)) return require(name);
        throw new Error(`Module unavailable in container: ${name}`);
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/sanity-data-state.js'), 'utf8'), sandbox);
    const details = sandbox.module.exports.presenceAuthorizationDetails('urn:test|1');
    assert.equal(details[0].type, require('../../src/shared/data-authorization-details').TYPE);
    assert.equal(details[0].fhirContext[1].identifier.value, '1');
});

test('Consent sanity binds the selected patient to the correct provider and rejects ambiguous actors', () => {
    const { consentMatchesOwner } = require('../scripts/sanity-data-state');
    const patient = { idSystem: 'urn:owned:test', idValue: 'patient' };
    const actor = { role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'IRCP' }] }, reference: { reference: 'Organization/primary' } };
    const consent = { patient: { identifier: { system: patient.idSystem, value: patient.idValue } }, provision: { actor: [actor] } };
    assert.equal(consentMatchesOwner(consent, patient, 'primary'), true);
    assert.equal(consentMatchesOwner(consent, patient, 'secondary'), false);
    assert.equal(consentMatchesOwner(consent, { ...patient, idValue: 'other' }, 'primary'), false);
    consent.provision.actor.push(actor); assert.equal(consentMatchesOwner(consent, patient, 'primary'), false);
});
