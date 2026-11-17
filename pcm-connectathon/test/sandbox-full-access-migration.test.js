'use strict';
/** Real stopped journal migration preserves narrow decisions, choices and original usage bytes. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const migration = require('../scripts/pcm-ig-041-migration');
const checkpoint = require('../../src/pcm-core/src/migration-checkpoint');
const { fullAccessFixture } = require('../../test-support/sandbox-full-access-fixture');
const lifecycle = require('../../src/pcm-core/src/fhir/healthcare-service-lifecycle');
const { EXACT } = require('../../test-support/consent-request-fixture');
const { artifacts } = require('../../src/shared/public-metadata-compatibility');
const { VERSIONS } = require('../../src/shared/scope-model-versions');
const { FHIRStore } = require('../../src/pcm-core/src/fhir/store');
const { hash } = require('../../src/shared/migration-hash');
const save = (file, value) => fs.writeFileSync(file, checkpoint.encode(value));
const read = file => JSON.parse(fs.readFileSync(file));
const repositoryRoot = path.resolve(__dirname, '../..');

/** Explicitly acknowledge the current exact inventory/digests, never infer an approval. */
function review(f) {
    let plan = migration.plan(f.options);
    Object.assign(f.review, { components: plan.measuredComponents, bindings: plan.measuredBindings, records: plan.requiredReview });
    f.review.runtime.after = plan.measuredComponents.pcm;
    if (plan.requiredFullAccessReview) f.review.fullAccessReview = plan.requiredFullAccessReview.digest;
    save(f.options.reviewPath, f.review);
    plan = migration.plan(f.options);
    f.review.records = plan.requiredReview; save(f.options.reviewPath, f.review);
    return migration.plan(f.options);
}

