'use strict';

/** Exercise CLI → child loader → shared ledger with a local HTTP FHIR boundary. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DataOperationRegistry, latestVerifiedLoad } = require('../../src/pcm-core/src/data-operations');
const root = path.resolve(__dirname, '../..');

// Replace only Docker orchestration: its child executes the actual loader.
const dockerStub = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLI_COMMANDS, JSON.stringify(args) + '\\n');
if (args.includes('clinical-loader')) {
    const env = { ...process.env };
    for (let i = 0; i < args.length; i++) if (args[i] === '-e' && args[i + 1].includes('=')) {
        const [key, ...value] = args[++i].split('='); env[key] = value.join('=');
    }
    env.PCM_TRANSACTION_BUNDLE = args[args.indexOf('-v') + 1].split(':/runtime/')[0];
    env.PCM_IMPORT_STATE_DIR = path.join(env.CLI_TEAM_DIR, 'state/import');
    env.STATE_DIR = path.join(env.CLI_TEAM_DIR, 'state');
    env.HO_IMPORT_ENDPOINT = env.CLI_FHIR_URL;
    const script = 'loader.js';
    const result = spawnSync(process.execPath, [path.join(process.cwd(), 'clinical-data', script)], { env, stdio: 'inherit' });
    process.exit(result.status ?? 1);
}
if (args.includes('start') || args.includes('rm')) {
    if (process.env.CLI_FAIL_CLEANUP === 'true') { console.error('scoped container cleanup failed'); process.exit(1); }
    if (!fs.existsSync(path.join(process.env.CLI_TEAM_DIR, 'state/data-operations/lock-ho-a'))) throw new Error('ownership released before cleanup');
}
`;

/** Spawn the real command while the test's local HTTP server handles child requests. */
const execute = promisify(execFile);

