'use strict';
/** Versioned disposable approval fixture; no retained configuration or clinical data. */
const { startApprovalFixture } = require('./approval-scope-fixture');
const { SYSTEM } = require('../src/shared/service-confidentiality-policy');
const V = `_security:not=${SYSTEM}|V`;
const EXACT = `patient/Patient.rs?${V} patient/Observation.s?status=final&${V}`;

/** Replace only one owned canonical definition with the accepted creation model. */
function versionDefinition(store) {
    const input = { name: 'Snapshot final laboratory service', purpose: 'Exact default and deliberate alternatives', category: '35',
        accessMode: 'continuous', duration: 1, durationUnit: 'a', allowChanges: false,
        buckets: [{ code: 'laboratoryTests', history: 2, historyUnit: 'a', sensitivity: [] }],
        permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 's' }], scopeOrigin: 'custom', approvalScope: EXACT };
    const current = store.get('HealthcareService', require('../src/pcm-core/src/fhir/healthcare-service-lifecycle').basedOnId(store.get('HealthcareService', 'approval-lab-follow-up')));
    return require('./private-definition').replaceDefinition(store, current, input, { now: Date.parse('2026-01-05T12:00:00Z') / 1000 });
}

/** Start actual existing HTTP approval/source/cancellation routes with exact definitions. */
async function startSnapshotFixture() {
    const fixture = await startApprovalFixture();
    versionDefinition(fixture.store);
    const effective = require('./team-config').buildTeamConfig({}, 'connectathon-mtls');
    for (const key of ['conformance', 'security', 'securitySimulation', 'legacyDataSource']) fixture.config[key] = effective[key];
    const fs = require('node:fs'), path = require('node:path'), https = require('node:https');
    fs.cpSync(require('./certificates').certificates(), process.env.CERTS_DIR, { recursive: true });
    const api = require('express')(), requests = [];
    api.use((req, res, next) => {
        const receivedPath = req.originalUrl, certificate = req.socket.getPeerCertificate()?.fingerprint256 || null;
        res.on('finish', () => requests.push({ method: req.method, path: receivedPath, status: res.statusCode, certificate })); next();
    });
    api.use(require('../src/pcm-core/src/index').createApiApp());
    const apiServer = https.createServer({ key: fs.readFileSync(path.join(process.env.CERTS_DIR, 'pcm-core.key')),
        cert: fs.readFileSync(path.join(process.env.CERTS_DIR, 'pcm-core.crt')), ca: fs.readFileSync(path.join(process.env.CERTS_DIR, 'rootCA.crt')),
        requestCert: true, rejectUnauthorized: false }, api);
    await new Promise(resolve => apiServer.listen(0, '0.0.0.0', resolve));
    fixture.config.internalBaseUrls.pcmAuth = `https://localhost:${apiServer.address().port}/api/fhir-service/r4`;
    fixture.config.internalBaseUrls.pcmFhir = fixture.config.internalBaseUrls.pcmAuth;
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(fixture.config));
    fixture.requests = requests;
    const close = fixture.close;
    fixture.close = async () => { apiServer.closeAllConnections(); await new Promise(resolve => apiServer.close(resolve)); await close(); require('../src/pcm-core/src/store').tokens.clear(); };
    return fixture;
}
module.exports = { startSnapshotFixture, versionDefinition, EXACT, V };
