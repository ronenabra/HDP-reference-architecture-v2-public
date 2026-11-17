'use strict';

/** Exercise the gateway watcher with real JSON parsing and template rendering, without listeners. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const script = process.env.GATEWAY_RUNTIME_RELOAD_TEST_SCRIPT
    || path.resolve(__dirname, '../../src/ds-gateway/runtime-reload.sh');
const deadlineMilliseconds = 5000;
const initialPolicy = 'mode=connectathon;client=off;verify=off;upstream=http://legacy-fhir:8080/fhir;limit=1234\n';
const replacementPolicy = 'mode=;client=optional;verify=on;upstream=https://changed.invalid/fhir;limit=5678\n';

/** Return a complete configuration whose transport and body-limit fields change together. */
function configuration(revision) {
    const strict = revision === 2;
    return {
        runtime: { revision, certificateRevision: 1 },
        conformance: { mode: strict ? 'strict' : 'connectathon' },
        security: {
            dataSourceGateway: { clientAuth: strict ? 'mtls' : 'tls' },
            dsGatewayToFhirServer: {
                protocol: strict ? 'https' : 'http', verifyServerCertificate: strict,
                customUrl: strict ? 'https://changed.invalid/fhir/' : '', customUrlScope: 'legacy-ds'
            }
        },
        securitySimulation: { global: { publicClientMtls: strict, serverCertificateVerification: strict } },
        presence: { batch: { maxPayloadBytes: strict ? 5678 : 1234 } }
    };
}

/** Read a witness file before it exists, without obscuring other filesystem errors. */
function readWitness(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (error) {
        if (error.code === 'ENOENT') return '';
        throw error;
    }
}

/** Resolve on a filesystem event proving the requested state, or reject on exit/deadline. */
function observe(harness, predicate, description) {
    return new Promise((resolve, reject) => {
        const watcher = fs.watch(harness.directory, check);
        const timer = setTimeout(() => finish(new Error(`Timed out observing ${description}: ${harness.stderr}`)), deadlineMilliseconds);
        harness.child.on('exit', exited);
        function finish(error) {
            clearTimeout(timer);
            watcher.close();
            harness.child.off('exit', exited);
            if (error) reject(error); else resolve();
        }
        function exited(code, signal) {
            finish(new Error(`Gateway exited (${code ?? signal}) while observing ${description}: ${harness.stderr}`));
        }
        function check() {
            try {
                if (predicate()) finish();
                else if (harness.child.exitCode !== null || harness.child.signalCode !== null) {
                    exited(harness.child.exitCode, harness.child.signalCode);
                }
            } catch (error) { finish(error); }
        }
        check();
    });
}