test('CLI import and no-op outcomes preserve inventory and release ownership only after cleanup', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clinical cli '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const teamId = 'cleanup-cli';
    const teamDir = path.join(directory, teamId);
    fs.mkdirSync(teamDir);
    const config = structuredClone(require('../example-team-config.json'));
    fs.writeFileSync(path.join(teamDir, 'team-config.json'), JSON.stringify(config));
    const ho = config.healthOrganizations[0];
    fs.writeFileSync(path.join(teamDir, '.env'), `${ho.import.credentialEnv}=${'local-test-import-'.repeat(3)}\n${ho.database.passwordEnv}=local-test-database\n`);
    const bundleRoot = path.join(root, 'clinical-data/ci');
    const bundle = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'ho-a.source.transaction.json')));
    const counts = {};
    for (const entry of bundle.entry) counts[entry.resource.resourceType] = (counts[entry.resource.resourceType] || 0) + 1;
    let state = 'empty';
    let posts = 0;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://local');
        let body;
        if (req.method === 'POST') {
            posts++;
            req.resume();
            if (state === 'disconnect') { req.socket.destroy(); return; }
            state = 'loaded';
            body = { resourceType: 'Bundle', type: 'transaction-response', entry: bundle.entry.map(() => ({ response: { status: '201 Created' } })) };
        } else if (url.pathname.endsWith('/_history')) {
            body = { resourceType: 'Bundle', entry: state === 'history' ? [{}] : [] };
        } else {
            const type = url.pathname.split('/').pop();
            const total = state === 'loaded' ? counts[type] || 0 : state === 'other-type' && type === 'Condition' ? 1 : 0;
            body = { resourceType: 'Bundle', total };
        }
        res.setHeader('Content-Type', 'application/fhir+json');
        res.end(JSON.stringify(body));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'docker'), dockerStub, { mode: 0o755 });
    const commands = path.join(directory, 'commands.jsonl');
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        CLI_COMMANDS: commands, CLI_TEAM_DIR: teamDir, CLI_FHIR_URL: `http://127.0.0.1:${server.address().port}/fhir` };
    const args = ['pcm-connectathon/scripts/run-clinical-import.js', '--team-id', teamId, '--teams-root', directory,
        '--ho', 'ho-a', '--policy', 'if-empty', '--bundle-root', bundleRoot, '--bundle', 'ho-a.source.transaction.json'];
    const registry = new DataOperationRegistry({ directory: path.join(teamDir, 'state/data-operations') });
    await execute(process.execPath, args, { cwd: root, env });
    assert.equal(posts, 1);
    const lifecycle = fs.readFileSync(commands, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const stages = [
        lifecycle.findIndex(args => args.includes('stop')),
        lifecycle.findIndex(args => args.includes('up') && args.includes('clinical-import-hapi')),
        lifecycle.findIndex(args => args.includes('clinical-loader')),
        lifecycle.findIndex(args => args.includes('rm') && args.includes('clinical-import-hapi')),
        lifecycle.findIndex(args => args.includes('start'))
    ];
    assert.ok(stages.every((index, position) => index >= 0 && (!position || index > stages[position - 1])));
    assert.equal(JSON.stringify(lifecycle).includes('local-test-import-'.repeat(3)), false);
    const imported = latestVerifiedLoad(registry, 'ho-a');
    assert.deepEqual(imported.verifiedCounts, counts);
    for (const nextState of ['loaded', 'other-type', 'history']) {
        state = nextState;
        fs.writeFileSync(commands, '');
        await execute(process.execPath, args, { cwd: root, env });
        assert.equal(posts, 1);
        assert.equal(registry.list('ho-a')[0].result, 'skipped');
        assert.equal(registry.list('ho-a')[0].mutationSubmitted, undefined);
        assert.equal(latestVerifiedLoad(registry, 'ho-a').id, imported.id);
        assert.equal(fs.existsSync(registry.lockFile('ho-a')), false);
        assert.doesNotMatch(fs.readFileSync(commands, 'utf8'), /record-verified-import/);
    }
    state = 'disconnect';
    await assert.rejects(execute(process.execPath, args, { cwd: root, env }));
    assert.equal(posts, 2);
    assert.equal(registry.list('ho-a')[0].needsReconciliation, true);
    assert.equal(fs.existsSync(registry.lockFile('ho-a')), true);
    assert.equal(latestVerifiedLoad(registry, 'ho-a'), null);
    assert.throws(() => registry.recover(registry.list('ho-a')[0].id, { workersStopped: true, reconciled: true }), /read-only reconciliation/);
    state = 'empty';
    await assert.rejects(execute(process.execPath, args, { cwd: root, env: { ...env, CLI_FAIL_CLEANUP: 'true' } }));
    assert.equal(posts, 2);
    assert.equal(registry.list('ho-a')[0].needsReconciliation, true);
    assert.equal(fs.existsSync(registry.lockFile('ho-a')), true);
    assert.equal(latestVerifiedLoad(registry, 'ho-a'), null);
});

test('CLI child HAPI wait timeout retains stage and deadline after parent cleanup', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clinical cli timeout '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const teamId = 'timeout-cli';
    const teamDir = path.join(directory, teamId);
    fs.mkdirSync(teamDir);
    const config = structuredClone(require('../example-team-config.json'));
    fs.writeFileSync(path.join(teamDir, 'team-config.json'), JSON.stringify(config));
    const ho = config.healthOrganizations[0];
    fs.writeFileSync(path.join(teamDir, '.env'), `${ho.import.credentialEnv}=${'local-test-import-'.repeat(3)}\n${ho.database.passwordEnv}=local-test-database\n`);

    let posts = 0;
    const server = http.createServer((req, res) => {
        if (req.method === 'POST') {
            posts++;
            req.resume();
            // Leave the submitted response pending beyond the configured HAPI wait.
            return;
        }
        res.setHeader('Content-Type', 'application/fhir+json');
        res.end(JSON.stringify({ resourceType: 'Bundle', total: 0, entry: [] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));

    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'docker'), dockerStub, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        CLI_COMMANDS: path.join(directory, 'commands.jsonl'), CLI_TEAM_DIR: teamDir,
        CLI_FHIR_URL: `http://127.0.0.1:${server.address().port}/fhir`,
        CLINICAL_DATA_TRANSACTION_WAIT_TIMEOUT_MS: '1000' };
    const args = ['pcm-connectathon/scripts/run-clinical-import.js', '--team-id', teamId, '--teams-root', directory,
        '--ho', 'ho-a', '--policy', 'if-empty', '--bundle-root', path.join(root, 'clinical-data/ci'),
        '--bundle', 'ho-a.source.transaction.json'];

    await assert.rejects(execute(process.execPath, args, { cwd: root, env }));
    const registry = new DataOperationRegistry({ directory: path.join(teamDir, 'state/data-operations') });
    const [operation] = registry.list('ho-a');
    assert.equal(posts, 1);
    assert.equal(operation.phase, 'failed');
    assert.equal(operation.failureStage, 'hapi-transaction-wait');
    assert.equal(operation.failureDeadlineMs, 1000);
    assert.equal(operation.submittedOutcome, 'unknown');
    assert.equal(operation.needsReconciliation, true);
    assert.equal(fs.existsSync(registry.lockFile('ho-a')), true);
});

