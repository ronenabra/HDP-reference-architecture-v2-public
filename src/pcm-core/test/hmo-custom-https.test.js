'use strict';

/** Real registered custom HMO, PCM OAuth/introspection and independent source HTTPS trust. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), https = require('node:https');
const axios = require('axios');
const { PcmIntrospectionClient } = require('../../ds-auth-adapter/src/pcm-introspection-client');
const { certificateConfirmation } = require('../../shared/assertion-keys');
const { buildEffectivePolicy, sourceSimulationControls } = require('../../shared/conformance-policy');
const { getConfiguredDataSources } = require('../src/data-sources');
const { CONTACT_EVIDENCE, OTP_PURPOSE, PURPOSE_SYSTEM } = require('../src/system-workflows');
const { normalizationConfiguration } = require('../../ds-auth-adapter/src/index');
const representative = { system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' };
const child = { resourceType: 'Patient', id: 'owned-dependent', identifier: [{ ...representative, value: '000000026' }], name: [{ text: 'Disposable dependent' }] };
const relationshipCode = { system: 'http://terminology.hl7.org/CodeSystem/v3-RoleCode', code: 'PRN' };
const bundle = resources => ({ resourceType: 'Bundle', type: 'searchset', total: resources.length, entry: resources.map(resource => ({ resource })) });

test('membership-free authentication contacts only selected custom HMO; all-HMO discovery uses real scoped tokens in every preset', async t => {
    const runtime = await require('../../../test-support/pcm-042-runtime').startRuntime();
    await require('../src/bootstrap')();
    const { loadTeamConfig, saveTeamConfig } = require('../src/team-config');
    const store = require('../src/fhir/store'), read = name => fs.readFileSync(path.join(process.env.CERTS_DIR, name));
    const captures = [], servers = [];
    t.after(async () => { for (const server of servers) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); await runtime.close(); });
    const patient = { resourceType: 'Patient', id: 'owned-representative', identifier: [representative], birthDate: '1980-01-02', telecom: [{ system: 'sms', value: '+972500000000', extension: [
        { url: OTP_PURPOSE, valueCodeableConcept: { coding: [{ system: PURPOSE_SYSTEM, code: 'OTP' }] } },
        { url: CONTACT_EVIDENCE, extension: [{ url: 'verifiedAt', valueDateTime: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() }] }
    ] }] };
    const related = { resourceType: 'RelatedPerson', id: 'owned-relationship', identifier: [representative], active: true,
        relationship: [{ coding: [relationshipCode] }], patient: { reference: `Patient/${child.id}` } };
    async function peer(certName, sourceId) {
        const server = https.createServer({ cert: read(`${certName}.crt`), key: read(`${certName}.key`), ca: read('rootCA.crt'), requestCert: true, rejectUnauthorized: true }, async (req, res) => {
            try {
                const config = loadTeamConfig(), source = getConfiguredDataSources(config).find(source => source.id === sourceId());
                assert.ok(source); const auth = source.pcmClientAuth;
                const agent = new https.Agent({ cert: read(auth.mtlsCert || auth.cert), key: read(auth.mtlsKey || auth.key), ca: read('rootCA.crt'), rejectUnauthorized: true });
                const policy = buildEffectivePolicy(config), id = source.healthOrganizationId || source.id;
                const client = new PcmIntrospectionClient({ http: axios, httpsAgent: agent, clientId: source.clientId, privateKey: read(auth.key),
                    tokenEndpoint: `${runtime.endpoints.oauthBase}/token`, introspectionEndpoint: `${runtime.endpoints.oauthBase}/introspect`,
                    introspectionRequestEndpoint: `${runtime.apiBase}/introspect`, expectedIssuer: runtime.endpoints.oauthBase, expectedAudience: source.endpoint,
                    hoId: id, authMode: 'direct', timeout: 5000, ...normalizationConfiguration(config, id, policy),
                    controls: sourceSimulationControls(policy, config, { resource: source.endpoint }) });
                let decision;
                try { decision = await client.introspect((req.headers.authorization || '').replace(/^Bearer /, '')); } finally { agent.destroy(); }
                assert.equal(decision.active, true);
                const scenario = decision.scenario || decision.kind;
                captures.push({ sourceId: source.id, method: req.method, scenario, path: req.url,
                    transport: certificateConfirmation(req.socket.getPeerCertificate().raw)['x5t#S256'] });
                if (req.headers['x-owned-revoke-policy'] === 'true') {
                    const contract = store.get('Contract', 'policy-patient-authentication'); store.update({ ...contract, status: 'revoked' });
                }
                res.setHeader('Content-Type', 'application/fhir+json');
                if (req.method === 'GET') res.end(JSON.stringify(bundle([patient])));
                else { for await (const chunk of req) { /* Consume only the bounded two-entry test batch. */ }
                    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'batch-response', entry: [
                        { response: { status: '200' }, resource: bundle([child]) }, { response: { status: '200' }, resource: bundle([related]) }
                    ] })); }
            } catch (error) { res.statusCode = 403; res.end(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: error.message }] })); }
        });
        servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        return `https://localhost:${server.address().port}/fhir`;
    }
    const builtinId = runtime.config.healthOrganizations[0].dataSourceOrganization.id;
    const builtinUrl = await peer('pcm-core', () => builtinId);
    let customId;
    const customUrl = await peer('untrusted-client', () => customId);
    const config = loadTeamConfig(); config.systemAuthorization.memberships = []; config.systemAuthorization.participatingHmos = [];
    config.systemAuthorization.discovery.eligibleRelationships = [relationshipCode];
    config.healthOrganizations[0].endpoint = builtinUrl;
    config.healthOrganizations[1].institutionType = 'hospital'; config.healthOrganizations[2].institutionType = 'other';
    store.update({ ...store.get('Endpoint', config.healthOrganizations[0].endpointId), address: builtinUrl });
    saveTeamConfig(config);
    const headers = { 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD, Accept: 'application/json', 'Content-Type': 'application/json' };
    const response = await fetch(`${config.publicBaseUrls.pcmUi}/admin/config/data-sources/add`, { method: 'POST', headers,
        body: JSON.stringify({ expectedRevision: loadTeamConfig().runtime.revision || 0, name: 'Owned custom HMO', endpoint: customUrl, institutionType: 'hmo', generateCertificate: true, serverTrustMode: 'custom-ca', serverTrustCaCert: 'untrustedCA.crt' }) });
    assert.equal(response.status, 201, 'normal authenticated custom-source registration'); customId = (await response.json()).dataSource.id;
    const settings = loadTeamConfig();
    const clockValues = { 'otp.expirySeconds': 45, 'otp.resendSeconds': 2, 'otp.maxAttempts': 3, 'otp.maxResends': 1,
        'otp.contactMaxAgeSeconds': 60, 'authentication.flowLifetimeSeconds': 90, 'authentication.authenticatedLifetimeSeconds': 40,
        'authentication.timeoutMilliseconds': 2000, 'discovery.timeoutMilliseconds': 5000, 'discovery.maxPagesPerSource': 3, 'discovery.maxRetries': 0 };
    const clockSave = await fetch(`${settings.publicBaseUrls.pcmUi}/admin/config/test-workflows`, { method: 'POST', headers,
        body: JSON.stringify({ expectedRevision: settings.runtime.revision || 0, ...clockValues }) });
    assert.equal(clockSave.status, 200, await clockSave.clone().text());
    Object.assign(runtime.config, loadTeamConfig());
    for (const preset of ['strict', 'connectathon-mtls', 'connectathon-balanced', 'connectathon-easy']) {
        runtime.preset(preset);
        const current = loadTeamConfig();
        const workflow = require('../src/system-workflow-runtime').systemWorkflows(current);
        const browser = `owned-custom-hmo-${preset}-browser-binding-32`; const start = captures.length;
        const started = await workflow.authenticate({ homeHmoId: customId, identifier: representative, birthDate: patient.birthDate, browserBinding: browser });
        assert.deepEqual(captures.slice(start).map(item => item.sourceId), [customId], preset);
        const delivery = workflow.transport.inspect(started.flowId); assert.ok(delivery);
        const captured = workflow.flows.browserFlow(started.flowId, browser);
        assert.equal(captured.expiresAt - captured.createdAt, 90); assert.equal(delivery.expiresAt, Math.min(captured.expiresAt, captured.lastSent + 45));
        workflow.verify(started.flowId, browser, delivery.code);
        const discovered = await workflow.discover(started.flowId, browser);
        assert.equal(discovered.status, 'complete', JSON.stringify({ preset, sources: discovered.sources }));
        assert.deepEqual(discovered.sources.map(item => item.sourceId), [builtinId, customId]);
        assert.equal(discovered.dependents.length, 1); assert.equal(discovered.dependents[0].sources.length, 2);
        const authThumb = certificateConfirmation(read(current.certificateRoles.authenticationOrchestrator.mtls.cert))['x5t#S256'];
        assert.equal(captures[start].transport, authThumb);
        workflow.flows.cancel(started.flowId);
    }
    const beforeCa = loadTeamConfig();
    const caWorkflow = require('../src/system-workflow-runtime').systemWorkflows(beforeCa);
    const caBrowser = 'owned-server-ca-change-invalidation-browser-binding';
    const caFlow = await caWorkflow.authenticate({ homeHmoId: customId, identifier: representative, birthDate: patient.birthDate, browserBinding: caBrowser });
    const oldCa = beforeCa.organizations.dataSources.find(source => source.id === customId).serverTrust.caCert;
    const oldBytes = read(oldCa);
    const uploaded = await fetch(`${beforeCa.publicBaseUrls.pcmUi}/admin/config/data-sources/${customId}/server-trust/ca`, { method: 'POST', headers,
        body: JSON.stringify({ expectedRevision: loadTeamConfig().runtime.revision || 0, serverTrustCa: read('untrustedCA.crt').toString() }) });
    assert.equal(uploaded.status, 200);
    const caSaved = loadTeamConfig().organizations.dataSources.find(source => source.id === customId).serverTrust.caCert;
    assert.notEqual(caSaved, oldCa); assert.deepEqual(read(oldCa), oldBytes);
    assert.equal(caWorkflow.flows.invocation(caFlow.flowId, beforeCa.oauthClients.authenticationOrchestrator.clientId), null);
    Object.assign(runtime.config, loadTeamConfig());
    runtime.preset('strict');
    let current = loadTeamConfig();
    let workflow = require('../src/system-workflow-runtime').systemWorkflows(current);
    const browser = 'owned-trust-failure-browser-binding-more-than-32';
    const started = await workflow.authenticate({ homeHmoId: builtinId, identifier: representative, birthDate: patient.birthDate, browserBinding: browser });
    workflow.verify(started.flowId, browser, workflow.transport.inspect(started.flowId).code);
    current.organizations.dataSources.find(source => source.id === customId).serverTrust.caCert = 'rootCA.crt';
    saveTeamConfig(current);
    workflow = require('../src/system-workflow-runtime').systemWorkflows(loadTeamConfig());
    const partial = await workflow.discover(started.flowId, browser);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.sources.find(source => source.sourceId === customId).state, 'unknown');
    assert.equal(partial.sources.find(source => source.sourceId === builtinId).state, 'complete');
    await assert.rejects(workflow.authenticate({ homeHmoId: customId, identifier: representative, birthDate: patient.birthDate, browserBinding: browser + '-other' }));
    workflow.flows.cancel(started.flowId);
    current = loadTeamConfig(); current.organizations.dataSources.find(source => source.id === customId).serverTrust.caCert = 'untrustedCA.crt'; saveTeamConfig(current);
    const previewResponse = await fetch(`${current.publicBaseUrls.pcmUi}/admin/workflow-sources/preview`, { headers });
    assert.equal(previewResponse.status, 200); const plan = await previewResponse.json();
    const apply = body => fetch(`${current.publicBaseUrls.pcmUi}/admin/workflow-sources/apply`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await apply({ expectedRevision: -1, versions: plan.versions, sources: plan.sources, sourceVersions: plan.sourceVersions, reviewDigest: plan.reviewDigest })).status, 409);
    assert.equal((await apply({ expectedRevision: plan.revision, versions: {}, sources: plan.sources })).status, 409);
    assert.equal((await apply({ expectedRevision: plan.revision, versions: plan.versions, sources: plan.sources, sourceVersions: plan.sourceVersions, reviewDigest: plan.reviewDigest })).status, 200);
    const configBefore = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
    const policiesBefore = store.getAll('Contract');
    const write = fs.writeFileSync; let injected = false;
    fs.writeFileSync = function(filename, ...args) {
        if (!injected && filename === process.env.TEAM_CONFIG_PATH + '.tmp') { injected = true; throw Error('owned publication fault'); }
        return write.call(this, filename, ...args);
    };
    const classify = () => fetch(`${current.publicBaseUrls.pcmUi}/admin/config/data-sources/${customId}/institution`, { method: 'POST', headers,
        body: JSON.stringify({ institutionType: 'other', expectedRevision: loadTeamConfig().runtime.revision }) });
    try { assert.equal((await classify()).status, 400); } finally { fs.writeFileSync = write; }
    assert.equal(injected, true); assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), configBefore); assert.deepEqual(store.getAll('Contract'), policiesBefore);
    const activeConfig = loadTeamConfig(), flows = require('../src/system-flow-store').getSystemFlowStore(activeConfig);
    const ownedBrowser = 'owned-policy-revocation-during-source-response-browser';
    const flowId = flows.begin({ homeHmoId: customId, identifier: representative, birthDate: patient.birthDate, browserBinding: ownedBrowser });
    const source = getConfiguredDataSources(activeConfig).find(source => source.id === customId);
    const request = require('../src/system-workflow-client').createSystemWorkflowClient({ config: activeConfig, flows, store, getConfig: loadTeamConfig });
    await assert.rejects(request(source, { scenario: 'patient-authentication', flowId, patients: [representative], method: 'GET',
        url: `${source.endpoint}/Patient?${new URLSearchParams({ identifier: `${representative.system}|${representative.value}`, _elements: 'identifier,name,telecom,birthDate' })}`,
        headers: { 'x-owned-revoke-policy': 'true' } }), /Contract is no longer available/);
    flows.cancel(flowId);
    const contract = store.get('Contract', 'policy-patient-authentication');
    assert.equal((await classify()).status, 400);
    assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), configBefore);
    assert.equal(store.get('Contract', contract.id).status, 'revoked');
    const backups = path.join(process.env.STATE_DIR, 'workflow-source-backups');
    assert.ok(fs.readdirSync(backups).length > 0);
    for (const filename of fs.readdirSync(backups)) assert.equal(fs.statSync(path.join(backups, filename)).mode & 0o777, 0o600);

});
