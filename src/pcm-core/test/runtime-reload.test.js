/**
 * Tests for runtime reload plumbing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Set worker-owned paths before importing application modules with runtime state.
const testRuntime = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || require('node:os').tmpdir(), 'pcm-runtime-'));
const previousRuntimeEnv = { LOG_DIR: process.env.LOG_DIR, STATE_DIR: process.env.STATE_DIR };
process.env.LOG_DIR = path.join(testRuntime, 'logs');
process.env.STATE_DIR = path.join(testRuntime, 'state');
test.after(() => {
    for (const [key, value] of Object.entries(previousRuntimeEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(testRuntime, { recursive: true, force: true });
});

const { readHttpsOptions, readMetadataHttpsOptions } = require('../src/api-server-manager');
const { readRevision } = require('../src/runtime-watch');
const { markRuntimeChange, markCertificateChange } = require('../src/team-config');

const tmpRoot = process.env.TEST_TMPDIR || '/tmp';

test('PCM API TLS requests certificates and delegates route-specific enforcement to the app', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-certs-'));
    fs.writeFileSync(path.join(tmp, 'pcm-core.key'), 'key');
    fs.writeFileSync(path.join(tmp, 'pcm-core.crt'), 'cert');
    fs.writeFileSync(path.join(tmp, 'rootCA.crt'), 'ca');

    assert.equal(readHttpsOptions(tmp, 'mtls').rejectUnauthorized, false);
    assert.equal(readHttpsOptions(tmp, 'tls').rejectUnauthorized, false);
    assert.equal(readHttpsOptions(tmp, 'mtls').requestCert, true);

    fs.rmSync(tmp, { recursive: true, force: true });
});

test('PCM metadata HTTPS options share strict mTLS and bounded connectathon TLS settings', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-metadata-certs-'));
    fs.writeFileSync(path.join(tmp, 'pcm-core.key'), 'key');
    fs.writeFileSync(path.join(tmp, 'pcm-core.crt'), 'cert');
    fs.writeFileSync(path.join(tmp, 'rootCA.crt'), 'ca');

    const strictOptions = readMetadataHttpsOptions(tmp, 'mtls');
    const connectathonOptions = readMetadataHttpsOptions(tmp, 'tls');

    assert.equal(strictOptions.requestCert, true);
    assert.equal(strictOptions.rejectUnauthorized, true);
    assert.ok(strictOptions.ca);
    assert.equal(connectathonOptions.requestCert, true);
    assert.equal(connectathonOptions.rejectUnauthorized, false);

    fs.rmSync(tmp, { recursive: true, force: true });
});

test('runtime and certificate changes advance watched revision', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-runtime-'));
    const configPath = path.join(tmp, 'team-config.json');

    let config = { security: { pcmApi: { clientAuth: 'tls' } }, runtime: { revision: 1, certificateRevision: 1 } };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const initial = readRevision(configPath);

    config = markRuntimeChange(config, 'security');
    fs.writeFileSync(configPath, JSON.stringify(config));
    const afterRuntimeChange = readRevision(configPath);

    config = markCertificateChange(config);
    fs.writeFileSync(configPath, JSON.stringify(config));
    const afterCertificateChange = readRevision(configPath);

    assert.notEqual(afterRuntimeChange, initial);
    assert.notEqual(afterCertificateChange, afterRuntimeChange);

    fs.rmSync(tmp, { recursive: true, force: true });
});

test('non-TLS config reload preserves the listener while mode and certificate changes replace it', async () => {
    const { execFileSync } = require('node:child_process');
    const { createApiServerManager } = require('../src/api-server-manager');
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-listener-'));
    /** Generate disposable local TLS material; no external service is involved. */
    const generate = () => {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=localhost', '-keyout', path.join(tmp, 'pcm-core.key'),
            '-out', path.join(tmp, 'pcm-core.crt')], { stdio: 'ignore' });
        fs.copyFileSync(path.join(tmp, 'pcm-core.crt'), path.join(tmp, 'rootCA.crt'));
    };
    generate();
    let mode = 'tls';
    const manager = createApiServerManager({ app: (_req, res) => res.end('ok'), port: 0,
        certsDir: tmp, getClientAuthMode: () => mode, logger: { info() {}, error() {} } });
    try {
        await manager.start();
        const original = manager.getServer();
        await manager.reload('bootstrap settings changed');
        assert.equal(manager.getServer(), original);
        assert.equal(original.listening, true);
        mode = 'mtls';
        await manager.reload('client authentication changed');
        const strict = manager.getServer();
        assert.notEqual(strict, original);
        assert.equal(manager.getCurrentOptions().rejectUnauthorized, false);
        generate();
        await manager.reload('certificate rotation');
        assert.notEqual(manager.getServer(), strict);
    } finally {
        await manager.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('runtime watcher applies only fully validated revisions and retries a corrected revision', t => {
    const configPath = path.join(testRuntime, 'watched-config.json');
    const previous = process.env.TEAM_CONFIG_PATH;
    const originalInterval = global.setInterval;
    const originalClear = global.clearInterval;
    let tick;
    global.setInterval = callback => { tick = callback; return 1; };
    global.clearInterval = () => {};
    process.env.TEAM_CONFIG_PATH = configPath;
    const config = structuredClone(require('../../../pcm-connectathon/example-team-config.json'));
    config.runtime.revision = 1;
    fs.writeFileSync(configPath, JSON.stringify(config));
    const reader = require('../src/team-config');
    const before = reader.loadTeamConfig();
    const applied = [];
    const stop = require('../src/runtime-watch').watchRuntimeConfig(configPath, () => applied.push(reader.loadTeamConfig()));
    try {
        config.runtime.revision = 2;
        config.conformance.preset = 'broken';
        fs.writeFileSync(configPath, JSON.stringify(config));
        tick();
        assert.deepEqual(applied, []);
        assert.deepEqual(reader.loadTeamConfig(), before);
        config.conformance.preset = before.conformance.preset;
        fs.writeFileSync(configPath, JSON.stringify(config));
        tick();
        assert.equal(applied.length, 1);
        assert.equal(applied[0].runtime.revision, 2);
        tick();
        assert.equal(applied.length, 1);
    } finally {
        stop();
        global.setInterval = originalInterval;
        global.clearInterval = originalClear;
        if (previous === undefined) delete process.env.TEAM_CONFIG_PATH; else process.env.TEAM_CONFIG_PATH = previous;
    }
});
