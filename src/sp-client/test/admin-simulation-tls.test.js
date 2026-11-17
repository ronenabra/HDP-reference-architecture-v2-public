'use strict';

/** Verify saved Admin simulation controls through real Doctor TLS connections. */
const { installTestRuntime, buildTeamConfig } = require('../../../test-support/team-config');
installTestRuntime();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { presetSimulationDefaults, presetSourceDefaults } = require('../../shared/conformance-policy');
const router = require('../../pcm-core/src/routes/ui');
const client = require('../src/client');
const handler = router.stack.find(layer => layer.route?.path === '/admin/config/simulation').route.stack[0].handle;
const fixtures = require('../../../test-support/certificates').certificates();

/** Submit the complete browser form and require successful policy persistence. */
function saveVerification(enabled, perSource = presetSourceDefaults('connectathon-balanced')) {
    const config = JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));
    const controls = { ...presetSimulationDefaults(config.conformance.preset), serverCertificateVerification: enabled };
    const body = { adminForm: 'simulation', expectedRevision: String(config.runtime.revision || 0), sourceId: '', resetDefaults: 'false', preset: config.conformance.preset };
    for (const [name, value] of Object.entries(controls)) if (value) body[`control.${name}`] = 'true';
    const submit = body => {
        const result = { status: 200 };
        const req = { body, get: () => 'application/json', headers: { accept: 'application/json' } };
        const res = { status(code) { result.status = code; return this; }, json(value) { result.body = value; return this; }, format(types) { types.json(); } };
        handler(req, res); assert.equal(result.status, 200, JSON.stringify(result.body));
    };
    submit(body);
    for (const id of new Set([...Object.keys(config.securitySimulation.perSource), ...Object.keys(perSource)])) {
        const current = JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));
        const sourceId = require('../../pcm-core/src/admin-security').sources(current).find(source => source.policyId === id).id;
        submit({ adminForm: 'simulation', expectedRevision: String(current.runtime.revision || 0), sourceId, resetDefaults: 'false', preset: current.conformance.preset,
            ...Object.fromEntries(Object.keys(controls).map(name => [`control.${name}`, Object.hasOwn(perSource[id] || {}, name) ? String(perSource[id][name]) : 'inherit'])) });
    }
}

/** Use the Doctor's current source policy and agent for one actual HTTPS request. */
function probe(endpoint) {
    const options = client._test.dataSourceTransportOptions('hospital-a', endpoint);
    assert.ok(options.httpsAgent, 'fixture must use the real Doctor HTTPS agent');
    return new Promise((resolve, reject) => {
        const request = https.get(`${endpoint}/Observation`, { agent: options.httpsAgent }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });
        request.once('error', reject);
    }).finally(() => options.httpsAgent.destroy());
}

/** Start a private, ephemeral synthetic TLS fixture and return its FHIR URL. */
async function startServer(tls) {
    const server = https.createServer(tls, (_req, res) => res.writeHead(200, { 'Content-Type': 'application/fhir+json' })
        .end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry: [] })));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, endpoint: `https://127.0.0.1:${server.address().port}/fhir` };
}

for (const preset of ['connectathon-easy','connectathon-balanced','connectathon-mtls','strict']) test(`${preset}: Admin verification forms control actual trusted/untrusted/named-source Doctor TLS`, async t => {
    fs.cpSync(fixtures, process.env.CERTS_DIR, { recursive: true });
    const untrustedKey = path.join(process.env.CERTS_DIR, 'untrusted-server.key');
    const untrustedCert = path.join(process.env.CERTS_DIR, 'untrusted-server.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', untrustedKey, '-out', untrustedCert], { stdio: 'ignore' });
    const trusted = { cert: fs.readFileSync(path.join(fixtures, 'ds-gateway.crt')), key: fs.readFileSync(path.join(fixtures, 'ds-gateway.key')) };
    const untrusted = { cert: fs.readFileSync(untrustedCert), key: fs.readFileSync(untrustedKey) };
    const a = await startServer(trusted);
    const b = await startServer(untrusted);
    t.after(async () => {
        for (const { server } of [a, b]) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });
    const config = buildTeamConfig({}, preset);
    config.healthOrganizations[0].endpoint = a.endpoint;
    config.healthOrganizations[1].endpoint = b.endpoint;
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));

    await t.test('verification enabled accepts trusted certificates and rejects untrusted certificates', async () => {
        saveVerification(true);
        assert.equal(await probe(a.endpoint), 200);
        await assert.rejects(probe(b.endpoint), /self.signed|certificate|unable to verify/i);
    });
    if (preset === 'strict') return;
    await t.test('verification disabled accepts both trusted and untrusted synthetic servers', async () => {
        saveVerification(false);
        assert.equal(await probe(a.endpoint), 200);
        assert.equal(await probe(b.endpoint), 200);
    });
    await t.test('named source override permits only that source and re-enabling restores verification', async () => {
        a.server.setSecureContext(untrusted);
        saveVerification(true, { ...presetSourceDefaults('connectathon-balanced'), 'ho-a': { serverCertificateVerification: false } });
        assert.equal(await probe(a.endpoint), 200);
        await assert.rejects(probe(b.endpoint), /self.signed|certificate|unable to verify/i);
        saveVerification(true);
        await assert.rejects(probe(a.endpoint), /self.signed|certificate|unable to verify/i);
    });
});
