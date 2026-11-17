'use strict';
/** Qualification touches only an explicitly owned disposable team; maintenance setup is separate from application access. */
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { fixtureSelections, verifyFixturePatients } = require('../pcm-connectathon/scripts/fixture-patients');
const { request } = require('../pcm-connectathon/scripts/sanity-request');
const config = JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));
if (config.teamId !== 'sample-qualification') throw new Error('qualification requires its disposable owned team');
const ca = fs.readFileSync(path.join(process.env.CERTS_DIR, config.certificates.rootCaCert));
const options = { ca };
const selections = fixtureSelections(config, path.resolve(__dirname, '../clinical-data/ci'));

/** Submit an explicitly selected fixture using the same per-HO maintenance credential as Admin. */
async function writeFixture(ho, json, suffix = '') {
    const result = await request(suffix ? 'PUT' : 'POST', `${ho.clinicalData.privateFhirBaseUrl}${suffix}`, {
        json, tls: { ca, rejectUnauthorized: true }, prohibitRedirects: true, timeout: 30000, maxResponseBytes: 1024 * 1024,
        headers: { 'X-PCM-Import-Credential': process.env[ho.import.credentialEnv] }
    });
    assert.ok([200, 201].includes(result.statusCode), `private fixture write failed: ${result.statusCode || result.error}`);
}
async function main() {
    const result = { teamId: config.teamId, preset: config.conformance.preset, setupMethod: 'private-named-fixture-read', negatives: [] };
    if (process.argv.includes('--empty-source')) {
        const ho = config.healthOrganizations[1];
        const adminHeaders = { 'X-Admin-Password': process.env.TEAM_ADMIN_PASSWORD };
        const deleted = await request('DELETE', `${config.internalBaseUrls.pcmUi}/admin/api/fhir-servers/${ho.id}/data`, {
            json: { confirmation: `delete-all:${config.teamId}:${ho.id}` }, headers: adminHeaders
        });
        assert.equal(deleted.statusCode, 202);
        const deadline = Date.now() + 30000;
        let phase;
        do {
            const operation = await request('GET', `${config.internalBaseUrls.pcmUi}/admin/api/data-operations/${deleted.json.id}`, { headers: adminHeaders });
            phase = operation.json?.phase;
            if (phase === 'failed' || Date.now() > deadline) throw new Error('owned empty-source setup failed');
            if (phase !== 'succeeded') await new Promise(resolve => setTimeout(resolve, 250));
        } while (phase !== 'succeeded');
        const counts = await request('GET', `${config.internalBaseUrls.pcmUi}/admin/api/fhir-servers/${ho.id}/data`, { headers: adminHeaders, timeout: 180000 });
        assert.equal(counts.statusCode, 200); assert.equal(counts.json.actualCounts.Patient, 0); assert.equal(counts.json.actualResourceCount, 0);
        const empty = await verifyFixturePatients(config, [selections[1]], options);
        assert.equal(empty.sources[0].state, 'failed'); assert.equal(empty.patients.length, 0);
        result.emptySource = { sourceId: ho.id, actualCounts: counts.json.actualCounts, actualResourceCount: counts.json.actualResourceCount,
            fixtureState: empty.sources[0].state, reason: empty.sources[0].reason };
    }
    const before = await verifyFixturePatients(config, selections, options);
    result.before = before.sources.map(({ sourceId, state, reason }) => ({ sourceId, state, reason }));
    if (process.argv.includes('--seed')) for (const ho of config.healthOrganizations) await writeFixture(ho, require(`../clinical-data/ci/${ho.id}.source.transaction.json`));
    const facts = await verifyFixturePatients(config, selections, options);
    assert.ok(facts.sources.every(source => source.state === 'verified')); result.verified = facts;
    for (const ho of config.healthOrganizations) {
        const selection = selections.find(item => item.sourceId === ho.id);
        for (const [name, credential] of [['missing', ''], ['wrong', 'wrong-test-only'.repeat(4)], ['cross-HO', process.env[config.healthOrganizations.find(item => item.id !== ho.id).import.credentialEnv]]]) {
            const failure = await verifyFixturePatients(config, [selection], { ca, env: { ...process.env, [ho.import.credentialEnv]: credential } });
            assert.equal(failure.sources[0].state, 'failed'); assert.equal(failure.patients.length, 0);
            result.negatives.push({ sourceId: ho.id, name, state: failure.sources[0].state, reason: failure.sources[0].reason });
        }
    }
    const firstHo = config.healthOrganizations[0], selection = selections[0];
    const missing = await verifyFixturePatients(config, [{ ...selection, patients: [{ ...selection.patients[0], id: 'inventory-nonexistent-fixture' }] }], options);
    assert.equal(missing.sources[0].state, 'failed'); result.negatives.push({ name: 'missing-loaded-patient', reason: missing.sources[0].reason });
    const unavailableConfig = structuredClone(config); unavailableConfig.healthOrganizations[0].clinicalData.privateFhirBaseUrl = 'https://ho-a-hapi:1/fhir';
    const unavailable = await verifyFixturePatients(unavailableConfig, [selection], options);
    assert.equal(unavailable.sources[0].state, 'failed'); result.negatives.push({ name: 'unavailable-source', reason: unavailable.sources[0].reason });
    const original = require(`../clinical-data/ci/${firstHo.id}.source.transaction.json`).entry.find(entry => entry.resource.id === selection.patients[0].id).resource;
    const replaced = structuredClone(original); replaced.identifier[0].value = '000000999';
    try {
        await writeFixture(firstHo, replaced, `/Patient/${original.id}`);
        const stale = await verifyFixturePatients(config, [selection], options);
        assert.equal(stale.sources[0].state, 'failed'); assert.equal(stale.patients.length, 0);
        result.negatives.push({ name: 'replaced-loaded-fixture', reason: stale.sources[0].reason });
    } finally { await writeFixture(firstHo, original, `/Patient/${original.id}`); }
    const removed = await request('GET', `${config.internalBaseUrls.pcmUi}/sandbox/api/patients`, { prohibitRedirects: true });
    const protectedAdmin = await request('GET', `${config.internalBaseUrls.pcmUi}/admin/api/patients`, { prohibitRedirects: true });
    assert.equal(removed.statusCode, 404); assert.equal(protectedAdmin.statusCode, 401);
    result.routes = { retiredAnonymous: removed.statusCode, unauthenticatedAdmin: protectedAdmin.statusCode };
    console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
