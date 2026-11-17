'use strict';

/** Actual disposable HTTP upgrade/restart/rollback using distinct immutable source artifacts. */
const fs = require('fs'), path = require('path'), assert = require('assert/strict'), https = require('https'), http = require('http'), crypto = require('crypto');
const { fork, execFileSync } = require('child_process');
const checkpoint = require('../../src/pcm-core/src/migration-checkpoint');

/** Child process starts the actual selected runtime, with the bridge only on the historical side. */
async function child() {
    const root = process.env.PCM04108_RUNTIME_ROOT;
    if (process.env.PCM04108_LEGACY === 'true') require('../../src/pcm-core/src/migration-legacy-bridge').install(root);
    const bootstrap = require(path.join(root, 'src/pcm-core/src/bootstrap'));
    await bootstrap();
    const { createApiApp, createUiApp } = require(path.join(root, 'src/pcm-core/src/index'));
    const api = https.createServer({ cert: fs.readFileSync(path.join(process.env.CERTS_DIR, 'pcm-core.crt')), key: fs.readFileSync(path.join(process.env.CERTS_DIR, 'pcm-core.key')) }, createApiApp());
    const ui = http.createServer(createUiApp());
    await Promise.all([new Promise(resolve => api.listen(0, '127.0.0.1', resolve)), new Promise(resolve => ui.listen(0, '127.0.0.1', resolve))]);
    process.send({ api: api.address().port, ui: ui.address().port });
    process.on('message', async message => {
        if (message.kind === 'stop') { await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => ui.close(resolve))]); process.exit(0); }
        if (message.kind === 'restriction') {
            const store = require(path.join(root, 'src/pcm-core/src/fhir/store'));
            const value = store.get('Contract', 'policy-presence');
            if (message.restriction === 'revoke') value.status = 'revoked';
            if (message.restriction === 'remove-source') value.term[0].asset = [];
            if (message.restriction === 'shorten-validity') value.applies.end = '2025-12-31T23:59:59Z';
            store.update(value); process.send({ restricted: message.restriction });
        }
    });
}

