#!/usr/bin/env node
'use strict';
/** Read-only, private test setup: verify explicitly selected Patient fixtures on their named HAPI. */
const fs = require('fs');
const path = require('path');
const { inspectTransactionBundle, safeBundlePath, DATASET_TAG_SYSTEM, SOURCE_TAG_SYSTEM } = require(fs.existsSync(path.resolve(__dirname, '../../clinical-data')) ? '../../clinical-data/transaction-bundle' : '/clinical-data/transaction-bundle');
const { request } = require('./sanity-request');
const { run, requireSafeTeamId, readValidatedTeamConfig } = require('./lib');

/** Select named fixtures; never enumerate a source.
 * @param {object} config Validated team with explicit named HO mappings.
 * @param {string} [fixtureRoot] Explicit fixture directory; otherwise use configured bootstrap references.
 * @returns {object[]} At most ten actionable Patient identities per HO, with selected dataset/hash.
 */
function fixtureSelections(config, fixtureRoot) {
    return config.healthOrganizations.map(ho => {
        const reference = ho.clinicalData.bootstrap.bundleReference || (fixtureRoot ? `${ho.id}.source.transaction.json` : '');
        if (!reference) return { sourceId: ho.id, state: 'not-applicable', reason: 'no-selected-fixture', patients: [] };
        const file = safeBundlePath(path.resolve(fixtureRoot || ho.clinicalData.bundleRoot), reference);
        const bytes = fs.readFileSync(file);
        const inspected = inspectTransactionBundle(bytes, { limits: ho.clinicalData.limits });
        if (ho.clinicalData.bootstrap.expectedSource && inspected.source !== ho.clinicalData.bootstrap.expectedSource) throw new Error(`${ho.id}: selected fixture source mismatch`);
        const resources = JSON.parse(bytes).entry.map(entry => entry.resource).filter(resource => resource.resourceType === 'Patient'
            && inspected.patients.some(patient => resource.identifier.some(id => id.system === patient.idSystem && id.value === patient.idValue))).slice(0, 10);
        return { sourceId: ho.id, state: resources.length ? 'selected' : 'empty', sha256: inspected.sha256,
            dataset: inspected.version, source: inspected.source,
            patients: resources.map(resource => ({ id: resource.id, identifier: resource.identifier.filter(id => inspected.patients.some(patient => patient.idSystem === id.system && patient.idValue === id.value)).slice(0, 1), display: resource.name?.[0]?.text || resource.id })) };
    });
}

/** Verify selected identities and tags using only each HO's persisted maintenance credential.
 * @param {object} config Validated team; private endpoints and credential names come only from it.
 * @param {object[]} selections Explicit named fixture selections.
 * @param {object} [options] Private environment, transport and trusted CA; injectable for boundary tests.
 * @returns {Promise<object>} Bounded source facts and verified identities without secrets/private URLs.
 */