test('offline full-access preview/apply/restart/compatible restore retain narrow approvals and provider choices; revoked rollback refuses', t => {
    const f = fullAccessFixture({ preset: 'connectathon-balanced' });
    // Construct the historical package only inside this disposable fixture, then approve normally.
    const definition = f.store.privateState.services[`HealthcareService/${lifecycle.BUILTIN_CATALOG_ID}`];
    const grant = definition.versions[definition.currentVersion].grant;
    grant.scope = EXACT; grant.authoring.approvalScope = EXACT; grant.diagnostics = require('../../src/shared/service-grant').inspectScope(EXACT).diagnostics;
    for (const consent of f.store.getAll('Consent').filter(item => require('../../src/pcm-core/src/fhir/consent-lifecycle').consentServiceId(item) === f.service.id)) {
        f.store.remove('Consent', consent.id); delete f.store.privateState.approvals[`Consent/${consent.id}`];
    }
    const narrow = f.approve(), narrowBytes = JSON.stringify(f.store.privateRecords.approvals.getDecision(narrow.id));
    let issuedRecord;
    const tokenTime = require('../../test-support/consent-request-fixture').NOW;
    const policy = require('../../src/shared/conformance-policy').buildEffectivePolicy(f.config, {});
    const issue = require('../../src/pcm-core/src/token-service').createTokenService({ fhirStore: f.store, firstUseStore: f.firstUseStore,
        tokenStore: { issue(kind, claims, lifetime) { issuedRecord = { ...claims, kind, iat: tokenTime, exp: tokenTime + lifetime }; return { token: 'opaque-owned-narrow', record: issuedRecord }; } },
        authenticate: req => { req.mtls = { thumbprint: f.client.mtlsThumbprint }; return { client: f.client, transportVerified: true, signatureVerified: true, assertionSigningThumbprint: f.client.assertionThumbprint }; },
        getIssuer: () => f.config.contract.operational.oauthBase, getConfig: () => f.config, getPolicy: () => policy, getLifetime: () => 30, clock: () => tokenTime, logger: { info() {}, warn() {} } });
    const token = issue({ body: { grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: 'owned-auth-double',
        scope: 'patient/Observation.s', resource: f.source.endpoint, authorization_details: JSON.stringify(require('../../test-support/data-grants').rar('Consent', narrow.identifier[0].value).details) } });
    assert.equal(token.status, 200); assert.equal(token.body.scope, EXACT);
    const inspectOld = store => require('../../src/pcm-core/src/introspection-service').evaluateSubjectToken({ token: issuedRecord, store, config: f.config, now: tokenTime,
        firstUseStore: f.firstUseStore, caller: { clientId: f.source.clientId, organizationId: f.source.dataSourceOrganization.id }, controls: policy.simulation.controls,
        findClient: id => id === f.client.clientId ? f.client : { role: 'data-source', clientId: f.source.clientId, organizationId: f.source.dataSourceOrganization.id } });
    assert.equal(inspectOld(f.store).scope, EXACT);
    const originalToken = JSON.stringify(issuedRecord);

    const provider = f.store.get('Organization', f.client.organizationId);
    for (const [id, override] of [['migration-paused', 'paused'], ['migration-detached', 'disconnected']]) {
        const child = require('../../src/pcm-core/src/fhir/participant-lifecycle').createServiceProviderChild({ store: f.store, callerOrganization: provider, request: { name: id }, idGenerator: () => id });
        const connection = f.store.getAll('HealthcareService').find(item => lifecycle.ownerId(item) === child.id);
        const update = state => lifecycle.transitionHealthcareService({ store: f.store, callerOrganization: child, existing: f.store.get('HealthcareService', connection.id), request: { extension: [lifecycle.statusExtension(state)] } });
        update('suspended'); if (override === 'disconnected') update('cancelled');
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-full18-offline-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const stateDirectory = path.join(directory, 'state'), configPath = path.join(directory, 'team.json'), reviewPath = path.join(directory, 'review.json'), certsDirectory = path.join(directory, 'certs');
    fs.mkdirSync(stateDirectory); fs.mkdirSync(path.join(directory, 'config'));
    fs.cpSync(require('../../test-support/certificates').certificates(), certsDirectory, { recursive: true });
    f.config.runtime.stateDir = stateDirectory; f.config.runtime.certsDir = certsDirectory;
    save(configPath, f.config); save(path.join(directory, 'config/demo-services.json'), require('../../config/demo-services.json'));
    const usage = path.join(stateDirectory, 'first-use-windows'); fs.mkdirSync(usage);
    const usageFile = path.join(usage, hash('original-full-access-first-use') + '.json'); save(usageFile, { startedAt: 1700000000, expiresAt: 1700003600 });
    const usageBytes = fs.readFileSync(usageFile);
    const accessTokens = path.join(stateDirectory, 'access-tokens'); fs.mkdirSync(accessTokens); save(path.join(accessTokens, 'old-narrow-token.json'), issuedRecord);
    const runtimeId = artifacts(repositoryRoot).pcm;
    checkpoint.prepare({ store: f.store, configPath, stateDirectory, runtimeId });
    const root = path.join(stateDirectory, 'pcm-ig-041');
    const work = { options: { configPath, stateDirectory, reviewPath, certsDirectory, workersStopped: true, stoppedAt: new Date(Date.now() - 60000).toISOString() },
        review: { schema: 'pcm-public-metadata-review/1', optIn: true, restartAll: true, action: 'full-access', asOf: '2026-11-14T00:00:00.000Z', repositoryRoot,
            runtime: { before: runtimeId, after: runtimeId }, privateSchema: 'pcm-private-state/1', publicProjectionSchema: 'pcm-public-fhir/1', scopeVersions: VERSIONS } };
    save(reviewPath, work.review); const preview = review(work);
    assert.deepEqual(preview.errors, []); assert.equal(preview.requiredFullAccessReview.newScope, 'patient/*.rs');
    assert.throws(() => migration.apply({ ...work.options, expectedDigest: 'unreviewed' }), /Stale preview digest/);
    const result = migration.apply({ ...work.options, expectedDigest: preview.digest }); assert.equal(result.status, 'applied');
    const restarted = new FHIRStore(); checkpoint.restore({ ...work.options, store: restarted, runtimeId: preview.runtime.after });
    assert.equal(restarted.privateRecords.services.getDefinition(lifecycle.BUILTIN_CATALOG_ID).grant.scope, 'patient/*.rs');
    assert.equal(JSON.stringify(restarted.privateRecords.approvals.getDecision(narrow.id)), narrowBytes);
    assert.equal(inspectOld(restarted), null, 'Original token authority generation is invalidated by the explicit definition cutover');
    assert.equal(JSON.stringify(issuedRecord), originalToken, 'Old token bytes are never widened or rewritten');
    assert.equal(restarted.privateRecords.services.getProviderDefaults('migration-paused').services[lifecycle.BUILTIN_CATALOG_ID].override, 'paused');
    assert.equal(restarted.privateRecords.services.getProviderDefaults('migration-detached').services[lifecycle.BUILTIN_CATALOG_ID].override, 'disconnected');
    assert.deepEqual(fs.readFileSync(usageFile), usageBytes); assert.equal(fs.existsSync(accessTokens), false, 'Old token cache is invalidated, never widened');
    const request = structuredClone(require('../../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json'));
    request.patient.identifier = narrow.patient.identifier;
    request.extension.find(item => item.url === require('../../src/shared/pcm-contract').EXTENSIONS.pcmService).valueReference.reference = `HealthcareService/${f.service.id}`;
    const consentOwner = require('../../src/pcm-core/src/fhir/consent-lifecycle');
    const proposed = consentOwner.createConsent({ store: restarted, config: f.config, callerOrganization: restarted.get('Organization', f.client.organizationId), request });
    const approved = consentOwner.approveConsent({ store: restarted, consent: proposed, scopeChoice: 'service-provided', sourceOrganizationIds: [f.source.dataSourceOrganization.id] });
    assert.equal(restarted.privateRecords.approvals.getDecision(approved.id).snapshot.scope, 'patient/*.rs');
    assert.equal(restarted.privateRecords.approvals.getDecision(narrow.id).snapshot.scope, EXACT);
    const complete = checkpoint.snapshot(restarted, { privateState: true });
    const backup = require('../../src/pcm-core/src/private-checkpoint').exportPrivateCheckpoint(restarted, preview.compatibility);
    save(path.join(directory, 'compatible-backup.json'), backup);
    checkpoint.prepare({ store: restarted, configPath, stateDirectory, runtimeId: preview.runtime.after });
    work.review = { ...work.review, action: 'restore', backupPath: path.join(directory, 'compatible-backup.json'), reviewedBackupHash: backup.hash };
    delete work.review.fullAccessReview;
    save(reviewPath, work.review); const restorePlan = review(work); assert.deepEqual(restorePlan.errors, []);
    assert.equal(migration.apply({ ...work.options, expectedDigest: restorePlan.digest }).status, 'applied');
    const restored = new FHIRStore(); checkpoint.restore({ ...work.options, store: restored, runtimeId: restorePlan.runtime.after });
    assert.deepEqual(checkpoint.snapshot(restored, { privateState: true }), complete);
    // A later revocation makes that same old backup ineligible; no rollback publication occurs.
    restored.update({ ...restored.get('Consent', narrow.id), status: 'inactive' });
    checkpoint.prepare({ store: restored, configPath, stateDirectory, runtimeId: restorePlan.runtime.after });
    const denied = review(work); assert.ok(denied.errors.some(error => /Unsafe restore|later/.test(error)), JSON.stringify(denied.errors));
    assert.throws(() => migration.apply({ ...work.options, expectedDigest: denied.digest }), /Unresolved migration/);
    assert.equal(read(path.join(root, 'checkpoint.json')).Consent.find(item => item.id === narrow.id).status, 'inactive');
    assert.deepEqual(fs.readFileSync(usageFile), usageBytes);
    if (process.env.FULL_ACCESS_MIGRATION_OUTPUT) save(process.env.FULL_ACCESS_MIGRATION_OUTPUT, { status: 'passed', preview: { digest: preview.digest, transition: preview.requiredFullAccessReview, records: preview.requiredReview },
        applied: result, restored: restorePlan.digest, revokedRestoreErrors: denied.errors, narrowScope: EXACT, retainedChoices: ['paused', 'disconnected'], usageHash: checkpoint.sha256(usageBytes), components: preview.measuredComponents });
});
