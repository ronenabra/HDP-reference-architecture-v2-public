const { signingAlgorithm, jwkThumbprint, certificateConfirmation } = require('../src/shared/assertion-keys');
'use strict';
/** Disposable real PCM HTTPS/OAuth/private-UI qualification, with no source-data mutation. */
const fs = require('node:fs'), path = require('node:path'), https = require('node:https'), http = require('node:http');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const base = path.join(root, 'tmp/pcm-consent-ui-01/teams/consent-ui-qualification');
const presets = ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict'];

/** Run the real PCM listeners and perform ordinary OAuth plus version-bound UI requests. */
async function worker(preset) {
    const original = JSON.parse(fs.readFileSync(path.join(base, 'team-config.json')));
    const { planReconfiguration } = require('../pcm-connectathon/scripts/reconfigure-local-team');
    const config = planReconfiguration(original, 'TEAM_ADMIN_PASSWORD=qualification-only\n', preset).config;
    config.runtime.stateDir = path.join(base, 'state', preset); config.runtime.certsDir = path.join(base, 'certs');
    process.env.TEAM_CONFIG_PATH = path.join(base, `config-${preset}.json`);
    process.env.CERTS_DIR = config.runtime.certsDir; process.env.STATE_DIR = config.runtime.stateDir;
    process.env.LOG_DIR = path.join(base, 'logs', preset); process.env.SHARED_LOGS_DIR = path.join(base, 'logs');
    process.env.TEAM_ADMIN_PASSWORD = 'qualification-only';
    // Catalog is copied by the maintained team generator; use the exact selected file.
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
    const { createApiApp, createUiApp } = require('../src/pcm-core/src/index');
    const { saveTeamConfig } = require('../src/pcm-core/src/team-config');
    await require('../src/pcm-core/src/bootstrap')();
    const api = https.createServer(require('../src/pcm-core/src/api-server-manager').readHttpsOptions(process.env.CERTS_DIR, config.security.pcmApi.clientAuth), createApiApp());
    const ui = http.createServer(createUiApp());
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve)); await new Promise(resolve => ui.listen(0, '127.0.0.1', resolve));
    const apiBase = `https://127.0.0.1:${api.address().port}/api/fhir-service/r4`, uiBase = `http://127.0.0.1:${ui.address().port}`;
    config.internalBaseUrls.pcmAuth = apiBase; config.internalBaseUrls.pcmFhir = apiBase;
    config.publicBaseUrls.pcmApi = apiBase; config.publicBaseUrls.pcmUi = uiBase;
    saveTeamConfig(config);
    const role = participant => participant === 'ho-a' ? { mtls: { cert: config.healthOrganizations[0].certificates.gatewayMtlsCert, key: config.healthOrganizations[0].certificates.gatewayMtlsKey }, assertion: { key: config.healthOrganizations[0].certificates.gatewayAssertionKey } } : config.certificateRoles[participant];
    const read = name => fs.readFileSync(path.join(process.env.CERTS_DIR, name));
    const clientId = participant => participant === 'ho-a' ? config.healthOrganizations[0].clientId : config.organizations[participant].clientId;
    /** Bound network helper keeps credentials private and records only outcome summaries. */
    function request(url, { participant = 'serviceProvider', method = 'GET', body, form, token, headers = {} } = {}) {
        const encoded = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined;
        const tls = url.startsWith('https:') ? { ca: read(config.certificates.rootCaCert), cert: read(role(participant).mtls.cert), key: read(role(participant).mtls.key) } : {};
        return new Promise((resolve, reject) => {
            const req = (url.startsWith('https:') ? https : http).request(url, { ...tls, method, family: 4, timeout: 10000, headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(encoded ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}), ...headers
            } }, response => {
                let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: response.statusCode, json, text }); });
            }); req.on('error', reject); req.on('timeout', () => req.destroy(Error('Request deadline'))); req.end(encoded);
        });
    }
    const jwt = require('jsonwebtoken'), crypto = require('node:crypto');
    const assertion = (participant, audience) => { const iat = Math.floor(Date.now() / 1000); return jwt.sign({ iss: clientId(participant), sub: clientId(participant), aud: audience, iat, exp: iat + 120, jti: crypto.randomUUID(), cnf: certificateConfirmation(read(role(participant).mtls.cert)) }, read(role(participant).assertion.key), { algorithm: signingAlgorithm(read(role(participant).assertion.key)), header: { typ: 'JWT', kid: jwkThumbprint(read(role(participant).assertion.key)) } }); };
    const token = (participant, resource, scope, details) => request(`${apiBase}/token`, { participant, method: 'POST', form: { grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion(participant, `${config.contract.operational.oauthBase}/token`), resource, scope, ...(details ? { authorization_details: JSON.stringify(details) } : {}) } });
    try {
        const management = await token('serviceProvider', config.contract.operational.fhirBase, 'system/*.crus'); assert.equal(management.status, 200, JSON.stringify(management.json));
        const input = JSON.parse(fs.readFileSync(path.join(root, 'docs/FHIR-examples/Consent-consent-request-hosp-a-cross-org-summary.json')));
        delete input.id; input.patient.identifier = { system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' };
        input.extension.find(item => item.url.endsWith('/ext-pcm-service')).valueReference.reference = `HealthcareService/${config.service.id}`;
        const created = await request(`${apiBase}/Consent`, { method: 'POST', body: input, token: management.json.access_token }); assert.equal(created.status, 201, JSON.stringify(created.json));
        const consent = created.json;
        console.log(JSON.stringify({ preset, consentStatus: consent.status, period: consent.provision.period, service: consent.extension, sourceActors: consent.provision.actor }));
        const details = [{ type: 'https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access', fhirContext: [{ type: 'Consent', role: 'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-basis', identifier: consent.identifier[0] }] }];
        // RAR accepts the closed identifier pair, not the FHIR identifier.use field.
        details[0].fhirContext[0].identifier = { system: consent.identifier[0].system, value: consent.identifier[0].value };
        // Catalog approval windows have millisecond precision; allow the first NumericDate second to complete.
        await new Promise(resolve => setTimeout(resolve, 1100));
        const sourceGrant = await token('serviceProvider', config.healthOrganizations[0].endpoint, 'patient/Observation.rs', details); assert.equal(sourceGrant.status, 200, JSON.stringify(sourceGrant.json));
        const introspector = await token('ho-a', `${config.contract.operational.oauthBase}/introspect`, 'system/*.crus'); assert.equal(introspector.status, 200, JSON.stringify(introspector.json));
        const inspect = () => request(`${apiBase}/introspect`, { participant: 'ho-a', method: 'POST', token: introspector.json.access_token, form: { token: sourceGrant.json.access_token } });
        const before = await inspect(); assert.equal(before.json.active, true, JSON.stringify(before.json));
        const page = await request(`${uiBase}/ui/approve/${consent.id}`); assert.equal(page.status, 200);
        const form = page.text.match(/<form data-consent-cancellation[\s\S]*?<\/form>/)[0];
        const command = Object.fromEntries(['expectedVersion', 'providerRole', 'csrf'].map(name => [name, form.match(new RegExp(`name="${name}" value="([^"]*)"`))[1]]));
        const cancel = () => request(`${uiBase}/admin/consents/${consent.id}/cancel`, { method: 'POST', body: command, headers: { Accept: 'application/json', 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD, Origin: uiBase } });
        const changed = await cancel(); assert.equal(changed.status, 200, JSON.stringify(changed.json)); assert.equal(changed.json.status.code, 'service-provider-cancelled');
        const after = await inspect(); assert.equal(after.json.active, false, JSON.stringify(after.json));
        const denied = await token('serviceProvider', config.healthOrganizations[0].endpoint, 'patient/Observation.rs', details); assert.equal(denied.status, 400);
        const conflict = await cancel(); assert.equal(conflict.status, 409);
        const refreshed = await request(`${uiBase}/ui/approve/${consent.id}`); assert.match(refreshed.text, /Service Provider cancelled/); assert.match(refreshed.text, /team-admin acting as/);
        return { preset, tokenBefore: sourceGrant.status, introspectionBefore: before.json.active, cancellation: changed.status, introspectionAfter: after.json.active, newIssuanceAfter: denied.status, staleCommand: conflict.status, limits: 'Actual PCM HTTPS/OAuth/UI listeners; no HO data request or clinical mutation' };
    } finally { api.closeAllConnections(); ui.closeAllConnections(); await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => ui.close(resolve))]); }
}
if (process.argv[2] === 'worker') worker(process.argv[3]).then(result => { console.log(JSON.stringify(result)); }).catch(error => { console.error(error.stack); process.exitCode = 1; });
else {
    const results = presets.map(preset => { const run = spawnSync(process.execPath, [__filename, 'worker', preset], { cwd: root, encoding: 'utf8', timeout: 120000 }); fs.writeFileSync(path.join(root, `tmp/pcm-consent-ui-01/${preset}.log`), run.stdout + run.stderr); return { preset, exitCode: run.status, output: run.stdout.trim().split('\n').at(-1), ...(run.status ? { error: run.stderr.slice(-3000) } : {}) }; });
    fs.writeFileSync(path.join(root, 'tmp/pcm-consent-ui-01/runtime-results.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results, null, 2)); if (results.some(result => result.exitCode !== 0)) process.exitCode = 1;
}