async function verifyFixturePatients(config, selections, { env = process.env, transport = request, ca } = {}) {
    if (!Array.isArray(selections) || selections.length > config.healthOrganizations.length
        || new Set(selections.map(item => item.sourceId)).size !== selections.length) throw new Error('invalid fixture source selection');
    const sources = [];
    for (const selection of selections) {
        const ho = config.healthOrganizations.find(item => item.id === selection.sourceId);
        if (!ho || !['selected', 'empty', 'not-applicable'].includes(selection.state) || !Array.isArray(selection.patients) || selection.patients.length > 10) throw new Error('invalid named fixture target');
        const fact = { sourceId: ho.id, state: selection.state, sha256: selection.sha256, patients: [], reason: selection.reason };
        sources.push(fact);
        if (selection.state === 'not-applicable' || !selection.patients.length) continue;
        const credential = env[ho.import.credentialEnv];
        if (!credential || credential.length < 32) { fact.state = 'failed'; fact.reason = 'missing-maintenance-credential'; continue; }
        // No caller-supplied destination, query, redirect or cross-source credential fallback.
        for (const expected of selection.patients) {
            if (!/^[A-Za-z0-9.-]{1,64}$/.test(expected.id) || expected.identifier?.length !== 1 || !selection.dataset || !selection.source) throw new Error('invalid selected fixture identity');
            const response = await transport('GET', `${ho.clinicalData.privateFhirBaseUrl.replace(/\/+$/, '')}/Patient/${expected.id}`, {
                headers: { Accept: 'application/fhir+json', 'X-PCM-Import-Credential': credential },
                tls: { ca, rejectUnauthorized: true }, timeout: 10000, maxResponseBytes: 128 * 1024, prohibitRedirects: true
            });
            const patient = response.json;
            const tags = patient?.meta?.tag || [];
            const matches = response.statusCode === 200 && patient?.resourceType === 'Patient' && patient.id === expected.id
                && expected.identifier.every(id => patient.identifier?.some(actual => actual.system === id.system && actual.value === id.value))
                && tags.filter(tag => tag.system === DATASET_TAG_SYSTEM).length === 1
                && tags.some(tag => tag.system === DATASET_TAG_SYSTEM && tag.code === selection.dataset)
                && tags.filter(tag => tag.system === SOURCE_TAG_SYSTEM).length === 1
                && tags.some(tag => tag.system === SOURCE_TAG_SYSTEM && tag.code === selection.source);
            if (!matches) { fact.state = 'failed'; fact.reason = response.error ? 'source-unavailable' : `missing-or-replaced-fixture:${response.statusCode}`; fact.patients = []; break; }
            for (const id of expected.identifier) fact.patients.push({ idSystem: id.system, idValue: String(id.value), display: expected.display,
                sources: [{ serverId: ho.id }], resourceId: expected.id });
            fact.state = 'verified';
        }
    }
    return { method: 'private-named-fixture-read', teamId: config.teamId, observedAt: new Date().toISOString(), sources,
        patients: sources.flatMap(source => source.patients) };
}

/** Run private verification in the selected PCM backend; credentials never leave it.
 * @param {object} config Validated selected team.
 * @param {string} [fixtureRoot] Explicit fixture directory.
 * @param {object} [options] Backend mode/CA or explicit fresh-empty test setup.
 * @returns {object|Promise<object>} Bounded setup facts; this does not authorize application access.
 */
function inspectTeamFixtures(config, fixtureRoot, { privateRunner = false, noFixtureSetup = false, ca } = {}) {
    requireSafeTeamId(config.teamId);
    const selections = noFixtureSetup ? config.healthOrganizations.map(ho => ({ sourceId: ho.id, state: 'not-applicable', reason: 'explicit-empty-source-test', patients: [] })) : fixtureSelections(config, fixtureRoot);
    if (privateRunner) return verifyFixturePatients(config, selections, { ca });
    if (selections.every(selection => selection.state === 'not-applicable')) return { method: 'private-named-fixture-read', teamId: config.teamId, observedAt: new Date().toISOString(), sources: selections, patients: [] };
    const output = run('docker', ['exec', '-i', `${config.teamId}-pcm-core-1`, 'node', '/workspace/pcm-connectathon/scripts/fixture-patients.js'], {
        capture: true, stdio: ['pipe', 'pipe', 'pipe'], input: JSON.stringify(selections), timeout: 320000, maxBuffer: 1024 * 1024
    });
    const result = JSON.parse(output);
    if (result.teamId !== config.teamId || result.method !== 'private-named-fixture-read') throw new Error('fixture backend team mismatch');
    return result;
}

if (require.main === module) {
    (async () => {
        const config = readValidatedTeamConfig(process.env.TEAM_CONFIG_PATH || '/runtime/team-config.json');
        const selections = JSON.parse(fs.readFileSync(0, 'utf8'));
        const ca = fs.readFileSync(path.join(process.env.CERTS_DIR || '/certs', config.certificates.rootCaCert));
        process.stdout.write(JSON.stringify(await verifyFixturePatients(config, selections, { ca })));
    })().catch(() => { console.error('private fixture inspection failed'); process.exitCode = 1; });
}
module.exports = { fixtureSelections, verifyFixturePatients, inspectTeamFixtures };
