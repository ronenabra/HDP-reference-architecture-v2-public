'use strict';

/** Fresh, private TLS fixtures; source tests never depend on retained deployments. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
let cached;

/** Generate one owned certificate set for a suite and return its cleanup owner. */
function generateCertificates() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-source-test-certs-'));
    fs.chmodSync(directory, 0o700);
    const root = path.resolve(__dirname, '..');
    const result = spawnSync(process.execPath, ['pcm-connectathon/scripts/generate-team-certs.js',
        '--team-id', 'source-tests', '--out', directory, '--pcm-api-host', 'localhost', '--sp-host', 'localhost', '--ds-host', 'localhost'],
    { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw new Error(`fresh TLS fixture generation failed: ${result.error?.message || result.stderr}`);
    }
    fs.writeFileSync(path.join(directory, '.pcm-owned-test-fixture.json'), JSON.stringify({ schemaVersion: 'pcm-source-test-certificates/1' }), { mode: 0o600 });
    return { directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

/** Resolve the explicit suite fixture or create a private standalone-test fixture. */
function certificates() {
    if (cached) return cached;
    if (process.env.PCM_TEST_CERTIFICATES) {
        const directory = path.resolve(process.env.PCM_TEST_CERTIFICATES);
        const marker = JSON.parse(fs.readFileSync(path.join(directory, '.pcm-owned-test-fixture.json')));
        if (marker.schemaVersion !== 'pcm-source-test-certificates/1') throw new Error('invalid explicit source-test certificate fixture');
        for (const file of ['rootCA.crt', 'rootCA.key', 'pcm-core.key', 'sp-client-assertion.key']) {
            if (!fs.statSync(path.join(directory, file)).isFile()) throw new Error(`missing required TLS fixture: ${file}`);
        }
        cached = directory;
    } else {
        const owned = generateCertificates();
        cached = owned.directory;
        process.once('exit', owned.cleanup);
    }
    return cached;
}

module.exports = { certificates, generateCertificates };
