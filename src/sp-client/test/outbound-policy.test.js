const { buildTeamConfig } = require('../../../test-support/team-config');
/** Regression probes for offline Doctor selection and global TLS simulation. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
test('offline patient selection makes no inventory request', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-inventory-guard-'));
    const previousPath = process.env.TEAM_CONFIG_PATH;
    const previousFetch = global.fetch;
    const modulePath = path.join(root, 'src/sp-client/src/team-config');
    let requests = 0;
    try {
        process.env.TEAM_CONFIG_PATH = path.join(directory, 'team-config.json');
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(buildTeamConfig({ internalBaseUrls: { pcmUi: 'http://[::ffff:169.254.169.254]' } })));
        global.fetch = async () => { requests++; return { ok: true, json: async () => ({ patients: [] }) }; };
        delete require.cache[require.resolve(modulePath)];
        const team = require(modulePath);
        assert.deepEqual(team.loadPatients(), []);
        assert.equal(team.loadManagedPatients, undefined);
        assert.equal(requests, 0);
    } finally {
        global.fetch = previousFetch;
        if (previousPath === undefined) delete process.env.TEAM_CONFIG_PATH;
        else process.env.TEAM_CONFIG_PATH = previousPath;
        delete require.cache[require.resolve(modulePath)];
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
test('global source transport controls override old security fields and preserve source isolation', () => {
    const { buildEffectivePolicy } = require(path.join(root, 'src/shared/conformance-policy'));
    const policy = buildEffectivePolicy({
        conformance: { mode: 'connectathon', preset: 'connectathon-easy' },
        organizations: { dataSources: [{ id: 'source-a' }, { id: 'source-b' }] },
        security: { dataSourceGateway: { clientAuth: 'mtls' }, serviceProviderToDataSource: { verifyServerCertificate: true }, dsGatewayToFhirServer: { verifyServerCertificate: true } },
        securitySimulation: { global: { publicClientMtls: false, serverCertificateVerification: false }, perSource: { 'source-a': { serverCertificateVerification: true } } }
    }, {});
    assert.equal(policy.transport.serviceProviderToDataSource.verifyServerCertificate, false);
    assert.equal(policy.transport.dataSourceGatewayToFhir.verifyServerCertificate, false);
    assert.equal(policy.transport.dataSourceGateway.clientAuth, 'tls');
    assert.equal(policy.simulation.perSource['source-a'].serverCertificateVerification, true);
    assert.equal(policy.simulation.controls.serverCertificateVerification, false);
});