/** Request with real HTTP/TLS, discarding credentials from returned evidence. */
function request(port, pathname, { body, token, admin = false, plain = false, cookie, accept } = {}) {
    return new Promise((resolve, reject) => {
        const bytes = body === undefined ? null : Buffer.from(new URLSearchParams(body).toString());
        const req = (plain ? http : https).request({ hostname: '127.0.0.1', port, path: pathname, method: bytes ? 'POST' : 'GET', rejectUnauthorized: false,
            headers: { ...(accept ? { accept } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(admin ? { 'x-admin-password': 'pcm04108-disposable-password' } : {}), ...(cookie ? { cookie } : {}), ...(bytes ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': bytes.length } : {}) } }, res => {
            const chunks = []; res.on('data', data => chunks.push(data)); res.on('end', () => {
                const text = Buffer.concat(chunks).toString(); let json; try { json = JSON.parse(text); } catch (_) { /* HTML proof is separate. */ }
                resolve({ status: res.statusCode, json, text });
            });
        }); req.on('error', reject); if (bytes) req.write(bytes); req.end();
    });
}

/** Run the selected artifact in a fresh process, with no retained-team paths or fixed ports. */
async function start(f, runtimeRoot, runtimeId, legacy) {
    const processChild = fork(__filename, ['--child'], { env: { ...process.env, PCM04108_RUNTIME_ROOT: runtimeRoot, PCM04108_LEGACY: String(legacy), PCM_MIGRATION_RUNTIME_ID: runtimeId,
        TEAM_CONFIG_PATH: f.options.configPath, STATE_DIR: f.options.stateDirectory, CERTS_DIR: f.options.certsDirectory,
        LOG_DIR: path.join(f.directory, 'logs'), SHARED_LOGS_DIR: path.join(f.directory, 'logs'), TEAM_ADMIN_PASSWORD: 'pcm04108-disposable-password' }, silent: true });
    let output = ''; processChild.stdout.on('data', value => { output += value; }); processChild.stderr.on('data', value => { output += value; });
    const address = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Runtime startup timed out: ${output.slice(-1500)}`)), 15000);
        processChild.once('message', value => { clearTimeout(timer); resolve(value); }); processChild.once('exit', code => { clearTimeout(timer); reject(new Error(`Runtime exited ${code}: ${output.slice(-1500)}`)); });
    });
    return { processChild, ...address, stop: () => new Promise(resolve => { processChild.once('exit', resolve); processChild.send({ kind: 'stop' }); }) };
}

/** Issue real registered ES256 assertions, using only cached synthetic fixture key material. */
async function token(runtime, config, client, keyFile, { scope, resource, details, legacy = false } = {}) {
    const now = Math.floor(Date.now() / 1000), issuer = config.contract.operational.oauthBase;
    const material = fs.readFileSync(keyFile), header = { alg: 'ES256', typ: 'JWT', kid: require('../../src/shared/assertion-keys').jwkThumbprint(material) };
    // 0.4.0 has no normative key-selection header; the migration candidate
    // selects the registered public key by its RFC 7638 identity.
    if (legacy) delete header.kid;
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode(header)}.${encode({ iss: client, sub: client, aud: `${issuer}/token`, iat: now, exp: now + 60, jti: crypto.randomUUID() })}`;
    const assertion = `${input}.${crypto.sign('sha256', Buffer.from(input), { key: material, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    return request(runtime.api, '/api/fhir-service/r4/token', { body: { grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion,
        scope: scope || require('../../src/shared/pcm-contract').SCOPES.management, resource: resource || issuer, ...(details ? { authorization_details: JSON.stringify(details) } : {}) } });
}

/** Register available cached synthetic certificates explicitly for the isolated runtime artifacts. */
function prepareFixture(f, artifact) {
        const migration = require('../scripts/pcm-ig-041-migration');
        const config = f.config; delete config.presence.sources; // This historical 0.4.0 schema predates per-source envelopes.
        config.systemAuthorization.presenceEligiblePatients = [{ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' }];
        const certRoot = path.resolve(__dirname, '../../certs');
        for (const name of fs.readdirSync(certRoot).filter(name => name.endsWith('.crt') || name === 'pcm-core.key')) fs.copyFileSync(path.join(certRoot, name), path.join(f.options.certsDirectory, name));
        for (const [client, registration] of migration.registrations(config)) for (const name of registration.files) if (!fs.existsSync(path.join(certRoot, name))) fs.copyFileSync(path.join(certRoot, 'presence-orchestrator-assertion.crt'), path.join(f.options.certsDirectory, name));
        const review = f.review; review.runtime = { before: artifact.before.id, after: artifact.after.id };
        review.approvedKeys = [...migration.registrations(config)].flatMap(([clientId, registration]) => [...registration.files].map(file => {
            const bytes = fs.readFileSync(path.join(f.options.certsDirectory, file)); return { clientId, file, sha256: checkpoint.sha256(bytes), algorithm: require('../../src/shared/assertion-keys').signingAlgorithm(bytes), kid: require('../../src/shared/assertion-keys').jwkThumbprint(bytes) };
        }));
        fs.writeFileSync(f.options.configPath, checkpoint.encode(config)); fs.writeFileSync(f.options.reviewPath, checkpoint.encode(review));
        const manifestPath = path.join(f.root, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath)); manifest.runtimeId = artifact.before.id; manifest.configHash = checkpoint.sha256(fs.readFileSync(f.options.configPath)); fs.writeFileSync(manifestPath, checkpoint.encode(manifest));
        migration.resumeCurrent(f.options);
        return { config, certRoot };
}

/** Bind the immutable artifact manifests, then exercise the operator sequence on synthetic data only. */
async function main() {
    const artifact = JSON.parse(fs.readFileSync(process.env.PCM04108_ARTIFACTS));
    const { fixture, treeHashes } = require('./pcm-ig-041-migration-fixture'), migration = require('../scripts/pcm-ig-041-migration');
    const f = fixture(null, { preset: 'connectathon-balanced' });
    const live = new Set(), rows = [], record = (name, details = {}) => { rows.push({ name, ...details }); console.log(JSON.stringify(rows.at(-1))); };
    try {
        const { config, certRoot } = prepareFixture(f, artifact);
        let runtime = await start(f, artifact.before.root, artifact.before.id, true); live.add(runtime);
        let issued = await token(runtime, config, config.organizations.serviceProvider.clientId, path.join(certRoot, 'sp-client-assertion.key'), { legacy: true });
        assert.equal(issued.status, 200, issued.text); const oldToken = issued.json.access_token;
        assert.equal((await request(runtime.api, `/api/fhir-service/r4/Organization/${config.organizations.serviceProvider.id}`, { token: oldToken })).status, 200);
        record('historical-runtime-fresh-token-and-management-read', { status: 200, runtimeId: artifact.before.id });
        const checkpointResponse = await request(runtime.ui, '/admin/migration/checkpoint', { plain: true, admin: true, body: {} }); assert.equal(checkpointResponse.status, 200, checkpointResponse.text);
        assert.equal((await request(runtime.api, '/api/fhir-service/r4/Organization', { token: oldToken })).status, 503);
        await runtime.stop(); live.delete(runtime); const stoppedAt = new Date().toISOString();
        const before = treeHashes(f.directory), preview = migration.plan(f.options); assert.deepEqual(preview.errors, []); assert.deepEqual(treeHashes(f.directory), before);
        record('online-checkpoint-stop-read-only-preview', { digest: preview.digest, errors: preview.errors, retired: preview.retired, checkpointHash: checkpointResponse.json.checkpointHash });
        await new Promise(resolve => setTimeout(resolve, 31050));
        const applied = migration.apply({ ...f.options, stoppedAt, expectedDigest: preview.digest }); assert.equal(applied.status, 'applied');
        runtime = await start(f, artifact.after.root, artifact.after.id, false); live.add(runtime);
        assert.equal((await request(runtime.api, `/api/fhir-service/r4/Organization/${config.organizations.serviceProvider.id}`, { token: oldToken })).status, 401);
        issued = await token(runtime, config, config.organizations.serviceProvider.clientId, path.join(certRoot, 'sp-client-assertion.key')); assert.equal(issued.status, 200, issued.text); const afterToken = issued.json.access_token;
        assert.equal((await request(runtime.api, `/api/fhir-service/r4/Organization/${config.organizations.serviceProvider.id}`, { token: afterToken })).status, 200);
        const patient = config.systemAuthorization.presenceEligiblePatients[0], details = [{ type: 'https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access', fhirContext: [
            { type: 'Contract', role: 'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-basis', identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id', value: 'PCM-POLICY-PRESENCE-001' } },
            { type: 'Patient', role: 'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-patient', identifier: patient }
        ] }];
        const presence = () => token(runtime, config, config.oauthClients.presenceOrchestrator.clientId, path.join(certRoot, 'presence-orchestrator-assertion.key'), { scope: 'system/Patient.s', resource: config.healthOrganizations[0].endpoint, details });
        const normative = await presence(); assert.equal(normative.status, 200, normative.text);
        record('candidate-restart-old-token-rejected-fresh-management-and-normative-presence-issued', { oldTokenStatus: 401, freshStatus: 200, normativeStatus: normative.status, noHealthcareService: !JSON.stringify(normative.json.authorization_details).includes('HealthcareService') });
        const admin = await request(runtime.ui, '/admin', { plain: true, admin: true, accept: 'text/html' }); assert.equal(admin.status, 200);
        if (process.env.PCM04108_UI_ARTIFACT) fs.writeFileSync(process.env.PCM04108_UI_ARTIFACT, admin.text);
        const beforeRollback = treeHashes(f.directory);
        assert.equal((await request(runtime.ui, '/admin/migration/checkpoint', { plain: true, admin: true, body: {} })).status, 200);
        await runtime.stop(); live.delete(runtime); const rollbackStoppedAt = new Date().toISOString();
        await new Promise(resolve => setTimeout(resolve, 31050));
        const rolled = migration.rollback({ ...f.options, stoppedAt: rollbackStoppedAt }); assert.equal(rolled.status, 'rolled-back');
        runtime = await start(f, artifact.before.root, artifact.before.id, true); live.add(runtime);
        assert.equal((await request(runtime.api, `/api/fhir-service/r4/Organization/${config.organizations.serviceProvider.id}`, { token: afterToken })).status, 401);
        issued = await token(runtime, config, config.organizations.serviceProvider.clientId, path.join(certRoot, 'sp-client-assertion.key'), { legacy: true }); assert.equal(issued.status, 200, issued.text);
        record('historical-rollback-restart-old-candidate-token-rejected-fresh-legacy-token-issued', { priorTokenStatus: 401, freshStatus: 200 });
        assert.equal(treeHashes(f.directory)['clinical/Patient.json'], beforeRollback['clinical/Patient.json']); assert.equal(treeHashes(f.directory)['state/data-operations/completed-import.json'], beforeRollback['state/data-operations/completed-import.json']);
        const backup = JSON.parse(fs.readFileSync(path.join(applied.backupDirectory, 'index.json')));
        record('preserved-clinical-and-import-state-and-byte-exact-backups', { clinicalHash: treeHashes(f.directory)['clinical/Patient.json'], ledgerHash: treeHashes(f.directory)['state/data-operations/completed-import.json'], backups: backup.files.map(value => ({ path: path.basename(value.file), beforeHash: value.beforeHash, afterHash: value.afterHash, verified: checkpoint.sha256(fs.readFileSync(value.backup)) === value.beforeHash })) });
        await runtime.stop(); live.delete(runtime);
        fs.writeFileSync(process.env.PCM04108_RESULT, checkpoint.encode({ status: 'passed', artifacts: artifact, rows }));
    } finally { for (const runtime of live) { runtime.processChild.kill('SIGKILL'); } fs.rmSync(f.directory, { recursive: true, force: true }); }
}

if (require.main === module) (process.argv.includes('--child') ? child() : main()).catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { start, request, token, prepareFixture };
