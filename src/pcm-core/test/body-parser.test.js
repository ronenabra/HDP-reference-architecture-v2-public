'use strict';
/** Exercise the production entry point's parser before FHIR bearer authorization. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { buildTeamConfig } = require('../../../test-support/team-config');
const root = path.resolve(__dirname, '../../..');

/** Allocate independent ephemeral listener ports for one disposable PCM process. */
async function ports() {
    const reservations = await Promise.all([0, 1, 2].map(() => new Promise(resolve => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => resolve(server));
    })));
    const values = reservations.map(server => server.address().port);
    await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
    return values;
}

/** Send bytes through HTTPS and return the actual status and FHIR error body. */
function request(port, type, body) {
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname: '127.0.0.1', port, path: '/api/fhir-service/r4/Organization', method: 'POST',
            rejectUnauthorized: false, headers: { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) } }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: JSON.parse(text) }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

test('PCM JSON and FHIR JSON share the intended 10 MB limit and error boundary', { timeout: 30_000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-parser-'));
    const [api, ui, metadata] = await ports();
    const configPath = path.join(directory, 'team-config.json');
    fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig()));
    const log = fs.openSync(path.join(directory, 'server.log'), 'w');
    const child = spawn(process.execPath, ['src/pcm-core/src/index.js'], { cwd: root,
        env: { ...process.env, TEAM_CONFIG_PATH: configPath, STATE_DIR: path.join(directory, 'state'),
            LOG_DIR: path.join(directory, 'logs'), SHARED_LOGS_DIR: path.join(directory, 'shared-logs'),
            CERTS_DIR: require('../../../test-support/certificates').certificates(), PORT: String(api), UI_PORT: String(ui), METADATA_PORT: String(metadata) },
        stdio: ['ignore', log, log] });
    t.after(async () => {
        if (child.exitCode === null) {
            const stopped = new Promise(resolve => child.once('exit', resolve));
            child.kill('SIGTERM');
            const deadline = setTimeout(() => child.kill('SIGKILL'), 3000);
            await stopped;
            clearTimeout(deadline);
        }
        fs.closeSync(log);
        fs.rmSync(directory, { recursive: true, force: true });
    });
    for (let attempt = 0; ; attempt++) {
        try { await request(api, 'application/json', '{}'); break; }
        catch (error) {
            if (child.exitCode !== null || attempt === 99) throw new Error(`${error.message}\n${fs.readFileSync(path.join(directory, 'server.log'), 'utf8')}`);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
    const limit = 10 * 1024 * 1024;
    for (const type of ['application/json', 'application/fhir+json']) {
        for (const length of [1024, 200 * 1024, limit - 128]) {
            const response = await request(api, type, JSON.stringify({ resourceType: 'Organization', name: 'x'.repeat(length) }));
            // Reaching bearer authorization proves that the real parser accepted the body.
            assert.equal(response.status, 401, `${type}, ${length} bytes must reach authorization`);
            assert.equal(response.body.resourceType, 'OperationOutcome');
        }
        const oversized = await request(api, type, JSON.stringify({ name: 'x'.repeat(limit) }));
        assert.equal(oversized.status, 413);
        assert.match(oversized.type, /application\/fhir\+json/);
        assert.equal(oversized.body.issue[0].code, 'exception');
        const malformed = await request(api, type, '{"resourceType":');
        assert.equal(malformed.status, 400);
        assert.equal(malformed.body.issue[0].code, 'invalid');
        assert.equal(malformed.body.issue[0].diagnostics, 'Invalid FHIR request body');
    }
});
