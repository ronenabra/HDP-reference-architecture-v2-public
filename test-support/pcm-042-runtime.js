'use strict';

/** Disposable real PCM API and Doctor listeners for focused 0.4.2 transport proof. */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { installTestRuntime, buildTeamConfig } = require('./team-config');
const root = path.resolve(__dirname, '..');
const { PCM_PATH, environmentEndpoints } = require('../src/shared/pcm-environment');

/**
 * Start isolated real applications with synthetic identity and separate key roles.
 * @param {object} options Ephemeral ports, security preset and Doctor protocol.
 * @returns {Promise<object>} Listener handles, effective fixture and cleanup/reload helpers.
 */
async function startRuntime({ apiPort = 0, doctorPort = 0, uiPort = 0, preset = 'strict', protocol = 'https' } = {}) {
    const config = installTestRuntime({ conformance: { preset } });
    process.env.CERTS_DIR = require('./certificates').certificates();
    config.runtime.certsDir = process.env.CERTS_DIR;
    for (const [index, source] of config.healthOrganizations.entries()) {
        const role = ['ds-gateway', 'hospital-b-sp', 'presence-orchestrator'][index];
        source.certificates.gatewayAssertionCert = `${role}-assertion.crt`;
        source.certificates.gatewayAssertionKey = `${role}-assertion.key`;
        source.certificates.gatewayMtlsCert = `${role}.crt`;
        source.certificates.gatewayMtlsKey = `${role}.key`;
    }
    config.patients = [{ idSystem: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', idValue: '04102-patient', display: 'Synthetic SMART patient' }];
    const { readHttpsOptions } = require('../src/pcm-core/src/api-server-manager');
    const tlsOptions = readHttpsOptions(process.env.CERTS_DIR, 'tls');
    // Bind before loading clients: registered redirects must match actual browser ports.
    const api = https.createServer(tlsOptions);
    const ui = http.createServer();
    const doctor = protocol === 'https' ? https.createServer(tlsOptions) : http.createServer();
    await Promise.all([api, doctor, ui].map((server, index) => new Promise(resolve => server.listen([apiPort, doctorPort, uiPort][index], resolve))));
    const apiBase = `https://localhost:${api.address().port}${PCM_PATH}`;
    const doctorBase = `${protocol}://localhost:${doctor.address().port}`;
    process.env.TEAM_ADMIN_PASSWORD = '04102-local-fixture-only';
    config.publicBaseUrls.pcmUi = `http://localhost:${ui.address().port}`;
    config.publicBaseUrls.pcmApi = apiBase;
    config.publicBaseUrls.spClient = doctorBase;
    config.internalBaseUrls.pcmAuth = apiBase;
    config.internalBaseUrls.pcmFhir = apiBase;
    config.organizations.serviceProvider.redirectUri = `${doctorBase}/callback`;
    config.organizations.serviceProvider.redirectUris = [`${doctorBase}/callback`];
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
    const { createApiApp } = require('../src/pcm-core/src/index');
    api.on('request', createApiApp());
    ui.on('request', require('../src/pcm-core/src/index').createUiApp());
    doctor.on('request', require('../src/sp-client/src/index').app);
    return { api, doctor, ui, config, apiBase, doctorBase, tlsOptions, endpoints: environmentEndpoints(config.contract.environment),
        async close() { await Promise.all([api, doctor, ui].map(server => new Promise(resolve => server.close(resolve)))); },
        /** Persist and reload the selected preset, retaining this runtime's URLs and identities. */
        preset(nextPreset) {
            const next = buildTeamConfig(config, nextPreset);
            // buildTeamConfig applies overrides last, so replace the explicit preset policy fields.
            const defaults = buildTeamConfig({}, nextPreset);
            next.conformance = defaults.conformance;
            next.security = { ...defaults.security, pcmApi: { ...defaults.security.pcmApi, accessTokenExpiresInSeconds: config.security.pcmApi.accessTokenExpiresInSeconds } };
            next.securitySimulation = defaults.securitySimulation;
            next.legacyDataSource = defaults.legacyDataSource;
            require('../src/pcm-core/src/team-config').saveTeamConfig(next);
            Object.assign(config, next);
            return require('../src/pcm-core/src/team-config').getEffectiveConformancePolicy();
        }
    };
}

if (require.main === module) startRuntime({ apiPort: 4443, doctorPort: 4444, uiPort: 4445,
    preset: process.env.PCM_TEST_PRESET || 'strict', protocol: process.env.PCM_TEST_PROTOCOL || 'https' }).then(runtime => {
    console.log(JSON.stringify({ ready: true, node: process.version, apiBase: runtime.apiBase, doctorBase: runtime.doctorBase }));
    process.on('SIGTERM', async () => { await runtime.close(); process.exit(0); });
}).catch(error => { console.error(error); process.exit(1); });
module.exports = { startRuntime };
