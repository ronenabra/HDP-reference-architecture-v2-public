'use strict';

/** Real TLS/process/JWT checks against owned temporary team files only. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const jwt = require('jsonwebtoken');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { certificates } = require('../../../test-support/certificates');
const { buildEffectivePolicy, simulationPolicyStamp } = require('../../shared/conformance-policy');
const { createRuntimeListener } = require('../src/runtime-listener');

/** Wait for an observed condition, retaining the last error for useful failure output. */
async function until(check, label) {
    let last;
    for (let attempt = 0; attempt < 100; attempt++) {
        try { if (await check()) return; } catch (error) { last = error; }
        await delay(100);
    }
    throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}

/** Read one actual TLS response without pooling sockets across a listener replacement. */
function request(port, route = '/healthz', token) {
    return new Promise((resolve, reject) => {
        const req = https.get({ hostname: '127.0.0.1', port, path: route, rejectUnauthorized: false,
            agent: false, headers: token ? { Authorization: `Bearer ${token}` } : {} }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.setTimeout(2000, () => req.destroy(new Error('owned request timeout')));
    });
}

/** Provision an isolated selected file, fresh certificate copy and service process. */
async function startTeam(t, preset = 'connectathon-easy', environment = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-reload-team-'));
    let child;
    t.after(async () => {
        try {
            if (child && child.exitCode === null) {
                const exited = once(child, 'exit');
                child.kill('SIGTERM');
                const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
                await exited;
                clearTimeout(timeout);
            }
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
    const configPath = path.join(directory, 'team-config.json');
    const certsDir = path.join(directory, 'certs');
    fs.mkdirSync(certsDir);
    for (const name of ['ds-fhir-server.key', 'ds-fhir-server.crt']) fs.copyFileSync(path.join(certificates(), name), path.join(certsDir, name));
    const config = buildTeamConfig({ runtime: { revision: 1, certificateRevision: 0,
        certsDir, logsDir: path.join(directory, 'logs'), stateDir: path.join(directory, 'state') } }, preset);
    const publish = candidate => fs.writeFileSync(configPath, JSON.stringify(candidate));
    publish(config);
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const env = { ...process.env, TEAM_CONFIG_PATH: configPath, CERTS_DIR: certsDir,
        LOG_DIR: config.runtime.logsDir, HO_ID: 'legacy-ds', PORT: String(port), ...environment };
    // The service must execute its real entrypoint, independent of the test runner's child context.
    delete env.NODE_TEST_CONTEXT;
    child = spawn(process.execPath, [path.resolve(__dirname, '../src/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const entries = () => {
        const file = path.join(config.runtime.logsDir, 'current.log');
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    };
    await until(async () => {
        if (child.exitCode !== null) throw new Error(output);
        return (await request(port)).status === 200;
    }, `startup ${preset}: ${output}`);
    t.diagnostic(JSON.stringify({ preset, runtime: process.version, pid: child.pid,
        sessionId: entries()[0].details.sessionId,
        initialConfigSha256: crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex'),
        tlsCertificateSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(certsDir, 'ds-fhir-server.crt'))).digest('hex') }));
    return { config, configPath, certsDir, port, child, publish, entries };
}

test('valid own presence reaches exact legacy capability refusal while authentication and anonymous failures stay distinct', { timeout: 20000 }, async t => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const issuer = 'https://ds-auth-adapter.internal/legacy-ds';
    const metadata = http.createServer((_req, res) => {
        res.setHeader('content-type', 'application/json');
        if (_req.url.endsWith('/jwks.json')) res.end(JSON.stringify({ keys: [{ ...crypto.createPublicKey(privateKey).export({ format: 'jwk' }), kid: 'presence-owned' }] }));
        else res.end(JSON.stringify({ issuer, jwks_uri: `http://127.0.0.1:${metadata.address().port}/.well-known/jwks.json` }));
    });
    await new Promise(resolve => metadata.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => metadata.close(resolve)));
    const { assertLegacyCapability } = require('../../../clinical-data/test/gateway-presence-contract');
    const system = 'http://fhir.health.gov.il/identifier/il-hdp-test-id', uri = '/fhir/Patient?identifier=' + encodeURIComponent(system + '|1') + '&_summary=count&_count=0';
    for (const preset of ['connectathon-mtls', 'connectathon-easy']) {
        const team = await startTeam(t, preset, { LOCAL_JWT_AUTHORIZATION_SERVER_METADATA_URL: `http://127.0.0.1:${metadata.address().port}/.well-known/oauth-authorization-server` });
        const policy = buildEffectivePolicy(team.config, {}), now = Math.floor(Date.now() / 1000);
        const token = jwt.sign({ schema: 'pcm-ds-local-token/5', authorization_schema: 'pcm-ds-authorization-context/4', ho_id: 'legacy-ds',
            kind: 'online-presence', scenario: 'presence-check', sub: 'pcm-presence-orchestrator', client_id: 'pcm-presence-orchestrator',
            scope: `system/Patient.s?identifier=${system}|1&_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|patientDemographics`,
            pcm_issuer: 'https://pcm.example.test', pcm_audience: 'https://legacy.example.test/fhir', pcm_expires_at: now + 30,
            policy_stamp: simulationPolicyStamp(policy.simulation.perSource['legacy-ds'] || policy.simulation.controls, 'legacy-ds', team.config.runtime.revision),
            request_binding: { method: 'GET', uri }, contract_identifier: { system: 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id', value: 'PCM-POLICY-PRESENCE-001' },
            presence_identifiers: [{ system, value: '1' }], authentication: { correlationVerified: true, tokenEndpointMtlsThumbprint: 'A'.repeat(43), clientAssertionSigningThumbprint: 'B'.repeat(43) }
        }, privateKey, { algorithm: 'RS256', keyid: 'presence-owned', jwtid: crypto.randomUUID(), issuer, audience: 'urn:pcm:ho:legacy-ds:fhir-server', expiresIn: 30 });
        const valid = await request(team.port, uri, token); assertLegacyCapability({ status: valid.status, body: JSON.parse(valid.body), text: valid.body });
        const invalid = await request(team.port, '/fhir/Observation', token); assert.equal(invalid.status, 403); assert.equal(invalid.body, 'Invalid Local Token');
        assert.throws(() => assertLegacyCapability({ status: invalid.status, body: null, text: invalid.body }));
        assert.equal((await request(team.port, '/Observation')).status, 401); assert.equal((await request(team.port)).status, 200);
        assert.ok(team.entries().some(row => row.details.type === 'TOKEN_VALIDATION' && row.details.payload.kind === 'online-presence'));
        t.diagnostic(JSON.stringify({ preset, validOwnPresence: valid.status, capabilityCode: JSON.parse(valid.body).issue[0].code, requestBoundAuthenticationFailure: invalid.body, runtimeQualification: false }));
    }
});

test('disposable TLS team rejects invalid/unreadable input, retains active revision, and recovers the same failed certificate revision', { timeout: 65000 }, async t => {
    // Real signature/discovery/request/policy checks remain active through this reload matrix.
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const issuer = 'https://ds-auth-adapter.internal/legacy-ds';
    const metadata = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url.endsWith('/jwks.json')) res.end(JSON.stringify({ keys: [{ ...crypto.createPublicKey(privateKey).export({ format: 'jwk' }), kid: 'owned' }] }));
        else res.end(JSON.stringify({ issuer, jwks_uri: `http://127.0.0.1:${metadata.address().port}/.well-known/jwks.json` }));
    });
    await new Promise(resolve => metadata.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => metadata.close(resolve)));
    const team = await startTeam(t, 'connectathon-easy', {
        LOCAL_JWT_AUTHORIZATION_SERVER_METADATA_URL: `http://127.0.0.1:${metadata.address().port}/.well-known/oauth-authorization-server`
    });
    const { port, config, configPath, publish, entries } = team;
    const session = entries()[0].details.sessionId;
    /** Re-sign an old bypass context to prove retirement survives runtime reload. */
    const token = (patch = {}) => {
        const policy = buildEffectivePolicy(config, {});
        return jwt.sign({
            schema: 'pcm-ds-local-token/4', authorization_schema: 'pcm-ds-authorization-context/3',
            ho_id: 'legacy-ds', kind: 'unfiltered-simulation', sub: 'owned-adapter', client_id: 'owned-adapter',
            scope: 'system/*.*', pcm_issuer: 'https://pcm.example.test', pcm_audience: 'https://legacy.example.test/fhir',
            pcm_expires_at: Math.floor(Date.now() / 1000) + 30, authentication: { correlationVerified: false, simulation: 'anonymous-source' },
            policy_stamp: simulationPolicyStamp(policy.simulation.perSource['legacy-ds'] || policy.simulation.controls, 'legacy-ds', config.runtime.revision),
            request_binding: { method: 'GET', uri: '/fhir/Observation' }, ...patch
        }, privateKey, { algorithm: 'RS256', keyid: 'owned', jwtid: crypto.randomUUID(), issuer,
            audience: 'urn:pcm:ho:legacy-ds:fhir-server', expiresIn: 30 });
    };
    assert.equal((await request(port, '/fhir/Observation')).status, 401);
    assert.equal((await request(port, '/fhir/Observation', 'invalid.jwt')).status, 403);
    assert.equal((await request(port, '/fhir/Observation', token())).status, 403);

    for (const [label, mutate, restore] of [
        ['malformed JSON', () => fs.writeFileSync(configPath, '{'), () => publish(config)],
        ['incomplete candidate', () => publish({ runtime: { revision: 99 } }), () => publish(config)],
        ['old config version', () => publish({ ...config, configVersion: 'pcm-team-config/4' }), () => publish(config)],
        ['retired global bypass', () => publish({ ...config, securitySimulation: { ...config.securitySimulation, global: { ...config.securitySimulation.global, oauthBearer: false } } }), () => publish(config)],
        ['retired source bypass', () => publish({ ...config, securitySimulation: { ...config.securitySimulation, perSource: { 'legacy-ds': { resultFiltering: false } } } }), () => publish(config)],
        ['retired full-access flag', () => publish({ ...config, sandbox: { grantFullClinicalAccess: false } }), () => publish(config)],
        ['contract mismatch', () => publish({ ...config, contract: { ...config.contract, pcmIgVersion: '0.4.0' } }), () => publish(config)],
        ['unreadable selected file', () => { fs.unlinkSync(configPath); fs.mkdirSync(configPath); }, () => { fs.rmdirSync(configPath); publish(config); }]
    ]) {
        const before = entries().filter(row => row.message === 'DS FHIR config reload rejected').length;
        mutate();
        await until(() => entries().filter(row => row.message === 'DS FHIR config reload rejected').length >= before + 2, label);
        assert.equal((await request(port)).status, 200);
        assert.equal((await request(port, '/fhir/Observation')).status, 401);
        assert.equal((await request(port, '/fhir/Observation', token())).status, 403);
        const rejection = entries().findLast(row => row.message === 'DS FHIR config reload rejected');
        assert.equal(rejection.details.activeRevision, '1:0:https');
        assert.equal(rejection.details.stage, 'config');
        restore();
        assert.equal((await request(port, '/fhir/Observation', token())).status, 403);
    }
    const clinicalDenials = [];
    for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
        const selected = buildTeamConfig({}, preset);
        for (const key of ['conformance', 'security', 'securitySimulation', 'legacyDataSource']) config[key] = selected[key];
        config.runtime.revision += 1; publish(config);
        const currentClinical = token({ schema: 'pcm-ds-local-token/5', authorization_schema: 'pcm-ds-authorization-context/4',
            kind: 'data-source-access', scope: 'patient/Observation.rs', scenario: 'consent-access',
            patient_identifier: { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' },
            consent_identifier: { system: 'urn:owned:consent', value: 'one' },
            healthcare_service_identifier: { system: 'urn:owned:service', value: 'one' },
            organization: { system: 'urn:owned:organization', value: 'one' },
            authentication: { correlationVerified: true, tokenEndpointMtlsThumbprint: 'A'.repeat(43), clientAssertionSigningThumbprint: 'B'.repeat(43) } });
        const currentStatus = (await request(port, '/fhir/Observation', currentClinical)).status;
        assert.equal(currentStatus, 403);
        clinicalDenials.push({ preset, currentSignedClinical: currentStatus, schema: 'pcm-ds-local-token/5', route: '/fhir/Observation' });
        assert.equal((await request(port, '/Observation', currentClinical)).status, 403);
        assert.equal((await request(port, '/Observation')).status, 401);
        assert.equal((await request(port, '/fhir/Observation', token())).status, 403);
    }
    t.diagnostic(JSON.stringify({ clinicalDenials }));
    // Restore this transport/revision fixture after the separately observed preset denial matrix.
    const easy = buildTeamConfig();
    for (const key of ['conformance', 'security', 'securitySimulation', 'legacyDataSource']) config[key] = easy[key];
    config.runtime.revision = 1; publish(config);
    const staleToken = token();
    config.runtime.revision = 2;
    publish(config);
    await until(() => entries().some(row => row.details.type === 'PROCESS_RELOAD_COMPLETE' && row.details.activeRevision === '2:0:https'), 'valid revision active');
    assert.equal((await request(port, '/fhir/Observation', staleToken)).status, 403);
    assert.equal((await request(port, '/fhir/Observation', token())).status, 403);

    const key = path.join(team.certsDir, 'ds-fhir-server.key');
    fs.renameSync(key, `${key}.saved`);
    config.runtime.certificateRevision = 1;
    publish(config);
    await until(() => entries().some(row => row.details.stage === 'prepare-listener' && row.details.attemptedRevision === '2:1:https'), 'missing TLS key');
    assert.equal((await request(port)).status, 200);
    assert.equal((await request(port, '/fhir/Observation', token())).status, 403);
    assert.equal(entries().findLast(row => row.details.stage === 'prepare-listener').details.activeRevision, '2:0:https');
    fs.renameSync(`${key}.saved`, key);
    await until(() => entries().some(row => row.details.type === 'PROCESS_RELOAD_COMPLETE' && row.details.activeRevision === '2:1:https'), 'same certificate revision recovery');
    assert.equal((await request(port)).status, 200);
    assert.equal((await request(port, '/fhir/Observation', token())).status, 403);
    assert.equal((await request(port)).headers['x-pcm-simulation-preset'], 'connectathon-easy');
    const balanced = buildTeamConfig({ runtime: { ...config.runtime, revision: 3 } }, 'connectathon-balanced');
    publish(balanced);
    await until(() => entries().some(row => row.details.type === 'PROCESS_RELOAD_COMPLETE' && row.details.activeRevision === '3:1:https'), 'replacement policy active');
    assert.equal((await request(port)).headers['x-pcm-simulation-preset'], 'connectathon-balanced');
    assert.equal((await request(port, '/fhir/Observation')).status, 401);
    assert.equal(entries().filter(row => row.details.type === 'PROCESS_BOOT').length, 1);
    assert.ok(entries().every(row => row.details.sessionId === session));
    assert.ok(entries().filter(row => row.details.type === 'PROCESS_RELOAD_COMPLETE').every(row => row.details.pid === team.child.pid));
    assert.equal(entries().some(row => row.details.activeRevision?.startsWith('99:')), false);
    t.diagnostic(JSON.stringify({ sessionId: session,
        finalConfigSha256: crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex'),
        activeRevisions: entries().filter(row => ['PROCESS_LISTENING', 'PROCESS_RELOAD_COMPLETE'].includes(row.details.type)).map(row => row.details.activeRevision),
        rejectedPolls: entries().filter(row => row.message === 'DS FHIR config reload rejected').length }));
});