/** Exercise the real CLI's readiness decision without starting containers or submitting data. */
test('private import startup honors durable readiness and rejects invalid budgets before mutation', async t => {
    for (const fixture of [
        { stored: undefined, expected: '600' },
        { stored: '600s', expected: '600' },
        { stored: 'bad', invalid: true },
        { stored: '0s', invalid: true },
        { stored: '3601s', invalid: true }
    ]) {
        await t.test(fixture.stored || 'default readiness', async t => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clinical-readiness-'));
            t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
            const teamId = 'readiness-cli';
            const teamDir = path.join(directory, teamId);
            fs.mkdirSync(teamDir);
            const config = structuredClone(require('../example-team-config.json'));
            const ho = config.healthOrganizations[0];
            fs.writeFileSync(path.join(teamDir, 'team-config.json'), JSON.stringify(config));
            const saved = `${ho.import.credentialEnv}=${'local-test-import-'.repeat(3)}\n`
                + `${ho.database.passwordEnv}=local-test-database\n`
                + (fixture.stored === undefined ? '' : `PCM_HAPI_HEALTH_START_PERIOD=${fixture.stored}\n`);
            fs.writeFileSync(path.join(teamDir, '.env'), saved);
            const bin = path.join(directory, 'bin');
            fs.mkdirSync(bin);
            const commands = path.join(directory, 'commands.jsonl');
            fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CLI_COMMANDS, JSON.stringify(args) + '\\n');
if (args.includes('up')) { console.error('fixture stopped private startup'); process.exit(42); }
`, { mode: 0o755 });
            const args = ['pcm-connectathon/scripts/run-clinical-import.js', '--team-id', teamId,
                '--teams-root', directory, '--ho', ho.id, '--policy', 'if-empty',
                '--bundle-root', path.join(root, 'clinical-data/ci'), '--bundle', 'ho-a.source.transaction.json'];
            await assert.rejects(execute(process.execPath, args, { cwd: root,
                env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLI_COMMANDS: commands }
            }), error => {
                assert.match(error.stderr, fixture.invalid ? /PCM_HAPI_HEALTH_START_PERIOD|--wait-timeout/ : /fixture stopped private startup/);
                return true;
            });
            assert.equal(fs.readFileSync(path.join(teamDir, '.env'), 'utf8'), saved);
            if (fixture.invalid) {
                assert.equal(fs.existsSync(commands), false, 'invalid readiness must not invoke Docker');
                assert.equal(fs.existsSync(path.join(teamDir, 'state')), false, 'invalid readiness must not reserve an operation');
            } else {
                const calls = fs.readFileSync(commands, 'utf8').trim().split('\n').map(line => JSON.parse(line));
                const startup = calls.find(args => args.includes('up') && args.includes('clinical-import-hapi'));
                assert.ok(startup);
                assert.equal(startup[startup.indexOf('--wait-timeout') + 1], fixture.expected);
                assert.equal(calls.some(args => args.includes('clinical-loader')), false);
            }
        });
    }
});
