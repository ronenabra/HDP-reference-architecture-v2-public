const { signingAlgorithm, jwkThumbprint, certificateConfirmation } = require('../src/shared/assertion-keys');
'use strict';
/** Disposable native gateway/adapter/HAPI qualification; stdout contains outcomes, never credentials. */
const fs = require('fs'), path = require('path'), https = require('https'), crypto = require('crypto'), assert = require('assert/strict');
const jwt = require('jsonwebtoken');
const { URI, projectSample } = require('../src/shared/sandbox-patients');
const { contractAuthorizationDetails } = require('../src/shared/data-authorization-details');
const config = JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));
const certs = process.env.CERTS_DIR;
const read = name => fs.readFileSync(path.join(certs, name));
/** Bounded wire helper does not redirect or log tokens. */
function request(url, { role = 'serviceProvider', method = 'GET', form, body, token, headers = {}, transportRole = role } = {}) {
    const certificate = config.certificateRoles[transportRole];
    const encoded = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined;
    return new Promise((resolve, reject) => {
        const req = https.request(url, { ca: read(config.certificates.rootCaCert), cert: read(certificate.mtls.cert), key: read(certificate.mtls.key), timeout: 10000, method,
            headers: { Accept: 'application/fhir+json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(encoded ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/fhir+json' } : {}), ...headers } }, res => {
            let text = ''; res.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 128 * 1024) req.destroy(Error('Response bound')); });
            res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, bytes: Buffer.byteLength(text) }); });
        }); req.on('error', reject); req.on('timeout', () => req.destroy(Error('Deadline'))); req.end(encoded);
    });
}
/** Authenticate the requesting registered app using its ordinary assertion and transport roles. */
function grant(role, source) {
    const iat = Math.floor(Date.now() / 1000), clientId = config.organizations[role]?.clientId || config.oauthClients[role].clientId;
    const assertion = jwt.sign({ iss: clientId, sub: clientId, aud: `${config.contract.operational.oauthBase}/token`, iat, exp: iat + 120, jti: crypto.randomUUID(), cnf: certificateConfirmation(read(config.certificateRoles[role].mtls.cert)) }, read(config.certificateRoles[role].assertion.key), { algorithm: signingAlgorithm(read(config.certificateRoles[role].assertion.key)), header: { typ: 'JWT', kid: jwkThumbprint(read(config.certificateRoles[role].assertion.key)) } });
    return request(`${config.internalBaseUrls.pcmAuth}/token`, { role, method: 'POST', form: { grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion, scope: 'system/Patient.s', resource: source.endpoint, authorization_details: JSON.stringify(contractAuthorizationDetails('PCM-POLICY-SANDBOX-PATIENT-SAMPLE-001')) } });
}
async function main() {
    const preset = config.conformance.preset, results = { preset, clients: [], negatives: [], controls: config.securitySimulation.global };
    // Setup alone uses the approved private maintenance credential, never an app token.
    if (process.argv.includes('--seed')) {
        const bundle = require('../clinical-data/test/demo-patient-fixtures').patientFixture(100).bundle;
        const source = config.healthOrganizations[0];
        const imported = await request(source.clinicalData.privateFhirBaseUrl, { method: 'POST', body: bundle, headers: { 'X-PCM-Import-Credential': process.env.PCM_A_IMPORT_CREDENTIAL } });
        assert.equal(imported.status, 200, JSON.stringify(imported.json));
        const invalidRows = [
            { resourceType: 'Patient', id: 'sample-untagged', identifier: [{ system: require('../src/shared/sandbox-patients').SYSTEM, value: 'Ab123456-1234-5678-9012-000000000099' }], name: [{ text: 'No HTEST' }] },
            { resourceType: 'Patient', id: 'sample-ambiguous', identifier: ['000000000098', '000000000097'].map(suffix => ({ system: require('../src/shared/sandbox-patients').SYSTEM, value: `Ab123456-1234-5678-9012-${suffix}` })), meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }] } },
            { resourceType: 'Patient', id: 'sample-non-guid', identifier: [{ system: require('../src/shared/sandbox-patients').SYSTEM, value: 'not-a-guid' }], meta: { security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }] } }
        ];
        const invalidImport = await request(config.healthOrganizations[2].clinicalData.privateFhirBaseUrl, { method: 'POST', body: { resourceType: 'Bundle', type: 'transaction', entry: invalidRows.map(resource => ({ resource, request: { method: 'PUT', url: `Patient/${resource.id}` } })) }, headers: { 'X-PCM-Import-Credential': process.env.PCM_C_IMPORT_CREDENTIAL } });
        assert.equal(invalidImport.status, 200);
        results.invalidRows = 'HO C contains untagged, ambiguous and malformed GUID candidates; sampling returns zero';
        results.setup = 'Approved private maintenance transaction into disposable HO A and C only';
    }
    for (const role of ['serviceProvider', 'hospitalBServiceProvider']) for (const source of config.healthOrganizations) {
        const issued = await grant(role, source);
        if (preset === 'strict') { assert.equal(issued.status, 400, JSON.stringify(issued.json)); results.clients.push({ role, source: source.id, issuance: issued.status }); continue; }
        assert.equal(issued.status, 200, JSON.stringify(issued.json)); assert.equal(issued.json.scope, 'system/Patient.s'); assert.equal(issued.json.authorization_details[0].fhirContext.length, 2);
        assert.ok(!issued.json.access_token.startsWith('pcm-sampler-'));
        const token = issued.json.access_token;
        const loaded = await request(`${source.endpoint}${URI.slice(5)}`, { role, token });
        assert.equal(loaded.status, 200, `${role}/${source.id}: ${JSON.stringify(loaded.json)}`); const sample = projectSample(loaded.json);
        assert.equal(sample.patients.length, source.id === 'ho-a' ? 10 : 0); assert.equal(sample.rejected, 0);
        for (const entry of loaded.json.entry || []) assert.ok(Object.keys(entry.resource).every(key => ['resourceType', 'id', 'meta', 'identifier', 'name', 'birthDate'].includes(key)));
        results.clients.push({ role, source: source.id, issuance: issued.status, sourceStatus: loaded.status, rows: sample.patients.length, bytes: loaded.bytes, firstPageRequests: 1, effectiveScope: issued.json.scope });
        if (source.id === 'ho-a') {
            for (const uri of ['/fhir/Patient', `${URI}&_include=*`, `${URI}&_getpages=next`, URI.replace('_count=10', '_count=100'), URI.replace('identifier%2Cname', 'identifier%2Ctelecom'), '/fhir/Patient/1', '/fhir/Patient/_history', '/fhir/Observation']) {
                const denied = await request(`${source.endpoint.replace(/\/fhir$/, '')}${uri}`, { role, token }); assert.equal(denied.status, 401, `${preset} ${uri}: ${denied.status}`);
                results.negatives.push({ role, case: uri, status: denied.status });
            }
            const batch = await request(source.endpoint, { role, token, method: 'POST', body: { resourceType: 'Bundle', type: 'batch', entry: [] } }); assert.equal(batch.status, 401); results.negatives.push({ role, case: 'batch/write', status: batch.status });
            const wrongAudience = await request(`${config.healthOrganizations[1].endpoint}${URI.slice(5)}`, { role, token }); assert.equal(wrongAudience.status, 401); results.negatives.push({ role, case: 'wrong audience', status: wrongAudience.status });
            if (config.securitySimulation.global.publicClientMtls) {
                const swapped = await request(`${source.endpoint}${URI.slice(5)}`, { role, token, transportRole: role === 'serviceProvider' ? 'hospitalBServiceProvider' : 'serviceProvider' }); assert.equal(swapped.status, 401); results.negatives.push({ role, case: 'swapped application certificate', status: swapped.status });
            }
        }
    }
    const unentitled = await grant('presenceOrchestrator', config.healthOrganizations[0]); assert.equal(unentitled.status, 400); results.negatives.push({ case: 'unentitled registered system-workflow client', status: unentitled.status });
    const retired = await request(`${config.internalBaseUrls.pcmAuth}/token`, { method: 'POST', form: { grant_type: 'client_credentials', scope: 'system/Patient.s', resource: config.healthOrganizations[0].endpoint, client_assertion: 'pcm-sampler-retired' } }); assert.equal(retired.status, 400); results.negatives.push({ case: 'retired credential not OAuth', status: retired.status });
    console.log(JSON.stringify(results));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
