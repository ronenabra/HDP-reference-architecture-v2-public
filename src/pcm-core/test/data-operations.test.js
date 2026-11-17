'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { DataOperationRegistry, confirmationToken, latestVerifiedLoad, managedFhirServers, requireManagedFhirServer } = require('../src/data-operations');

test('managed HAPI inventory is dynamic and excludes the legacy source', () => {
    const config = require('../../../pcm-connectathon/example-team-config.json');
    assert.deepEqual(managedFhirServers(config).map(server => server.id), ['ho-a', 'ho-b', 'ho-c']);
    assert.equal(managedFhirServers(config).some(server => server.id === 'legacy-ds'), false);
    assert.throws(() => requireManagedFhirServer(config, 'legacy-ds'), /unknown managed/);
    assert.equal(confirmationToken('ho-b', 'team-a'), 'delete-all:team-a:ho-b');
});

test('operation state persists atomically and cannot regress or cross targets', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-data-operations-'));
    try {
        const registry = new DataOperationRegistry({ directory, clock: () => '2026-09-01T00:00:00.000Z' });
        const created = registry.create('ho-b', 'import', { sha256: 'a'.repeat(64) });
        registry.transition(created.id, 'validating');
        registry.transition(created.id, 'loading');
        assert.equal(registry.get(created.id).serverId, 'ho-b');
        assert.equal(registry.list('ho-a').length, 0);
        assert.throws(() => registry.transition(created.id, 'queued'), /invalid/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('server status derives active wait from saved timestamps and freezes terminal time', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-progress-timing-'));
    let now = '2026-09-01T00:00:00.000Z';
    try {
        const registry = new DataOperationRegistry({ directory, clock: () => now });
        const operation = registry.create('ho-a', 'import', { bundleName: 'sample.source.transaction.json', bytes: 200 });
        now = '2026-09-01T00:00:01.000Z';
        registry.recordProgress(operation.id, 'bundle-check-started');
        now = '2026-09-01T00:00:02.000Z';
        registry.recordProgress(operation.id, 'bundle-check-complete');
        now = '2026-09-01T00:00:03.000Z';
        registry.transition(operation.id, 'loading', { mutationSubmitted: true });
        registry.recordProgress(operation.id, 'transaction-waiting', { deadlineMs: 9000 });
        now = '2026-09-01T00:00:07.000Z';
        const reader = new DataOperationRegistry({ directory, clock: () => now });
        const waiting = reader.status(operation.id);
        assert.equal(waiting.currentStage, 'transaction-waiting');
        assert.equal(waiting.elapsedMilliseconds, 7000);
        assert.equal(waiting.waitMilliseconds, 4000);
        assert.equal(waiting.transactionDeadlineAt, '2026-09-01T00:00:12.000Z');
        assert.equal(waiting.lastCompletedStage, 'bundle-check-complete');
        assert.equal(waiting.progressEvents.at(-1).event, 'transaction-waiting');
        now = '2026-09-01T00:00:08.000Z';
        registry.recordProgress(operation.id, 'response-received');
        registry.transition(operation.id, 'verifying');
        registry.recordProgress(operation.id, 'verification-started');
        registry.recordProgress(operation.id, 'type-verified', { type: 'Patient', count: 2 });
        now = '2026-09-01T00:00:10.000Z';
        registry.transition(operation.id, 'succeeded');
        now = '2026-09-01T00:01:00.000Z';
        const terminal = reader.status(operation.id);
        assert.equal(terminal.elapsedMilliseconds, 10000);
        assert.equal(terminal.waitMilliseconds, 5000);
        assert.deepEqual(terminal.verifiedTypes, [{ type: 'Patient', count: 2 }]);
        assert.equal(terminal.progressEvents.at(-1).event, 'completed');
        assert.throws(() => registry.recordProgress(operation.id, 'reset-started'), /owner mismatch|invalid data operation transition/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('failed submitted operation keeps last completed stage and target fence after reload', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-progress-failed-'));
    try {
        const registry = new DataOperationRegistry({ directory });
        const operation = registry.create('ho-b', 'import');
        registry.recordProgress(operation.id, 'bundle-check-started');
        registry.recordProgress(operation.id, 'bundle-check-complete');
        registry.transition(operation.id, 'loading', { mutationSubmitted: true });
        registry.recordProgress(operation.id, 'transaction-waiting', { deadlineMs: 1000 });
        registry.transition(operation.id, 'failed', { needsReconciliation: true, submittedOutcome: 'unknown' });
        const reader = new DataOperationRegistry({ directory });
        const failed = reader.status(operation.id);
        assert.equal(failed.currentStage, 'reconciliation-required');
        assert.equal(failed.lastCompletedStage, 'bundle-check-complete');
        assert.equal(failed.submittedOutcome, 'unknown');
        assert.ok(Number.isFinite(failed.waitMilliseconds) && failed.waitMilliseconds >= 0);
        assert.throws(() => reader.create('ho-b', 'replace'), /busy/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('latest verified inventory is invalidated by reset and registry reads preserve unfinished work', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-data-operation-recovery-'));
    try {
        const registry = new DataOperationRegistry({ directory });
        const loaded = registry.create('ho-a', 'import', { patients: [{ idSystem: 'urn:test', idValue: '1' }] });
        registry.transition(loaded.id, 'succeeded');
        assert.equal(latestVerifiedLoad(registry, 'ho-a').id, loaded.id);
        const reset = registry.create('ho-a', 'reset');
        registry.transition(reset.id, 'succeeded');
        assert.equal(latestVerifiedLoad(registry, 'ho-a'), null);
        const interrupted = registry.create('ho-b', 'import');
        const recovered = new DataOperationRegistry({ directory });
        assert.equal(recovered.get(interrupted.id).phase, 'queued');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('another registry reader cannot recover live work or accept a competing mutation', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-live-operation-'));
    try {
        const owner = new DataOperationRegistry({ directory });
        const operation = owner.create('ho-a', 'import');
        owner.transition(operation.id, 'loading');
        const reader = new DataOperationRegistry({ directory });
        assert.equal(reader.get(operation.id).phase, 'loading');
        assert.throws(() => reader.create('ho-a', 'reset'), /busy/);
        assert.throws(() => reader.transition(operation.id, 'failed'), /owner/);
        const independent = reader.create('ho-b', 'reset');
        reader.transition(independent.id, 'succeeded');
        owner.transition(operation.id, 'failed', { needsReconciliation: true });
        assert.throws(() => reader.create('ho-a', 'import'), /busy/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('two processes share target ownership and explicit recovery fences an old owner', async t => {
    const { fork } = require('node:child_process');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-process-ownership-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const helper = path.join(directory, 'worker.cjs');
    fs.writeFileSync(helper, `
        const { DataOperationRegistry } = require(${JSON.stringify(require.resolve('../src/data-operations'))});
        const registry = new DataOperationRegistry({ directory: process.argv[2] });
        const operation = registry.create('ho-a', 'import');
        registry.transition(operation.id, 'loading', { mutationSubmitted: true });
        process.send(operation);
        process.on('message', () => process.exit(0));
    `);
    const worker = fork(helper, [directory], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    t.after(() => { if (worker.exitCode === null) worker.kill(); });
    const operation = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    const admin = new DataOperationRegistry({ directory });
    assert.equal(admin.get(operation.id).phase, 'loading');
    assert.throws(() => admin.create('ho-a', 'replace'), error => error.statusCode === 409 && error.activeOperationId === operation.id);
    assert.throws(() => admin.recover(operation.id), /stopped workers/);
    const exited = new Promise(resolve => worker.once('exit', resolve));
    worker.send('stop');
    await exited;
    assert.throws(() => admin.create('ho-a', 'reset'), /busy/);
    assert.throws(() => admin.recover(operation.id, { workersStopped: true, reconciled: true }), /read-only reconciliation/);
    assert.equal(latestVerifiedLoad(admin, 'ho-a'), null);
    assert.throws(() => admin.create('ho-a', 'reset'), /busy/);
    const reset = admin.create('ho-b', 'reset');
    admin.transition(reset.id, 'succeeded');
});

test('stopped-submission admission preserves the target lock and fences former owners atomically', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-stopped-admission-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const owner = new DataOperationRegistry({ directory });
    const operation = owner.create('ho-a', 'import', { targetIdentity: 'original-target' });
    owner.transition(operation.id, 'loading', { mutationSubmitted: true });
    const reader = new DataOperationRegistry({ directory });
    const lock = fs.readFileSync(reader.lockFile('ho-a'));
    assert.throws(() => reader.beginReconciliation(operation.id), /does not require reconciliation/);
    assert.throws(() => reader.beginReconciliation(operation.id, { workersStopped: true, targetIdentity: 'wrong-target' }), /target configuration changed/);
    const release = reader.beginReconciliation(operation.id, { workersStopped: true, targetIdentity: 'original-target' });
    assert.deepEqual(fs.readFileSync(reader.lockFile('ho-a')), lock);
    assert.equal(reader.get(operation.id).phase, 'failed');
    assert.equal(reader.get(operation.id).needsReconciliation, true);
    assert.equal(reader.get(operation.id).submittedOutcome, 'unknown');
    assert.throws(() => owner.transition(operation.id, 'succeeded'), /fenced/);
    assert.throws(() => reader.beginReconciliation(operation.id), /EEXIST/);
    assert.throws(() => reader.create('ho-a', 'reset'), /busy/);
    release();
    assert.throws(() => reader.create('ho-a', 'import'), /busy/);
    const independent = reader.create('ho-b', 'import');
    reader.transition(independent.id, 'succeeded');
});

test('stale completion, changed target and changed lock cannot enter stopped reconciliation', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-stale-admission-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    for (const mutation of ['completed', 'target', 'lock']) {
        const targetDirectory = path.join(directory, mutation);
        const owner = new DataOperationRegistry({ directory: targetDirectory });
        const operation = owner.create('ho-a', 'import', { targetIdentity: 'original' });
        owner.transition(operation.id, 'loading', { mutationSubmitted: true });
        const reader = new DataOperationRegistry({ directory: targetDirectory });
        const originalMutation = reader.withTargetMutation.bind(reader);
        reader.withTargetMutation = (serverId, action) => {
            if (mutation === 'completed') owner.transition(operation.id, 'succeeded');
            if (mutation === 'target') owner.write({ ...owner.get(operation.id), targetIdentity: 'changed' });
            if (mutation === 'lock') fs.writeFileSync(owner.lockFile(serverId), JSON.stringify({ operationId: 'another-operation' }));
            return originalMutation(serverId, action);
        };
        assert.throws(() => reader.beginReconciliation(operation.id, { workersStopped: true, targetIdentity: 'original' }), /does not require reconciliation|target configuration changed|another operation/);
        assert.equal(fs.existsSync(reader.reconciliationFile('ho-a')), false);
        assert.notEqual(reader.get(operation.id).needsReconciliation, true);
    }
});
