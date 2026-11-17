'use strict';

/** Explicit disposable-fixture qualification of the production offline metadata publication owner. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const checkpoint = require('../src/pcm-core/src/migration-checkpoint');
const migration = require('../pcm-connectathon/scripts/pcm-ig-041-migration');
const { artifacts } = require('../src/shared/public-metadata-compatibility');
const { VERSIONS } = require('../src/shared/scope-model-versions');

/** Freeze quiescent owned fixture, review complete measured inputs, apply and hydrate its restart state. */
function cutoverFixture({ store, configPath = process.env.TEAM_CONFIG_PATH, stateDirectory = process.env.STATE_DIR, certsDirectory = process.env.CERTS_DIR }) {
    const config = JSON.parse(fs.readFileSync(configPath));
    const repositoryRoot = path.resolve(__dirname, '..'), components = artifacts(repositoryRoot);
    if (config.serviceCatalog?.file) {
        const file = path.join(path.dirname(configPath), config.serviceCatalog.file);
        if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(path.join(repositoryRoot, config.serviceCatalog.file), file); }
    }
    const reviewPath = path.join(path.dirname(configPath), 'metadata-qualification-review.json');
    const review = { schema: 'pcm-public-metadata-review/1', optIn: true, restartAll: true, action: 'relocate', repositoryRoot,
        components, runtime: { before: components.pcm, after: components.pcm }, privateSchema: 'pcm-private-state/1', publicProjectionSchema: 'pcm-public-fhir/1', scopeVersions: VERSIONS };
    const original = checkpoint.snapshot(store, { privateState: true });
    checkpoint.prepare({ store, configPath, stateDirectory, runtimeId: components.pcm });
    fs.writeFileSync(reviewPath, checkpoint.encode(review));
    const options = { configPath, stateDirectory, certsDirectory, reviewPath, workersStopped: true, stoppedAt: new Date(Date.now() - 60000).toISOString() };
    const observed = migration.plan(options);
    Object.assign(review, { records: observed.requiredReview, bindings: observed.measuredBindings });
    fs.writeFileSync(reviewPath, checkpoint.encode(review));
    const plan = migration.plan(options); assert.deepEqual(plan.errors, []);
    const applied = migration.apply({ ...options, expectedDigest: plan.digest });
    checkpoint.restore({ ...options, store, runtimeId: components.pcm });
    assert.deepEqual(checkpoint.snapshot(store, { privateState: true }), original);
    return { digest: plan.digest, compatibility: plan.compatibility, inventory: plan.inventory, status: applied.status,
        checkpointHash: JSON.parse(fs.readFileSync(path.join(stateDirectory, 'pcm-ig-041/manifest.json'))).checkpointHash };
}
module.exports = { cutoverFixture };
