'use strict';

/** Separate real process restart/refusal exercises for each post-cutover authority restriction. */
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { fixture, treeHashes } = require('./pcm-ig-041-migration-fixture');
const { start, request, token, prepareFixture } = require('./pcm-ig-041-runtime');
const migration = require('../scripts/pcm-ig-041-migration');
const checkpoint = require('../../src/pcm-core/src/migration-checkpoint');

/** Exercise each restriction in a new disposable team; denied restore does not need a token drain. */
async function main() {
    const artifacts = JSON.parse(fs.readFileSync(process.env.PCM04108_ARTIFACTS)), rows = [];
    for (const restriction of ['revoke', 'remove-source', 'shorten-validity']) {
        const f = fixture(null, { preset: 'connectathon-balanced' }); let runtime;
        try {
            const { config, certRoot } = prepareFixture(f, artifacts);
            // No before-runtime or tokens have been started in this new fixture.
            // Capture its synthetic historical graph and apply before first startup.
            const store = new (require('../../src/pcm-core/src/fhir/store').FHIRStore)();
            checkpoint.restore({ store, ...f.options, runtimeId: artifacts.before.id });
            checkpoint.prepare({ store, ...f.options, runtimeId: artifacts.before.id });
            const preview = migration.plan(f.options); assert.deepEqual(preview.errors, []);
            migration.apply({ ...f.options, expectedDigest: preview.digest });
            runtime = await start(f, artifacts.after.root, artifacts.after.id, false);
            await new Promise(resolve => { runtime.processChild.once('message', resolve); runtime.processChild.send({ kind: 'restriction', restriction }); });
            await runtime.stop(); runtime = await start(f, artifacts.after.root, artifacts.after.id, false);
            const patient = config.systemAuthorization.presenceEligiblePatients[0];
            const details = [{ type: 'https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access', fhirContext: [
                { type: 'Contract', role: 'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-basis', identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id', value: 'PCM-POLICY-PRESENCE-001' } },
                { type: 'Patient', role: 'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-patient', identifier: patient }
            ] }];
            const denied = await token(runtime, config, config.oauthClients.presenceOrchestrator.clientId, path.join(certRoot, 'presence-orchestrator-assertion.key'), { scope: 'system/Patient.s', resource: config.healthOrganizations[0].endpoint, details });
            assert.equal(denied.status, 400, denied.text);
            assert.equal((await request(runtime.ui, '/admin/migration/checkpoint', { plain: true, admin: true, body: {} })).status, 200);
            await runtime.stop(); runtime = null;
            const before = treeHashes(f.directory);
            assert.throws(() => migration.rollback({ ...f.options, stoppedAt: new Date().toISOString() }), /UNSAFE RESTORE/);
            assert.deepEqual(treeHashes(f.directory), before);
            migration.resumeCurrent(f.options);
            runtime = await start(f, artifacts.after.root, artifacts.after.id, false);
            rows.push({ restriction, runtimeRestarted: true, freshIssuanceStatus: denied.status, rollback: 'unsafe-restore-refused-without-writes', currentRuntimeResumed: true,
                checkpointHash: checkpoint.sha256(fs.readFileSync(path.join(f.root, 'checkpoint.json'))) });
            console.log(JSON.stringify(rows.at(-1)));
            await runtime.stop(); runtime = null;
        } finally { runtime?.processChild.kill('SIGKILL'); fs.rmSync(f.directory, { recursive: true, force: true }); }
    }
    fs.writeFileSync(process.env.PCM04108_RESTRICTION_RESULT, checkpoint.encode({ status: 'passed', artifacts: { before: artifacts.before.id, after: artifacts.after.id }, rows }));
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