for (const preset of ['connectathon-balanced', 'connectathon-mtls', 'strict']) {
    test(`disposable ${preset} TLS listener activates its validated revision and preserves missing-token denial`, { timeout: 20000 }, async t => {
        const team = await startTeam(t, preset);
        team.config.runtime.revision = 2;
        team.publish(team.config);
        await until(() => team.entries().some(row => row.details.type === 'PROCESS_RELOAD_COMPLETE' && row.details.activeRevision === '2:0:https'), `${preset} revision 2`);
        assert.equal(JSON.parse((await request(team.port)).body).conformanceMode, preset === 'strict' ? 'strict' : 'connectathon');
        assert.equal((await request(team.port, '/fhir/Observation')).status, 401);
        assert.equal(team.entries().filter(row => row.details.type === 'PROCESS_BOOT').length, 1);
    });
}

test('real asynchronous EADDRINUSE restores the prior listener and retries the unchanged revision', async t => {
    const occupied = http.createServer((req, res) => res.end('occupied'));
    await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => occupied.close(resolve)));
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    let snapshot = { revision: '1', policy: {} };
    let count = 0;
    const events = [];
    const servers = [];
    const runtime = createRuntimeListener({
        port, configPath: '/owned/disposable-team.json', readSnapshot: () => snapshot,
        createServer: candidate => {
            const server = http.createServer((req, res) => res.end(candidate.revision));
            // Force only the second candidate to encounter a real kernel bind conflict.
            if (++count === 2) {
                const bind = server.listen.bind(server);
                server.listen = () => bind(occupied.address().port, '127.0.0.1');
            }
            servers.push(server);
            return server;
        },
        logger: Object.fromEntries(['info', 'error'].map(level => [level, (message, details) => events.push({ message, ...details })]))
    });
    t.after(() => runtime.stop());
    await runtime.start();
    snapshot = { revision: '2', policy: {} };
    await runtime.check();
    assert.equal(runtime.getActive().revision, '1');
    assert.ok(events.some(row => row.stage === 'listener' && row.error?.includes('EADDRINUSE')));
    assert.equal(servers[0].listening, true);
    assert.equal(servers[0].address().port, port);
    assert.equal(events.at(-1).type, 'PROCESS_RELOAD_ROLLBACK');
    const read = server => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, agent: false }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve(body));
    }).on('error', reject));
    assert.equal(await read(servers[0]), '1');
    await runtime.check();
    assert.equal(runtime.getActive().revision, '2');
    assert.equal(servers[2].address().port, port);
    assert.equal(await read(servers[2]), '2');
});
