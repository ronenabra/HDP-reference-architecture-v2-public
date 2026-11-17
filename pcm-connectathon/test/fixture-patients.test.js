'use strict';
/** Maintenance setup facts must reflect live selected fixtures without granting Doctor authority. */
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { buildTeamConfig } = require('../../test-support/team-config');
const { fixtureSelections, verifyFixturePatients } = require('../scripts/fixture-patients');
const config = buildTeamConfig();
const fixtureRoot = path.resolve(__dirname, '../../clinical-data/ci');
const selections = fixtureSelections(config, fixtureRoot);
const credentials = Object.fromEntries(config.healthOrganizations.map(ho => [ho.import.credentialEnv, ho.id.repeat(12)]));

/** A source-bound maintenance stub rejects the wrong HO credential and returns the named source fixture. */
function sourceTransport(overrides = {}) {
    return async (_method, url, options) => {
        const ho = config.healthOrganizations.find(ho => url.startsWith(ho.clinicalData.privateFhirBaseUrl));
        assert.equal(options.prohibitRedirects, true); assert.equal(options.maxResponseBytes, 128 * 1024);
        assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.timeout, 10000);
        if (options.headers['X-PCM-Import-Credential'] !== credentials[ho.import.credentialEnv]) return { statusCode: 401 };
        const bundle = require(path.join(fixtureRoot, `${ho.id}.source.transaction.json`));
        const json = structuredClone(bundle.entry.find(entry => entry.resource.resourceType === 'Patient' && url.endsWith(`/Patient/${entry.resource.id}`)).resource);
        return overrides[ho.id] || { statusCode: 200, json };
    };
}

test('explicit fixture setup verifies each named source; credentials and private URLs never appear in results', async () => {
    const facts = await verifyFixturePatients(config, selections, { env: credentials, transport: sourceTransport() });
    assert.equal(facts.patients.length, 9); assert.ok(facts.sources.every(source => source.state === 'verified'));
    for (const secret of Object.values(credentials)) assert.ok(!JSON.stringify(facts).includes(secret));
    assert.ok(!JSON.stringify(facts).includes('hapi:8080'));
    assert.equal(fixtureSelections(config).every(selection => selection.state === 'not-applicable'), true);
});

test('missing, wrong and cross-HO credentials fail without fallback', async () => {
    for (const env of [{}, { ...credentials, PCM_A_IMPORT_CREDENTIAL: 'wrong'.repeat(10) }, { ...credentials, PCM_A_IMPORT_CREDENTIAL: credentials.PCM_B_IMPORT_CREDENTIAL }]) {
        const facts = await verifyFixturePatients(config, selections, { env, transport: sourceTransport() });
        assert.equal(facts.sources[0].state, 'failed'); assert.equal(facts.sources[0].patients.length, 0);
    }
});

test('empty, missing, replaced and unavailable fixtures cannot claim presence', async () => {
    for (const result of [{ statusCode: 404 }, { error: 'timeout' }, { statusCode: 200, json: { resourceType: 'Patient', id: selections[0].patients[0].id, identifier: selections[0].patients[0].identifier, meta: { tag: [] } } }]) {
        const facts = await verifyFixturePatients(config, selections, { env: credentials, transport: sourceTransport({ 'ho-a': result }) });
        assert.equal(facts.sources[0].state, 'failed'); assert.equal(facts.sources[0].patients.length, 0);
    }
    const empty = await verifyFixturePatients(config, [{ sourceId: 'ho-a', state: 'empty', patients: [] }], { transport() { throw new Error('must not query'); } });
    assert.equal(empty.sources[0].state, 'empty'); assert.deepEqual(empty.patients, []);
    assert.throws(() => fixtureSelections(config, '/no-such-fixture'), /ENOENT/);
});

test('target isolation rejects unknown/duplicate sources, traversal and over-sized selections', async () => {
    for (const bad of [[{ ...selections[0], sourceId: 'other' }], [selections[0], selections[0]], [{ ...selections[0], patients: Array(11).fill(selections[0].patients[0]) }], [{ ...selections[0], patients: [{ ...selections[0].patients[0], id: '../Patient' }] }]]) {
        await assert.rejects(verifyFixturePatients(config, bad, { env: credentials, transport: sourceTransport() }), /invalid/);
    }
});

test('ambiguous dataset tags and metadata destinations cannot claim a verified fixture', async () => {
    const resource = structuredClone(require(path.join(fixtureRoot, 'ho-a.source.transaction.json')).entry[0].resource);
    resource.meta.tag.push({ system: 'urn:hdp-test-bundle:synthetic-dataset', code: 'replaced-dataset' });
    const ambiguous = await verifyFixturePatients(config, [selections[0]], { env: credentials, transport: sourceTransport({ 'ho-a': { statusCode: 200, json: resource } }) });
    assert.equal(ambiguous.sources[0].state, 'failed'); assert.deepEqual(ambiguous.patients, []);
    const unsafe = structuredClone(config); unsafe.healthOrganizations[0].clinicalData.privateFhirBaseUrl = 'http://[::ffff:169.254.169.254]/fhir';
    const blocked = await verifyFixturePatients(unsafe, [selections[0]], { env: credentials });
    assert.equal(blocked.sources[0].reason, 'source-unavailable'); assert.deepEqual(blocked.patients, []);
});
