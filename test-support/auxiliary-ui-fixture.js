'use strict';
/** Disposable actual Doctor/PCM UI routes with explicit synthetic management/protocol transports. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), express = require('express');

/** Start mounted UI listeners without credentials, external connections or retained state.
 * @returns {Promise<object>} Owned fixture, transport captures and cleanup callback.
 */
async function startAuxiliaryFixture() {
    const previousEnv = { ...process.env };
    const config = require('./team-config').installTestRuntime();
    config.organizations.serviceProvider.name = 'Requesting application / '.repeat(8);
    const calls = [], state = { empty: false, unavailable: false, expired: false, rejected: false };
    const organization = { resourceType: 'Organization', id: 'org-' + 'a'.repeat(60), name: 'Organization / '.repeat(25), type: [{ coding: [{ code: 'service-provider' }] }] };
    const endpoint = { resourceType: 'Endpoint', id: 'ep-' + 'b'.repeat(61), status: 'suspended', name: 'Endpoint / '.repeat(25), address: 'https://source.example.test/' + 'long-segment/'.repeat(16) };
    const clientPath = require.resolve('../src/sp-client/src/client'), indexPath = require.resolve('../src/sp-client/src/index');
    const loggerPath = require.resolve('../src/sp-client/src/logger');
    const previousClient = require.cache[clientPath], previousIndex = require.cache[indexPath], previousLogger = require.cache[loggerPath];
    delete require.cache[loggerPath];
    const client = {
        resetCache() {}, searchConsents: async () => [], ownTokenInspectionCapability: () => ({ enabled: false, message: 'Not checked' }),
        searchServices: async () => ({ services: [], warnings: [], complete: true, pages: 1, used: { requests: 1, bytes: 0 } }),
        getConformanceInfo: () => ({ resultLabel: 'SYNTHETIC UI FIXTURE', version: 4, warnings: [] }),
        fetchMyOrganization: async identity => {
            calls.push({ action: 'read', identity });
            if (state.unavailable) throw new Error('Synthetic source unavailable');
            return { resourceType: 'Bundle', entry: state.empty ? [] : [organization, endpoint].map(resource => ({ resource: structuredClone(resource) })) };
        },
        updateResource: async (type, id, data, identity) => {
            calls.push({ action: 'update', type, id, data, identity });
            if (state.rejected) throw new Error('Synthetic PCM validation rejected this field');
            Object.assign(endpoint, data); return structuredClone(endpoint);
        },
        requestCatalogUpdate: async (data, reason, identity) => { calls.push({ action: 'catalog', data, reason, identity }); return { parameter: [{ name: 'requestId', valueString: 'catalog-receipt-000001' }] }; },
        beginSmartAuthorization: async ({ scope }) => require('../src/sp-client/src/smart-authorization').createAuthorizationTransaction({
            authorizationEndpoint: 'https://pcm.example.test/authorize', clientId: 'synthetic-client', redirectUri: config.publicBaseUrls.spClient + '/callback',
            audience: config.contract.operational.fhirBase, scope, ...(state.expired ? { clock: () => Date.now() - 600000 } : {}) }),
        exchangeSmartAuthorization: async (transaction, query, identity) => {
            calls.push({ action: 'exchange', identity });
            if (query.error) throw Object.assign(new Error('The test launch was denied.'), { oauthError: query.error });
            return { scope: 'patient/Observation.rs' };
        }
    };
    require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true, exports: client }; delete require.cache[indexPath];
    const parent = express(), pcmParent = express(), server = http.createServer(parent), pcmServer = http.createServer(pcmParent);
    await Promise.all([server, pcmServer].map(listener => new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); })));
    const base = `http://127.0.0.1:${server.address().port}`, pcmBase = `http://127.0.0.1:${pcmServer.address().port}`;
    config.publicBaseUrls.spClient = base + '/doctor'; config.publicBaseUrls.pcmUi = pcmBase + '/pcm';
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
    let pcm;
    const close = async () => {
        pcm?.locals.closeLogSearch(); await Promise.all([server, pcmServer].map(listener => { listener.closeAllConnections(); return new Promise(resolve => listener.close(resolve)); }));
        fs.rmSync(path.dirname(process.env.TEAM_CONFIG_PATH), { recursive: true, force: true });
        if (previousClient) require.cache[clientPath] = previousClient; else delete require.cache[clientPath];
        if (previousIndex) require.cache[indexPath] = previousIndex; else delete require.cache[indexPath];
        if (previousLogger) require.cache[loggerPath] = previousLogger; else delete require.cache[loggerPath];
        for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]; Object.assign(process.env, previousEnv);
    };
    try {
        parent.use('/doctor', require(indexPath).app);
        pcm = require('../src/pcm-core/src/index').createUiApp(); pcmParent.use('/pcm', pcm);
    } catch (error) { await close(); throw error; }
    return { base, doctor: base + '/doctor', pcm: pcmBase + '/pcm', calls, state, config, organization, endpoint,
        close
    };
}
module.exports = { startAuxiliaryFixture };
