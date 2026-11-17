'use strict';
/** Actual consumer bodies with controlled network/client boundaries, never a runtime qualification claim. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), { EventEmitter } = require('node:events'), jwt = require('jsonwebtoken');
const { createRequire } = require('node:module');
const { buildTeamConfig } = require('../../test-support/team-config');

/** Execute the real HTTPS request/token/runHo/main code against a finite transport seam. */
async function executeGateway(preset, options = {}) {
    const config = buildTeamConfig({}, preset), key = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    config.legacyDataSource.enabled = preset !== 'strict';
    config.legacyDataSource.internalFhirBaseUrl = 'https://legacy-ds-gateway:8080/fhir';
    const requests = [], tokens = new Map(), assertions = new Set(), writes = []; let serial = 0;
    const respond = (url, settings, payload) => {
        const target = new URL(url), method = settings.method || 'GET', bearer = settings.headers.Authorization?.slice(7), own = tokens.get(bearer);
        const result = (status, body) => ({ status, body, text: typeof body === 'string' ? body : JSON.stringify(body) });
        if (target.pathname.endsWith('/token')) {
            const form = new URLSearchParams(payload), scope = form.get('scope'), resource = form.get('resource');
            requests.push({ kind: 'token', scope, resource });
            if (scope.startsWith('patient/')) return result(400, { error: 'unauthorized_client' });
            let claims; try { claims = jwt.verify(form.get('client_assertion'), key.publicKey, { algorithms: ['ES256'], audience: config.contract.operational.oauthBase + '/token' }); } catch (_) { return result(401, { error: 'invalid_client' }); }
            if (assertions.has(claims.jti)) return result(401, { error: 'invalid_client' }); assertions.add(claims.jti);
            const patients = JSON.parse(form.get('authorization_details'))[0].fhirContext.filter(row => row.type === 'Patient').map(row => row.identifier);
            const token = 'unit-opaque-' + ++serial; tokens.set(token, { resource, patients, expires: Date.now() + 1000 });
            return result(200, { token_type: 'Bearer', access_token: token, expires_in: 1 });
        }
        requests.push({ kind: 'gateway', source: target.hostname, method, path: target.pathname + target.search, authenticated: Boolean(bearer) });
        if (target.pathname === '/healthz') return result(200, { status: 'ok', service: 'ds-gateway' });
        if (!own) return result(options.anonymous200 ? 200 : 401, options.anonymous200 ? { resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Observation' } }] } : options.anonymousResource ? { resourceType: 'Observation', id: 'forbidden' } : 'Missing Local Token');
        if (own.expires <= Date.now() || new URL(own.resource).hostname !== target.hostname) return result(403, options.foreignClinical403 && target.hostname === 'legacy-ds-gateway' ? { resourceType: 'Patient', id: 'forbidden' } : 'Invalid Local Token');
        if (target.hostname === 'legacy-ds-gateway') {
            if (options.legacyStatus === 404) return result(404, { error: 'not found' });
            if (options.legacyAuth403) return result(403, 'Invalid Local Token');
            return result(403, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: options.wrongCapabilityCode ? 'security' : 'not-supported', diagnostics: 'Legacy Node clinical access is unavailable: this source cannot enforce approved SMART predicates. Select a qualified native HAPI source.' }] });
        }
        const permitted = identifier => own.patients.some(row => `${row.system}|${row.value}` === identifier);
        if (method === 'POST' && target.pathname === '/fhir') {
            const body = JSON.parse(payload);
            if (payload.length > config.presence.batch.maxPayloadBytes) return result(413, { error: 'too large' });
            if (body.type !== 'batch') return result(403, { error: 'denied' });
            return result(200, { resourceType: 'Bundle', type: 'batch-response', entry: body.entry.map(row => {
                const query = new URL(row.request.url, 'https://unit/').searchParams;
                return { response: { status: permitted(query.get('identifier')) ? '200' : '403' }, resource: { resourceType: 'Bundle', total: 1, entry: [] } };
            }) });
        }
        if (method !== 'GET' || target.pathname !== '/fhir/Patient' || target.searchParams.has('name') || !permitted(target.searchParams.get('identifier'))) return result(403, { error: 'denied' });
        return result(200, { resourceType: 'Bundle', type: 'searchset', total: target.searchParams.get('identifier').endsWith('|000000026') ? 0 : 1, entry: [] });
    };
    const https = { request(url, settings, callback) {
        const req = new EventEmitter(); let payload = ''; req.write = value => { payload += value; };
        req.end = () => queueMicrotask(() => {
            try { const reply = respond(url, settings, payload), response = new EventEmitter(); response.statusCode = reply.status; callback(response); response.emit('data', Buffer.from(reply.text)); response.emit('end'); }
            catch (error) { req.emit('error', error); }
        }); return req;
    } };
    const filename = path.resolve(__dirname, options.source || 'gateway-presence-matrix.js'), native = createRequire(filename), module = { exports: {} };
    let source = fs.readFileSync(filename, 'utf8');
    // Old consumer has an unconditional entry call; expose that same main body for red reproduction only.
    if (!source.includes('require.main === module')) source = source.replace(/main\(\)\.catch\([\s\S]*$/, 'module.exports = { main };');
    const load = name => name === './gateway-presence-contract' ? (() => {
        // Both actual modules share the same realm, as they do in ordinary Node execution.
        const helper = { exports: {} };
        vm.runInContext('(function(module, require) {' + fs.readFileSync(path.join(__dirname, 'gateway-presence-contract.js'), 'utf8') + '\n})', context)(helper, native);
        return helper.exports;
    })() : name === 'https' || name === 'node:https' ? https : name === 'node:fs' || name === 'fs' ? {
        readFileSync(file) { return String(file).includes('team-config') ? JSON.stringify(config) : key.privateKey.export({ type: 'pkcs8', format: 'pem' }); },
        writeFileSync(file, value) { writes.push(JSON.parse(value)); }
    } : native(name);
    load.main = null;
    const context = { require: load, module, process: { env: { TEAM_CONFIG_PATH: '/unit/team-config.json', PCM_MATRIX_OUTPUT: '/unit/result.json' } }, console: { log() {}, error() {} }, Buffer, URL, URLSearchParams, setTimeout, clearTimeout, queueMicrotask };
    vm.runInNewContext(source, context, { filename }); await module.exports.main();
    return { config, requests, output: writes.at(-1) };
}

