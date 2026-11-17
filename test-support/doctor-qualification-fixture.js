'use strict';
/** Real disposable PCM/Doctor/Consents plus a bounded synthetic source; no native enforcement claim. */
const fs = require('node:fs'), https = require('node:https');
const { SYSTEM, URI } = require('../src/shared/sandbox-patients');

/**
 * Start the existing applications with owned registrations, Contract sampling and PCM approval.
 * @returns {Promise<object>} Owned runtime, registrations, captures and asynchronous cleanup.
 */
async function startDoctorQualificationFixture() {
    const runtime = await require('./pcm-042-runtime').startRuntime({ preset: 'connectathon-mtls', protocol: 'http' });
    const store = require('../src/pcm-core/src/fhir/store'), { tokens } = require('../src/pcm-core/src/store');
    const requests = [], violations = [];
    const source = https.createServer(runtime.tlsOptions, (req, res) => {
        const url = new URL(req.url, 'https://localhost'), token = tokens.get(req.headers.authorization?.slice(7));
        const row = { method: req.method, path: url.pathname, query: url.search, kind: token?.kind, scope: token?.scope };
        requests.push(row);
        const sample = token?.kind === 'sandbox_patient_sample';
        const valid = req.method === 'GET' && token && token.aud === sourceBase && token.exp > Date.now() / 1000
            && (sample ? '/fhir' + req.url === URI : token.kind === 'data_source_access' && url.pathname === '/Observation' && url.searchParams.get('_count') === '10');
        if (!valid) { violations.push(row); res.writeHead(403); return res.end(); }
        const resource = sample ? { resourceType: 'Patient', identifier: [{ system: SYSTEM, value: 'Ab123456-1234-5678-9012-000000000001' }], name: [{ text: 'Alex Qualification' }],
            meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }] } }
            : { resourceType: 'Observation', id: 'owned-first-page', status: 'final' };
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: 20, entry: [{ resource }], link: [{ relation: 'next', url: sourceBase + '/never-follow' }] }));
    });
    await new Promise(resolve => source.listen(0, resolve));
    const sourceBase = `https://localhost:${source.address().port}`;
    const config = runtime.config;
    config.healthOrganizations[0].endpoint = sourceBase;
    config.sandboxSampling = { sourceIds: [config.healthOrganizations[0].id] };
    config.serviceCatalog = { file: 'config/demo-services.json', bindings: [{ application: 'doctor', providerRole: 'serviceProvider',
        serviceKey: 'lab-follow-up', instanceId: 'qualification-initial-service', instanceIdentifier: 'QUALIFICATION-INITIAL-SERVICE' }] };
    for (const role of ['serviceProvider', 'hospitalBServiceProvider']) config.systemAuthorization.clientEntitlements[config.organizations[role].clientId] = ['sandbox-patient-sample'];
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
    store.clear(); tokens.clear();
    await require('../src/pcm-core/src/bootstrap')();
    const services = require('./services-list-fixture').installServicesListFixture({ store, config });
    // The list fixture intentionally replaces all services; restore only the existing sampler's own published pair.
    for (const resource of require('../src/pcm-core/src/fhir/sampling-policy').samplingResourceDrafts(config)) {
        if (!store.get(resource.resourceType, resource.id)) require('../src/pcm-core/src/public-fhir').publishNewResource(store, resource);
    }
    // Each disposable runtime owns a fresh dashboard; process-local state must not leak between tests.
    await fetch(runtime.doctorBase + '/reset', { method: 'POST', redirect: 'manual' });
    runtime.api.on('request', (req, res) => res.once('finish', () => requests.push({ method: req.method, path: new URL(req.url, 'https://localhost').pathname, status: res.statusCode,
        ...(req.method === 'POST' && req.url.endsWith('/Consent') ? { body: req.body } : {}),
        ...(req.url.endsWith('/token') ? { scope: req.body?.scope, basis: req.body?.authorization_details ? JSON.parse(req.body.authorization_details)[0]?.fhirContext?.[0]?.type : undefined } : {}) })));
    runtime.ui.on('request', (req, res) => res.once('finish', () => requests.push({ method: req.method, path: new URL(req.url, 'http://localhost').pathname, status: res.statusCode, ui: true })));
    return { ...runtime, store, services, sourceBase, requests, violations,
        async close() {
            require('../src/sp-client/src/client').resetCache();
            source.closeAllConnections(); await new Promise(resolve => source.close(resolve));
            for (const server of [runtime.api, runtime.ui, runtime.doctor]) server.closeAllConnections();
            await runtime.close(); tokens.clear(); store.clear();
        }
    };
}
module.exports = { startDoctorQualificationFixture };