/** Wait for process closure with a bounded deadline, including complete captured diagnostics. */
function closed(harness) {
    if (harness.child.exitCode !== null || harness.child.signalCode !== null) {
        return Promise.resolve({ code: harness.child.exitCode, signal: harness.child.signalCode });
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Gateway did not exit: ${harness.stderr}`)), deadlineMilliseconds);
        harness.child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
}

/** Start an isolated shell process group and register cleanup for every child and temporary file. */
function createHarness(t, contents) {
    for (const dependency of ['jq', 'envsubst']) {
        const result = spawnSync(dependency, ['--version'], { encoding: 'utf8' });
        assert.equal(result.status, 0, `${dependency} is required for the real shell regression: ${result.error || result.stderr}`);
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-reload-'));
    const configPath = path.join(directory, 'team.json');
    const outputPath = path.join(directory, 'nginx.conf');
    const eventsPath = path.join(directory, 'nginx-events');
    const pollsPath = path.join(directory, 'poll-events');
    const templatePath = path.join(directory, 'template');
    fs.writeFileSync(configPath, contents);
    fs.writeFileSync(templatePath, 'mode=${PCM_MODE_HEADER};client=${DS_GATEWAY_SSL_VERIFY_CLIENT};verify=${DS_FHIR_PROXY_SSL_VERIFY};upstream=${DS_FHIR_PROXY_PASS};limit=${DS_BODY_LIMIT_BYTES}\n');
    // These executable witnesses replace only NGINX and the polling interval. JSON
    // parsing and environment substitution run through the installed real tools.
    fs.writeFileSync(path.join(directory, 'nginx'), `#!${process.execPath}\n` +
        "const fs = require('node:fs');\n" +
        "fs.appendFileSync(process.env.TEST_NGINX_EVENTS, process.argv.includes('reload') ? 'reload\\n' : 'started\\n');\n" +
        "if (!process.argv.includes('reload')) setInterval(() => {}, 1000);\n", { mode: 0o755 });
    fs.writeFileSync(path.join(directory, 'sleep'), `#!${process.execPath}\n` +
        "require('node:fs').appendFileSync(process.env.TEST_POLL_EVENTS, 'poll\\n');\n" +
        'setTimeout(() => {}, 25);\n', { mode: 0o755 });
    const child = spawn('sh', [script], { detached: true, env: {
        ...process.env, PATH: `${directory}:${process.env.PATH}`, TEAM_CONFIG_PATH: configPath,
        NGINX_TEMPLATE_PATH: templatePath, NGINX_OUTPUT_PATH: outputPath,
        DS_GATEWAY_LOG_DIR: path.join(directory, 'logs'), DS_GATEWAY_LOG_OWNER: '', TMPDIR: directory,
        TEST_NGINX_EVENTS: eventsPath, TEST_POLL_EVENTS: pollsPath,
        HO_ID: 'legacy-ds', DS_FHIR_SERVER_HOST: 'legacy-fhir', DS_FHIR_SERVER_PORT: '8080'
    } });
    const harness = { directory, configPath, outputPath, eventsPath, pollsPath, child, stderr: '' };
    child.stdout.resume();
    child.stderr.on('data', data => { harness.stderr += data.toString(); });
    t.after(async () => {
        // The watcher can exit while its background fake NGINX still runs; always
        // terminate the entire dedicated process group, not just the shell PID.
        try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        try { await closed(harness); } finally {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    return harness;
}

for (const [label, incomplete] of [['truncated', '{"runtime":{"revision":2},"security":{"dsGatewayToFhirServer":{"customUrl":"https://'], ['empty', '']]) {
    test(`gateway retains the last coherent policy during an in-place ${label} write and reloads its completed replacement`, async t => {
        const harness = createHarness(t, JSON.stringify(configuration(1)));
        await observe(harness, () => readWitness(harness.eventsPath).includes('started\n'), 'initial NGINX startup');
        assert.equal(readWitness(harness.outputPath), initialPolicy);
        const beforePolls = readWitness(harness.pollsPath).split('\n').filter(Boolean).length;
        const originalInode = fs.statSync(harness.configPath).ino;
        fs.writeFileSync(harness.configPath, incomplete);
        assert.equal(fs.statSync(harness.configPath).ino, originalInode, 'exercise the existing bind-mounted file rather than an atomic replacement');
        // Three poll-start witnesses mean at least two complete watcher attempts
        // observed the invalid source. No arbitrary delay can make this pass.
        await observe(harness, () => readWitness(harness.pollsPath).split('\n').filter(Boolean).length >= beforePolls + 3,
            `${label} JSON surviving two watcher attempts`);
        assert.equal(harness.child.exitCode, null);
        assert.equal(readWitness(harness.outputPath), initialPolicy);
        assert.equal(readWitness(harness.eventsPath), 'started\n', 'invalid reads must not reload or rewrite policy');
        fs.writeFileSync(harness.configPath, JSON.stringify(configuration(2)));
        await observe(harness, () => readWitness(harness.eventsPath).includes('reload\n'), 'completed replacement reload');
        assert.equal(readWitness(harness.outputPath), replacementPolicy, 'all revised policy fields must come from the same valid revision');
        assert.equal(readWitness(harness.eventsPath), 'started\nreload\n');
    });
}

for (const [label, contents] of [['truncated', '{"runtime":'], ['empty', '']]) {
    test(`gateway rejects ${label} JSON at startup before starting NGINX`, async t => {
        const harness = createHarness(t, contents);
        const result = await closed(harness);
        assert.notEqual(result.code, 0, harness.stderr);
        assert.equal(readWitness(harness.eventsPath), '');
        assert.equal(readWitness(harness.outputPath), '');
    });
}