/** Execute the real catalog main with ordinary client calls and narrowly shaped response fixtures. */
async function executeCatalog(preset, damage) {
    const config = buildTeamConfig({}, preset), catalog = require('../../config/demo-services.json');
    const definitions = catalog.clinicalServices.filter(row => !row.sandboxFullAccess), requests = [], writes = [];
    config.serviceCatalog = { bindings: definitions.map(row => ({ application: 'doctor', serviceKey: row.key, instanceId: 'unit-' + row.key })) };
    const client = {
        async createConsentRequest(patient, service, identity) { requests.push({ patient, service, identity }); return { id: 'unit-new-' + requests.length, status: 'active' }; },
        async fetchData(id, source, identity, scope) {
            const types = [...new Set(scope.split(' ').map(row => row.split('/')[1].split('.')[0]))].filter(type => type !== 'Observation');
            const entries = types.map(resourceType => ({ resource: { resourceType, identifier: [{ system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: damage === 'wrong-patient' ? '2' : '1' }] } }));
            if (damage === 'leak' && scope.includes('patient/Observation.')) entries.push({ resource: { resourceType: 'Observation' } });
            if (damage === 'two-patients') entries.push(entries.find(row => row.resource.resourceType === 'Patient'));
            return { resourceType: 'Bundle', entry: entries };
        }
    };
    const filename = path.resolve(__dirname, 'demo-catalog-matrix.js'), native = createRequire(filename), module = { exports: {} };
    let source = fs.readFileSync(filename, 'utf8'); if (!source.includes('require.main === module')) source = source.replace(/main\(\)\.catch\([\s\S]*$/, 'module.exports = { main };');
    const load = name => name === '/app/src/client' ? client : name === 'fs' ? { readFileSync: () => JSON.stringify(config), writeFileSync: (_name, value) => writes.push(JSON.parse(value)) }
        : name === '/shared/service-catalog' ? { loadServiceCatalog: () => catalog, catalogScope: native('../../src/shared/service-catalog').catalogScope } : native(name);
    load.main = null; vm.runInNewContext(source, { require: load, module, process: { env: { PCM_MATRIX_OUTPUT: '/unit/result.json' } }, console: { log() {}, error() {} } }, { filename });
    await module.exports.main(); assert.equal(requests.length, definitions.length); return writes.at(-1);
}

for (const preset of ['connectathon-mtls', 'connectathon-easy', 'connectathon-balanced', 'strict']) test(`${preset}: actual gateway main executes real scoped three-HO presence and denies anonymous clinical`, async () => {
    const result = await executeGateway(preset);
    for (const ho of ['ho-a', 'ho-b', 'ho-c']) {
        assert.ok(result.requests.some(row => row.kind === 'gateway' && row.source === ho + '-gateway' && row.path.startsWith('/fhir/Patient?')));
        assert.ok(result.requests.some(row => row.source === ho + '-gateway' && row.method === 'POST'));
        assert.ok(result.requests.some(row => row.source === ho + '-gateway' && row.method === 'POST' && !row.authenticated));
        assert.equal(result.output.scenarios.find(row => row.id === 'gateway-' + ho).mode, 'enforced-online-batch-isolation');
    }
});
for (const option of ['legacyStatus', 'legacyAuth403', 'wrongCapabilityCode', 'anonymous200', 'anonymousResource', 'foreignClinical403']) test(`actual gateway main rejects ${option} rather than a capability pass`, async () => {
    await assert.rejects(executeGateway('connectathon-mtls', { [option]: option === 'legacyStatus' ? 404 : true }));
});
for (const preset of ['strict', 'connectathon-mtls', 'connectathon-balanced', 'connectathon-easy']) test(`${preset}: actual catalog main retains exact typed Patient isolation and rejects leaks`, async () => {
    assert.equal((await executeCatalog(preset)).scenarios.length, 4);
    for (const damage of ['leak', 'wrong-patient', 'two-patients']) await assert.rejects(executeCatalog(preset, damage));
});
