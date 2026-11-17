'use strict';

/** Real disposable HTTPS regression for the shared OAuth certificate-role boundary. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const express = require('express');
const { jwkThumbprint } = require('../../shared/assertion-keys');
const { certToX5tS256 } = require('../src/crypto');
const { certificates } = require('../../../test-support/certificates');

/** Submit a fresh signed assertion using the selected actual TLS credential. */
function post(server, certs, client, transport, endpoint, extra = {}, cnf) {
    const material = name => fs.readFileSync(path.join(certs, name));
    const key = material(client.key);
    const assertion = jwt.sign({ iss: client.clientId, sub: client.clientId,
        aud: `${client.issuer}${endpoint}`, jti: crypto.randomUUID(), ...(cnf ? { cnf } : {}) }, key,
    { algorithm: client.algorithm, expiresIn: 120, header: { typ: 'JWT', kid: jwkThumbprint(key) } });
    const body = new URLSearchParams({ client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion, ...extra }).toString();
    return new Promise((resolve, reject) => {
        const request = https.request({ hostname: 'localhost', port: server.address().port,
            path: endpoint, method: 'POST', agent: false, ca: material('rootCA.crt'),
            ...(transport ? { cert: material(`${transport}.crt`), key: material(`${transport}.key`) } : {}),
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, response => {
            let text = '';
            response.on('data', chunk => { text += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
        });
        request.on('error', reject); request.end(body);
    });
}

test('strict real HTTPS accepts shared ES256 and separate ES384 roles and rejects mixed clients before issuing', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-role-https-'));
    const certs = path.join(directory, 'certs');
    fs.cpSync(certificates(), certs, { recursive: true });
    const previous = { ...process.env };
    let server;
    try {
        const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../pcm-connectathon/example-team-config.json')));
        config.conformance = { mode: 'strict', preset: 'strict', policyVersion: 'pcm-sandbox-policy/4', compatibilityAdapters: [] };
        config.security.pcmApi.clientAuth = 'mtls';
        config.security.dataSourceGateway.clientAuth = 'mtls';
        config.security.serviceProviderToDataSource.verifyServerCertificate = true;
        config.security.dsGatewayToFhirServer.verifyServerCertificate = true;
        config.security.dsFhirServer.enforceMappedPatients = true;
        config.securitySimulation.global = {}; config.securitySimulation.perSource = {};
        config.legacyDataSource.enabled = false;
        config.certificateRoles.serviceProvider.mtls = config.certificateRoles.serviceProvider.assertion;
        // Exercise the generated Hospital B profile without substituting the optional primary rollover key.
        const issuer = config.contract.operational.oauthBase;
        Object.assign(process.env, { TEAM_CONFIG_PATH: path.join(directory, 'team.json'), CERTS_DIR: certs,
            LOG_DIR: path.join(directory, 'logs'), STATE_DIR: path.join(directory, 'state'), PCM_CONFORMANCE_MODE: 'strict', PCM_ISSUER: issuer });
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
        const store = require('../src/fhir/store'); store.clear();
        const clinical = require('../../../test-support/data-grants').dataGrantFixture({ now: Math.floor(Date.now() / 1000) - 10 });
        // A public-resource copy cannot restore private approval authority.
        const checkpoint = require('../src/migration-checkpoint');
        checkpoint.hydrate(store, checkpoint.snapshot(clinical.store, { privateState: true }), { rollback: true });
        const organization = (id, role, parent) => ({ resourceType: 'Organization', id, active: true,
            identifier: [{ use: 'official', system: 'http://pcm.fhir.health.gov.il/identifier/pcm-organization-id', value: `ROLE-${id}` }],
            type: [{ coding: [{ system: 'http://pcm.fhir.health.gov.il/cs/pcm-org-type', code: role }] }],
            ...(parent ? { partOf: { reference: `Organization/${parent}` } } : {}) });
        store.add(organization('role-parent', 'parent-org'));
        for (const role of ['serviceProvider', 'hospitalBServiceProvider']) store.add(organization(config.organizations[role].id, 'service-provider', 'role-parent'));
        const source = config.healthOrganizations[0];
        store.add({ ...organization(source.dataSourceOrganization.id, 'source', 'role-parent'), endpoint: [{ reference: 'Endpoint/role-source' }] });
        store.add({ resourceType: 'Endpoint', id: 'role-source', status: 'active', address: source.endpoint,
            managingOrganization: { reference: `Organization/${source.dataSourceOrganization.id}` } });
        const app = express(); app.use(express.urlencoded({ extended: false })); app.use(require('../src/routes/auth'));
        server = https.createServer({ cert: fs.readFileSync(path.join(certs, 'pcm-core.crt')),
            key: fs.readFileSync(path.join(certs, 'pcm-core.key')), ca: fs.readFileSync(path.join(certs, 'rootCA.crt')),
            requestCert: true, rejectUnauthorized: false }, app);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const primary = { clientId: config.organizations.serviceProvider.clientId, issuer, key: 'sp-client-assertion.key', algorithm: 'ES256' };
        const secondary = { clientId: config.organizations.hospitalBServiceProvider.clientId, issuer, key: 'hospital-b-sp-assertion.key', algorithm: 'ES384' };
        const ds = { clientId: source.clientId, issuer, key: 'ho-a-gateway-assertion.key', algorithm: 'ES256' };
        const body = { grant_type: 'client_credentials', scope: 'system/*.crus', resource: issuer };
        const tokens = require('../src/store').tokenStore;
        async function clinicalRoundTrip(preset, transport = 'sp-client-assertion') {
            const requested = require('../../../test-support/data-grants').rar('Consent', clinical.consent.identifier[0].value).details;
            const issued = await post(server, certs, primary, transport, '/token', { ...body, resource: source.endpoint,
                scope: clinical.request.scope, authorization_details: JSON.stringify(requested) });
            assert.equal(issued.status, 200, JSON.stringify(issued));
            const beforeInspection = JSON.stringify(tokens.peek(issued.body.access_token));
            const own = await post(server, certs, primary, 'sp-client-assertion', '/introspect', { token: issued.body.access_token });
            if (preset === 'strict') assert.equal(own.status, 403);
            else {
                assert.equal(own.status, 200); assert.equal(own.body.active, true, JSON.stringify(own));
                assert.equal(own.body.scope, issued.body.scope);
                assert.deepEqual(own.body.authorization_details, issued.body.authorization_details);
                assert.equal(own.body.aud, source.endpoint);
                assert.equal(own.body.iss, issuer);
                const foreign = await post(server, certs, secondary, 'hospital-b-sp', '/introspect', { token: issued.body.access_token });
                assert.deepEqual(foreign, { status: 200, body: { active: false } });
                const disabled = structuredClone(config);
                disabled.security.pcmApi.allowServiceProviderOwnTokenIntrospection = false;
                require('../src/team-config').saveTeamConfig(disabled);
                const refused = await post(server, certs, primary, 'sp-client-assertion', '/introspect', { token: issued.body.access_token });
                assert.equal(refused.status, 403);
                require('../src/team-config').saveTeamConfig(config);
                for (const transportRole of [null, 'hospital-b-sp']) {
                    const denied = await post(server, certs, primary, transportRole, '/introspect', { token: issued.body.access_token });
                    assert.equal(denied.status, 401, `${preset}: missing/foreign transport`);
                }
                const wrongAudience = await post(server, certs, { ...primary, issuer: issuer + '/wrong' }, 'sp-client-assertion', '/introspect', { token: issued.body.access_token });
                assert.equal(wrongAudience.status, 401);
                const forged = await post(server, certs, primary, 'sp-client-assertion', '/introspect', { token: issued.body.access_token, client_assertion: 'invalid-signature' });
                assert.equal(forged.status, 401);
            }
            assert.equal(JSON.stringify(tokens.peek(issued.body.access_token)), beforeInspection, 'SP never changes an issued token');
            const logger = require('../src/logger'), originalInfo = logger.info;
            let decision;
            logger.info = (message, details) => { if (details?.type === 'INTROSPECTION_DECISION') decision = details.reason; originalInfo(message, details); };
            let inspected;
            try { inspected = await post(server, certs, ds, 'ho-a-gateway-mtls', '/introspect', { token: issued.body.access_token }); }
            finally { logger.info = originalInfo; }
            assert.equal(inspected.status, 200); assert.equal(inspected.body.active, true, JSON.stringify({ preset, decision }));
            const retained = tokens.get(issued.body.access_token).pcm_authentication_context;
            assert.deepEqual(inspected.body.pcm_authentication_context, retained);
            const policy = require('../src/team-config').getEffectiveConformancePolicy();
            const normalization = require('../../ds-auth-adapter/src/index').normalizationConfiguration(config, source.id);
            const normalized = require('../../ds-auth-adapter/src/introspection-contract').validateIntrospectionResponse(inspected.body, {
                ...normalization, expectedIssuer: issuer, expectedAudience: source.endpoint, hoId: source.id,
                controls: policy.simulation.perSource[source.id] || policy.simulation.controls
            });
            assert.equal(normalized.authentication.correlationVerified, retained.correlation_verified);
            if (preset === 'connectathon-easy' || !transport) {
                assert.equal(retained.correlation_verified, false);
                assert.equal(retained.client_assertion_signing, preset === 'connectathon-easy' ? null : retained.client_assertion_signing);
            } else assert.equal(retained.correlation_verified, true);
            if (!transport) assert.equal(retained.token_endpoint_mtls, null);
            return { token: issued.body.access_token, evidence: retained };
        }
        await clinicalRoundTrip('strict');

        for (const [client, transport, signing] of [[primary, 'sp-client-assertion', 'sp-client-assertion'], [secondary, 'hospital-b-sp', 'hospital-b-sp-assertion']]) {
            const thumbprint = certToX5tS256(fs.readFileSync(path.join(certs, `${transport}.crt`)));
            for (const cnf of [undefined, { 'x5t#S256': thumbprint }]) {
                const accepted = await post(server, certs, client, transport, '/token', body, cnf);
                assert.equal(accepted.status, 200, JSON.stringify(accepted));
                const evidence = tokens.get(accepted.body.access_token).pcm_authentication_context;
                assert.equal(evidence.correlation_verified, true);
                assert.equal(evidence.token_endpoint_mtls['x5t#S256'], thumbprint);
                assert.equal(evidence.client_assertion_signing['x5t#S256'], certToX5tS256(fs.readFileSync(path.join(certs, `${signing}.crt`))));
            }
        }
        for (const cnf of [undefined, { 'x5t#S256': certToX5tS256(fs.readFileSync(path.join(certs, 'hospital-b-sp.crt'))) }]) {
            const rar = JSON.stringify(require('../../../test-support/data-grants').rar('Consent', 'ROLE-CONSENT').details);
            for (const grant of [body,
                { ...body, resource: source.endpoint, scope: 'patient/Observation.rs', authorization_details: rar },
                { grant_type: 'authorization_code', code: 'unused-code', redirect_uri: config.organizations.serviceProvider.redirectUri,
                    code_verifier: 'A'.repeat(43) }]) {
                const denied = await post(server, certs, primary, 'hospital-b-sp', '/token', grant, cnf);
                assert.equal(denied.status, 401); assert.equal(denied.body.error, 'invalid_client');
                assert.equal(denied.body.access_token, undefined);
            }
            for (const endpoint of ['/token', '/introspect']) {
                const request = endpoint === '/token' ? { ...body, resource: `${issuer}/introspect` } : { token: 'unknown' };
                const denied = await post(server, certs, ds, 'hospital-b-sp', endpoint, request, cnf);
                assert.equal(denied.status, 401); assert.equal(denied.body.error, 'invalid_client');
            }
        }
        const validSource = await post(server, certs, ds, 'ho-a-gateway-mtls', '/introspect', { token: 'unknown' });
        assert.deepEqual(validSource, { status: 200, body: { active: false } });
        for (const transport of [null, 'untrusted-client']) {
            const denied = await post(server, certs, primary, transport, '/token', body);
            assert.equal(denied.status, 401); assert.equal(denied.body.access_token, undefined);
        }
        // Source publicClientMtls/signature overrides never waive PCM role ownership.
        // This matrix tests rejection, not no-certificate simulation acceptance.
        let simulatedSubject;
        for (const preset of ['connectathon-mtls', 'connectathon-balanced', 'connectathon-easy']) {
            const selected = require('../../../test-support/team-config').buildTeamConfig({}, preset);
            for (const field of ['conformance', 'security', 'securitySimulation', 'legacyDataSource']) config[field] = selected[field];
            process.env.PCM_CONFORMANCE_MODE = 'connectathon';
            require('../src/team-config').saveTeamConfig(config);
            for (const [client, transport] of [[primary, 'sp-client-assertion'], [secondary, 'hospital-b-sp']]) {
                const confirmed = { 'x5t#S256': certToX5tS256(fs.readFileSync(path.join(certs, `${transport}.crt`))) };
                const issued = await post(server, certs, client, transport, '/token', body, confirmed);
                assert.equal(issued.status, 200, preset);
            }
            await clinicalRoundTrip(preset);
            if (preset !== 'connectathon-mtls') simulatedSubject = await clinicalRoundTrip(preset, null);
            const foreign = { 'x5t#S256': certToX5tS256(fs.readFileSync(path.join(certs, 'hospital-b-sp.crt'))) };
            for (const cnf of [undefined, foreign]) {
                const denied = await post(server, certs, primary, 'hospital-b-sp', '/token', body, cnf);
                assert.equal(denied.status, 401, preset); assert.equal(denied.body.error, 'invalid_client');
                const invalidSource = await post(server, certs, ds, 'hospital-b-sp', '/introspect', { token: 'unknown' }, cnf);
                assert.equal(invalidSource.status, 401, preset);
            }
            const mismatch = await post(server, certs, primary, 'sp-client-assertion', '/token', body, foreign);
            assert.equal(mismatch.status, 401, preset);
            assert.match(mismatch.body.error_description, /cnf/);
        }
        const tightened = require('../../../test-support/team-config').buildTeamConfig({}, 'strict');
        for (const field of ['conformance', 'security', 'securitySimulation', 'legacyDataSource']) config[field] = tightened[field];
        process.env.PCM_CONFORMANCE_MODE = 'strict';
        require('../src/team-config').saveTeamConfig(config);
        const deniedSimulation = await post(server, certs, ds, 'ho-a-gateway-mtls', '/introspect', { token: simulatedSubject.token });
        assert.deepEqual(deniedSimulation, { status: 200, body: { active: false } });

        // Regress the retained renewal helper's credential/token consequences with
        // real OAuth requests. This does not claim a new Compose recreation run.
        const identities = value => JSON.stringify({ organizations: Object.entries(value.organizations).filter(([, item]) => item?.clientId).map(([role, item]) => [role, item.id, item.clientId]),
            sources: value.healthOrganizations.map(item => [item.id, item.clientId, item.dataSourceOrganization.id]), clients: value.oauthClients });
        const originalIdentities = identities(config), rootBefore = fs.readFileSync(path.join(certs, 'rootCA.crt'));
        for (const rotateKeys of [false, true]) {
            const issued = await clinicalRoundTrip('strict');
            const prepared = require('../../shared/certificate-renewal').prepareRenewal(config, certs, { rotateKeys });
            assert.equal(identities(prepared.config), originalIdentities);
            for (const entry of prepared.entries) assert.equal(entry.oldKid === entry.newKid, !rotateKeys);
            require('../../shared/role-credentials').publishFiles(certs, prepared.material);
            require('../src/team-config').saveTeamConfig(prepared.config); Object.assign(config, prepared.config);
            assert.deepEqual(fs.readFileSync(path.join(certs, 'rootCA.crt')), rootBefore);
            const staleToken = await post(server, certs, ds, 'ho-a-gateway-mtls', '/introspect', { token: issued.token });
            assert.deepEqual(staleToken, { status: 200, body: { active: false } });
            await clinicalRoundTrip('strict');
            const secondaryIssued = await post(server, certs, secondary, 'hospital-b-sp', '/token', body);
            assert.equal(secondaryIssued.status, 200, 'separate ES384 application authenticates with its own renewed roles');
        }

    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
        Object.assign(process.env, previous);
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
