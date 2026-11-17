'use strict';
/** Exact reviewed source/policy binding and protected no-authority reconciliation. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { dataGrantFixture, NOW } = require('../../../test-support/data-grants');
const { workflowSourceReview } = require('../src/workflow-source-configuration');
test('mixed HMO/hospital/custom/disabled/removed projections and unavailable policies remain inspection-only', () => {
    const f = dataGrantFixture(); f.config.healthOrganizations[1].institutionType = 'hospital';
    f.config.healthOrganizations[2].institutionType = 'other';
    f.config.organizations.dataSources = [
        { id: 'custom-hmo', name: 'Custom HMO', endpoint: 'https://custom.test/fhir', institutionType: 'hmo' },
        { id: 'disabled-hmo', endpoint: 'https://disabled.test/fhir', institutionType: 'hmo', enabled: false }
    ];
    const before = structuredClone(f.store.getAll('Contract'));
    const review = workflowSourceReview(f.store, f.config, NOW);
    assert.deepEqual(review.sources, ['Organization/custom-hmo', `Organization/${f.config.healthOrganizations[0].dataSourceOrganization.id}`].sort());
    assert.equal(review.policies.length, 2); assert.equal(review.policies[0].before.length, 3); assert.equal(review.policies[0].after.length, 2);
    assert.deepEqual(f.store.getAll('Contract'), before); assert.ok(review.sourceVersions[`Endpoint/${f.source.endpointId}`]);
    f.config.organizations.dataSources = []; assert.ok(!workflowSourceReview(f.store, f.config, NOW).sources.includes('Organization/custom-hmo'));
    const contract = f.store.get('Contract', 'policy-patient-authentication'); f.store.update({ ...contract, applies: { ...contract.applies, end: new Date((NOW + 1) * 1000).toISOString() } });
    const expired = workflowSourceReview(f.store, f.config, NOW + 2); assert.equal(expired.policies.find(policy => policy.id === contract.id).validNow, false); assert.match(expired.blockers[0], /not currently executed/);
    f.store.data.Contract.delete('policy-dependent-discovery'); assert.deepEqual(workflowSourceReview(f.store, f.config, NOW + 2).missingScenarios, ['dependent-discovery']);
});
test('actual protected review/apply rejects stale source and policy versions, unavailable policy and publication faults', async t => {
    const runtime = await require('../../../test-support/pcm-042-runtime').startRuntime(); t.after(() => runtime.close()); await require('../src/bootstrap')();
    const store = require('../src/fhir/store'), owner = require('../src/team-config');
    const headers = { 'x-admin-password': '04102-local-fixture-only', Accept: 'application/json', 'Content-Type': 'application/json' };
    const preview = async () => { const response = await fetch(`${runtime.config.publicBaseUrls.pcmUi}/admin/workflow-sources/preview`, { headers }); assert.equal(response.status, 200); return response.json(); };
    const apply = plan => fetch(`${runtime.config.publicBaseUrls.pcmUi}/admin/workflow-sources/apply`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: plan.revision, versions: plan.versions, sources: plan.sources, sourceVersions: plan.sourceVersions, reviewDigest: plan.reviewDigest }) });
    const unauthenticated = { Accept: 'application/json', 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${runtime.config.publicBaseUrls.pcmUi}/admin/config/test-workflows`, { method: 'POST', headers: unauthenticated, body: '{}' })).status, 401);
    assert.equal((await fetch(`${runtime.config.publicBaseUrls.pcmUi}/admin/workflow-sources/preview`, { headers: unauthenticated })).status, 401);
    assert.equal((await fetch(`${runtime.config.publicBaseUrls.pcmUi}/admin/workflow-sources/apply`, { method: 'POST', headers: unauthenticated, body: '{}' })).status, 401);
    let plan = await preview(); const original = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    store.update(store.get('Endpoint', runtime.config.healthOrganizations[0].endpointId)); assert.equal((await apply(plan)).status, 409); assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), original);
    plan = await preview(); store.update(store.get('Contract', 'policy-patient-authentication')); assert.equal((await apply(plan)).status, 409);
    plan = await preview(); assert.equal((await apply(plan)).status, 200); assert.equal((await apply(plan)).status, 409);
    const contract = store.get('Contract', 'policy-patient-authentication'); store.update({ ...contract, status: 'revoked' }); plan = await preview(); assert.equal(plan.policies.find(policy => policy.id === contract.id).validNow, false); assert.equal((await apply(plan)).status, 409);
    const terminalBefore = store.getAll('Contract'), terminalConfig = owner.loadTeamConfig();
    const terminalBody = { expectedRevision: terminalConfig.runtime.revision, ...Object.fromEntries(require('../src/admin-workflows').FIELDS.map(field => [field.key, terminalConfig.systemAuthorization[field.group][field.name]])), 'otp.maxAttempts': 4 };
    const terminalSave = await fetch(`${runtime.config.publicBaseUrls.pcmUi}/admin/config/test-workflows`, { method: 'POST', headers, body: JSON.stringify(terminalBody) });
    assert.equal(terminalSave.status, 200); assert.deepEqual(store.getAll('Contract'), terminalBefore, 'clock settings cannot revive or extend terminal Contract policy');
    store.update({ ...contract, status: 'executed' });
    // Explicit stale source asset requires private backup + policy write; inject the final publisher fault.
    const config = owner.loadTeamConfig(); config.healthOrganizations[1].institutionType = 'hospital'; fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
    plan = await preview(); const bytes = fs.readFileSync(process.env.TEAM_CONFIG_PATH), policies = store.getAll('Contract'), privatePolicies = structuredClone(store.privateState);
    const publish = owner.publishTeamConfig; owner.publishTeamConfig = candidate => { publish(candidate); throw new Error('owned workflow publication failure after config rename'); };
    try { const failed = await apply(plan); assert.equal(failed.status, 409); assert.match((await failed.json()).error, /owned workflow/); } finally { owner.publishTeamConfig = publish; }
    assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), bytes); assert.deepEqual(store.getAll('Contract'), policies); assert.deepEqual(structuredClone(store.privateState), privatePolicies);
    assert.equal((await apply(await preview())).status, 200);
    const backups = require('node:path').join(process.env.STATE_DIR, 'workflow-source-backups'); assert.ok(fs.readdirSync(backups).length); for (const file of fs.readdirSync(backups)) assert.equal(fs.statSync(require('node:path').join(backups, file)).mode & 0o777, 0o600);
    // An attached checkpoint failure must retain the accepted journal/fence, never report a save.
    const checkpoint = require('../src/migration-checkpoint'), path = require('node:path');
    const root = path.join(process.env.STATE_DIR, 'pcm-ig-041'); fs.mkdirSync(root, { recursive: true });
    const beforeConfig = fs.readFileSync(process.env.TEAM_CONFIG_PATH), beforeGraph = checkpoint.snapshot(store, { privateState: true });
    const beforeCheckpoint = checkpoint.encode(beforeGraph);
    const beforeManifest = checkpoint.encode({ schema: 'pcm-migration/1', phase: 'applied', runtimeId: `sha256:${'b'.repeat(64)}`, configHash: checkpoint.sha256(beforeConfig), checkpointHash: checkpoint.sha256(beforeCheckpoint) });
    fs.writeFileSync(path.join(root, 'checkpoint.json'), beforeCheckpoint); fs.writeFileSync(path.join(root, 'manifest.json'), beforeManifest); checkpoint.attach(store, process.env.STATE_DIR);
    const latest = owner.loadTeamConfig(), body = { expectedRevision: latest.runtime.revision, ...Object.fromEntries(require('../src/admin-workflows').FIELDS.map(field => [field.key, latest.systemAuthorization[field.group][field.name]])), 'otp.maxAttempts': 4 };
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === path.join(root, 'checkpoint.json')) throw new Error('owned workflow checkpoint publication failure'); return rename(from, to); };
    try {
        const uncertain = await fetch(`${runtime.config.publicBaseUrls.pcmUi}/admin/config/test-workflows`, { method: 'POST', headers, body: JSON.stringify(body) });
        assert.equal(uncertain.status, 503); assert.match((await uncertain.json()).error, /uncertain and fenced/);
    } finally { fs.renameSync = rename; }
    assert.deepEqual(checkpoint.snapshot(store, { privateState: true }), beforeGraph);
    assert.throws(() => require('../../shared/migration-maintenance').assertAvailable(process.env.STATE_DIR), /maintenance/);
    const journalFile = path.join(process.env.STATE_DIR, 'configuration-mutation/source-publication.json'), journal = JSON.parse(fs.readFileSync(journalFile));
    assert.equal(journal.sourceId, 'workflow-configuration'); assert.deepEqual(journal.files, {});
    const recovery = { stateDirectory: process.env.STATE_DIR, configPath: process.env.TEAM_CONFIG_PATH, certsDirectory: process.env.CERTS_DIR, workersStopped: true, expectedDigest: require('../../shared/migration-hash').hash(journal) };
    assert.throws(() => require('../../../pcm-connectathon/scripts/reconcile-pcm-handoff').recoverMutation({ ...recovery, expectedDigest: 'wrong' }), /exact source/);
    assert.equal(require('../../../pcm-connectathon/scripts/reconcile-pcm-handoff').recoverMutation(recovery).status, 'rolled-back-reviewed-source-publication');
    assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), beforeConfig); assert.deepEqual(fs.readFileSync(path.join(root, 'checkpoint.json')), beforeCheckpoint); assert.deepEqual(fs.readFileSync(path.join(root, 'manifest.json')), beforeManifest);
    assert.equal(fs.existsSync(journalFile), false); assert.equal(fs.existsSync(path.join(root, 'checkpoint-mutation.json')), false);

});
