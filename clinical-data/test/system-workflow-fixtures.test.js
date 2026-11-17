'use strict';

/** Fabricated workflow resources have valid business identities and intentional negative joins. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePatientIdentifier } = require('../../src/shared/identity-mapping');
const { authenticationPatient, selectOtpContact, joinDependents } = require('../../src/pcm-core/src/system-workflows');
const { buildTeamConfig } = require('../../test-support/team-config');
const workflow = require('../pcm-ig-040/workflow-config.json');
const bundles = ['ho-a', 'ho-b', 'ho-c'].map(id => require(`../pcm-ig-040/${id}.transaction.json`));

test('all fabricated identifiers pass validation and HMO B qualifies a representative without a Patient record', () => {
    const representative = workflow.memberships[0].identifier;
    const resources = bundles.map(bundle => {
        assert.equal(bundle.type, 'transaction');
        return bundle.entry.map(entry => {
            assert.equal(entry.request.method, 'PUT');
            assert.equal(entry.request.url, `${entry.resource.resourceType}/${entry.resource.id}`);
            for (const identifier of entry.resource.identifier) assert.equal(normalizePatientIdentifier(identifier).synthetic, false);
            return entry.resource;
        });
    });
    const result = resources.map(items => joinDependents(items.filter(r => r.resourceType === 'Patient'), items.filter(r => r.resourceType === 'RelatedPerson'), representative, workflow.eligibleRelationships, 'https://example.test/fhir'));
    assert.deepEqual(result.map(items => items.length), [2, 1, 1]);
    assert.ok(!resources[1].some(r => r.resourceType === 'Patient' && r.identifier.some(id => id.value === representative.value)));
    assert.equal(result[1][0].identifier.value, '000000026');
    assert.equal(result[0][0].evidence[0].decision, 'eligible');
});

test('home-HMO fixture has exactly one fresh OTP contact and no automatic clinical authorization', () => {
    const patient = bundles[0].entry[0].resource;
    const found = authenticationPatient({ resourceType: 'Bundle', type: 'searchset', entry: [{ resource: patient }] }, workflow.memberships[0].identifier, '1980-01-02');
    assert.equal(selectOtpContact(found, buildTeamConfig().systemAuthorization.otp, Date.parse('2026-10-04T12:00:00Z') / 1000).channel, 'sms');
    assert.ok(bundles.every(bundle => bundle.entry.every(entry => !['Consent', 'Contract'].includes(entry.resource.resourceType))));
});

test('fixture configuration is explicit, validated and does not mutate the empty default', () => {
    const { configureWorkflowFixtures } = require('../../pcm-connectathon/scripts/configure-system-workflow-fixtures');
    const config = buildTeamConfig();
    const configured = configureWorkflowFixtures(config);
    assert.equal(config.systemAuthorization.memberships.length, 0);
    assert.equal(configured.systemAuthorization.memberships.length, 1);
    assert.equal(configured.systemAuthorization.discovery.eligibleRelationships[0].code, 'parent');
    assert.throws(() => configureWorkflowFixtures({ ...config, healthOrganizations: [] }), /requires managed HOs/);
});

test('workflow bundles enter the existing explicit managed-HAPI import boundary', () => {
    const { inspectTransactionBundle } = require('../transaction-bundle');
    for (const [index, bundle] of bundles.entries()) {
        const inventory = inspectTransactionBundle(Buffer.from(JSON.stringify(bundle)), { expectedSource: `ho-${'abc'[index]}` });
        assert.ok(inventory.counts.Patient > 0);
        assert.ok(inventory.counts.RelatedPerson > 0);
    }
});

test('candidate 0.4.2 fixtures are opt-in and carry demographics, discovery and explicit HTEST membership', () => {
    const { candidateWorkflowFixtures } = require('../pcm-ig-042-workflows');
    const selected = candidateWorkflowFixtures(Date.parse('2026-10-19T00:00:00Z'));
    const { configureWorkflowFixtures } = require('../../pcm-connectathon/scripts/configure-system-workflow-fixtures');
    const configuration = configureWorkflowFixtures(buildTeamConfig(), { candidate042: true });
    assert.equal(configuration.systemAuthorization.memberships.length, 5);
    assert.equal(configuration.systemAuthorization.memberships.filter(value => value.sandboxFixture === true).length, 2);
    for (const bundle of Object.values(selected.bundles)) for (const { resource } of bundle.entry) {
        assert.ok(resource.meta.security.some(value => value.code === 'patientDemographics'));
        if (resource.resourceType === 'RelatedPerson') assert.ok(resource.meta.tag.some(value => value.code === 'hmo-dependent-discovery'));
    }
    assert.equal(workflow.memberships.length, 1);
});

test('all candidate workflow bundles pass the real import validator and preserve deterministic UUIDs', () => {
    const { candidateWorkflowFixtures } = require('../pcm-ig-042-workflows');
    const { inspectTransactionBundle, DATASET_TAG_SYSTEM } = require('../transaction-bundle');
    const now = Date.parse('2026-10-19T00:00:00Z'), selected = candidateWorkflowFixtures(now), later = candidateWorkflowFixtures(now + 1000);
    for (const [ho, bundle] of Object.entries(selected.bundles)) {
        const inspected = inspectTransactionBundle(Buffer.from(JSON.stringify(bundle)), { expectedSource: ho });
        assert.equal(inspected.entries, { 'ho-a': 10, 'ho-b': 10, 'ho-c': 10 }[ho]);
        assert.equal(inspected.version, 'pcm-ig-042-system-workflows');
        assert.deepEqual(bundle.entry.map(entry => entry.fullUrl), later.bundles[ho].entry.map(entry => entry.fullUrl));
        assert.equal(new Set(bundle.entry.map(entry => entry.fullUrl)).size, bundle.entry.length);
        for (const membership of selected.configuration.memberships.filter(value => value.homeHmoId === ho)) {
            const patient = bundle.entry.map(entry => entry.resource).find(resource => resource.resourceType === 'Patient'
                && resource.identifier.some(id => id.system === membership.identifier.system && id.value === membership.identifier.value));
            assert.ok(patient, 'every enrolled home-HMO identity has a real source Patient');
            assert.equal(selectOtpContact(patient, buildTeamConfig().systemAuthorization.otp, now / 1000).channel, 'sms');
        }
        const invalid = structuredClone(bundle);
        delete invalid.entry[5].fullUrl;
        assert.throws(() => inspectTransactionBundle(Buffer.from(JSON.stringify(invalid))), /entry 5 fullUrl must be a urn:uuid/);
        invalid.entry[5].fullUrl = 'urn:uuid:not-a-uuid';
        assert.throws(() => inspectTransactionBundle(Buffer.from(JSON.stringify(invalid))), /entry 5 fullUrl must be a urn:uuid/);
        const missingTag = structuredClone(bundle);
        missingTag.entry[5].resource.meta.tag = missingTag.entry[5].resource.meta.tag.filter(tag => tag.system !== DATASET_TAG_SYSTEM);
        assert.throws(() => inspectTransactionBundle(Buffer.from(JSON.stringify(missingTag))), /synthetic dataset/);
    }
    const { configureWorkflowFixtures } = require('../../pcm-connectathon/scripts/configure-system-workflow-fixtures');
    for (const preset of require('../../src/shared/conformance-policy').PRESETS) {
        const original = buildTeamConfig({}, preset), configured = configureWorkflowFixtures(original, { candidate042: true });
        assert.deepEqual(configured.securitySimulation, original.securitySimulation);
        assert.deepEqual(configured.contract, original.contract);
    }
});

/** A positive foreign login must select the actual registered fixture source. */
test('candidate foreign Patient and eligibility facts belong only to HMO C, with no A/B fallback', () => {
    const now = Date.parse('2026-10-19T00:00:00Z');
    const fixture = require('../pcm-ig-042-workflows').candidateWorkflowFixtures(now);
    const foreign = fixture.configuration.memberships.filter(member => member.homeHmoId === 'ho-c');
    assert.equal(foreign.length, 2);
    for (const member of foreign) {
        for (const [source, bundle] of Object.entries(fixture.bundles)) {
            const patients = bundle.entry.map(entry => entry.resource).filter(resource => resource.resourceType === 'Patient'
                && resource.identifier.some(identifier => identifier.system === member.identifier.system && identifier.value === member.identifier.value));
            assert.equal(patients.length, source === member.homeHmoId ? 1 : 0);
            const response = { resourceType: 'Bundle', type: 'searchset', entry: patients.map(resource => ({ resource })) };
            if (source === member.homeHmoId) {
                const patient = authenticationPatient(response, member.identifier, '1990-01-01');
                assert.equal(selectOtpContact(patient, buildTeamConfig().systemAuthorization.otp, now / 1000).channel, 'sms');
            } else assert.throws(() => authenticationPatient(response, member.identifier, '1990-01-01'));
        }
        if (member.identifier.system.includes('passport')) assert.deepEqual(member.loginEligibility,
            { foreignPassportEligible: true, israeliNationalWithId: false });
    }
});
