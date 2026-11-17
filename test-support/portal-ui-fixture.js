'use strict';
/** Disposable actual portal routes with bounded patient-source responses; no retained state. */
const fs = require('node:fs'), path = require('node:path'), express = require('express');

/**
 * Start actual approval, OTP and SMART routes for focused presentation journeys.
 * The source transport is synthetic; protocol/authority enforcement is not qualified here.
 * @returns {Promise<object>} Owned listeners, stores, captures and explicit clock control.
 */
async function startPortalFixture() {
    const approval = await require('./consent-snapshot-fixture').startSnapshotFixture();
    // Exercise the ordinary lifecycle with an exact maximum-length resource identity.
    const create = approval.create;
    approval.create = (serviceKey, longId = false) => {
        if (!longId) return create(serviceKey);
        const request = structuredClone(require('../docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json'));
        request.patient.identifier = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' };
        request.extension.find(item => item.url.endsWith('/ext-pcm-service')).valueReference.reference = 'HealthcareService/approval-lab-follow-up';
        return require('../src/pcm-core/src/fhir/consent-lifecycle').createConsent({ store: approval.store,
            callerOrganization: approval.store.get('Organization', approval.config.organizations.serviceProvider.id), request,
            idGenerator: () => 'portal-' + 'c'.repeat(57) });
    };
    const { dataGrantFixture } = require('./data-grants');
    let now = Math.floor(Date.now() / 1000);
    const { config, strongPatient } = dataGrantFixture({ now });
    const { SystemFlowStore } = require('../src/pcm-core/src/system-flow-store');
    const { SystemWorkflows, CONTACT_EVIDENCE, OTP_PURPOSE, PURPOSE_SYSTEM } = require('../src/pcm-core/src/system-workflows');
    const flows = new SystemFlowStore(config, { clock: () => now });
    let sourceCalls = 0;
    const patient = { resourceType: 'Patient', id: 'portal-patient', identifier: [strongPatient], birthDate: '1980-01-02', name: [{ text: 'Portal Test Patient' }], telecom: [{ system: 'sms', value: '0500000000', extension: [
        { url: OTP_PURPOSE, valueCodeableConcept: { coding: [{ system: PURPOSE_SYSTEM, code: 'OTP' }] } },
        { url: CONTACT_EVIDENCE, extension: [{ url: 'verifiedAt', valueDateTime: new Date(now * 1000).toISOString() }] }
    ] }] };
    const workflow = new SystemWorkflows({ config, flows, clock: () => now, codeGenerator: () => '123456', request: async () => {
        sourceCalls++; return { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: patient }] };
    } });
    const { FileAuthorizationRecordRepository, pkceS256 } = require('../src/pcm-core/src/authorization-store');
    const authorization = new FileAuthorizationRecordRepository(fs.mkdtempSync('/tmp/portal-smart-'), { clock: () => now });
    const { BrowserAuthenticatedIdentityProvider } = require('../src/pcm-core/src/sandbox-identity-provider');
    const client = { clientId: 'portal-app', name: 'Portal registered application', role: 'service-provider', authorizationCodeGrant: true, redirectUris: [], smartScopes: ['patient/*.rs'] };
    const service = require('../src/pcm-core/src/authorize-service').createAuthorizeService({ store: authorization,
        findClient: id => id === client.clientId ? client : null,
        identityProvider: new BrowserAuthenticatedIdentityProvider(config.patients, flows), getFhirAudience: () => 'https://pcm.test/r4' });
    const app = express(), requests = [];
    app.set('view engine', 'ejs'); app.set('views', path.resolve(__dirname, '../src/pcm-core/src/views'));
    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => {
        res.once('finish', () => requests.push({ method: req.method, path: req.path, status: res.statusCode, ...(req.method === 'POST' ? { body: req.body } : {}) })); next();
    });
    app.use('/assets', express.static(path.resolve(__dirname, '../src/shared/ui')));
    app.use(require('../src/pcm-core/src/routes/system-workflows').createSystemWorkflowRouter({ loadConfig: () => config, runtime: () => workflow, authorize: () => service }));
    const pcmPath = '/api/fhir-service/r4';
    app.use(pcmPath, require('../src/pcm-core/src/routes/authorize').createAuthorizeRouter({ config, service, requireMtls: (req, res, next) => next() }));
    app.get('/doctor', (req, res) => res.send('Configured Doctor return'));
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    config.publicBaseUrls.spClient = base + '/doctor'; config.publicBaseUrls.pcmUi = approval.base;
    client.redirectUris = [base + '/doctor'];
    // The error responder uses the owning configured Doctor address, never request input.
    approval.config.publicBaseUrls.spClient = base + '/doctor';
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(approval.config));
    return { approval, base, config, flows, workflow, authorization, strongPatient, requests, sourceCalls: () => sourceCalls,
        now: () => now,
        advance(seconds) { now += seconds; },
        smartUrl() { return base + pcmPath + '/authorize?' + new URLSearchParams({ client_id: client.clientId, redirect_uri: client.redirectUris[0], response_type: 'code', scope: 'patient/Observation.rs', aud: 'https://pcm.test/r4', state: 'portal-exact-state', code_challenge: pkceS256('A'.repeat(43)), code_challenge_method: 'S256' }); },
        async close() {
            server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
            fs.rmSync(authorization.directory, { recursive: true, force: true }); await approval.close();
        }
    };
}
module.exports = { startPortalFixture };
