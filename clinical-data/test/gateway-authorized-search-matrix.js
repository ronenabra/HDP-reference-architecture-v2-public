'use strict';

/** Focused ordinary opaque-token -> introspection -> gateway -> HAPI sparse selection proof. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const crypto = require('node:crypto');
const runtime = require('./demo-runtime-client');
const { observation } = require('./hapi-authorized-search-matrix');
const report = { scope: 'opaque-token-gateway-native-selection', preset: runtime.config.conformance.preset,
    status: 'running', cases: [], sourceRevision: process.env.PCM_AUTHORIZED_SEARCH_REVISION };
const prefix = 'authorized-search-';
const target = prefix + 'patient', empty = prefix + 'empty', other = prefix + 'other';
const identitySystem = 'http://fhir.health.gov.il/identifier/il-national-id';
const rawEnvironment = fs.readFileSync(process.env.PCM_AUTHORIZED_SEARCH_ENV, 'utf8');
process.env.TEAM_ADMIN_PASSWORD = rawEnvironment.match(/^TEAM_ADMIN_PASSWORD=(.*)$/m)?.[1];

/** Maintenance only constructs the explicitly owned fixture; ordinary reads never get this credential. */
async function put(ho, resources) {
    const credential = rawEnvironment.match(new RegExp(`^PCM_${ho.id.slice(-1).toUpperCase()}_IMPORT_CREDENTIAL=(.*)$`, 'm'))?.[1];
    assert.ok(credential);
    for (let offset = 0; offset < resources.length; offset += 100) {
        const response = await fetch(`https://${ho.id}-hapi:8080/fhir`, { method: 'POST', headers: {
            'content-type': 'application/fhir+json', 'X-PCM-Import-Credential': credential
        }, body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction', entry: resources.slice(offset, offset + 100)
            .map(resource => ({ resource, request: { method: 'PUT', url: resource.resourceType + '/' + resource.id } })) }), signal: AbortSignal.timeout(30000) });
        const text = await response.text(); assert.ok(response.ok, `${ho.id} fixture import: ${response.status} ${text}`);
    }
}

/** Use the actual registered SP certificate on the public gateway, with a unique diagnostic correlation. */
async function read(url, token) {
    const correlation = 'authorized-search-' + crypto.randomUUID();
    const role = runtime.config.certificateRoles.serviceProvider.mtls;
    return new Promise((resolve, reject) => {
        const request = https.request(url, { agent: false, ca: fs.readFileSync('/runtime/certs/rootCA.crt'),
            cert: fs.readFileSync('/runtime/certs/' + role.cert), key: fs.readFileSync('/runtime/certs/' + role.key),
            headers: { accept: 'application/fhir+json', authorization: 'Bearer ' + token, 'x-correlation-id': correlation } }, response => {
            let text = ''; response.on('data', value => { text += value; });
            response.on('end', () => { let body; try { body = JSON.parse(text); } catch (_) { /* preserve failure */ }
                resolve({ status: response.statusCode, headers: response.headers, body, text, correlation }); });
        }); request.setTimeout(15000, () => request.destroy(new Error('Gateway request deadline'))); request.on('error', reject); request.end();
    });
}

/** Require actual request-owned counters, never infer work from response cardinality or elapsed time. */
async function work(ho, correlation) {
    const file = path.join(process.env.PCM_AUTHORIZED_SEARCH_LOGS, ho.id + '-hapi-runtime', 'current.log');
    for (let attempt = 0; attempt < 100; attempt++) {
        const records = fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
        const event = records.findLast(row => row.details?.correlationId === correlation && row.details?.pageWork);
        if (event) return { ...event.details.pageWork, elapsedMs: event.details.durationMs, selection: event.details.nativeSelection };
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`${ho.id}: actual work not observed for ${correlation}`);
}

/** Create and approve a new ordinary Consent; no fixture-local authorization is manufactured. */
async function approve(patient) {
    const binding = runtime.config.serviceCatalog.bindings.find(item => item.application === 'doctor' && item.serviceKey === 'lab-follow-up');
    assert.ok(binding);
    const pending = await runtime.client.createConsentRequest(`${identitySystem}|${patient}`, binding.instanceId, 'hospital-a');
    assert.equal(pending.status, 'proposed');
    return runtime.approvePending(pending, { scopeChoice: 'service-provided',
        sourceIds: runtime.config.healthOrganizations.map(ho => ho.dataSourceOrganization.id) });
}

/** Follow exact public links with freshly issued equivalent opaque authority and assert ordered primary IDs. */
async function traverse(name, ho, sourceIndex, consent, expected) {
    let url = ho.endpoint + '/Observation?_count=10'; const pages = [], ids = [];
    for (let page = 0; page < 100; page++) {
        const issued = await runtime.issue(consent, undefined, sourceIndex);
        assert.equal(issued.status, 200, JSON.stringify(issued.json));
        const introspected = await runtime.introspect(issued.json.access_token, sourceIndex);
        assert.equal(introspected.status, 200); assert.equal(introspected.json.active, true);
        assert.equal(introspected.json.patient, undefined);
        const result = await read(url, issued.json.access_token);
        assert.equal(result.status, 200, `${name}/${ho.id}: ${result.status} ${result.text}`);
        assert.equal(result.body.total, undefined);
        const selected = (result.body.entry || []).filter(entry => entry.search?.mode === 'match').map(entry => entry.resource.id);
        const counters = await work(ho, result.correlation); assert.equal(counters.completed, true);
        ids.push(...selected); pages.push({ ids: selected, work: counters, effectiveScope: issued.json.scope });
        const next = result.body.link?.find(link => link.relation === 'next')?.url;
        if (!next) break; assert.ok(selected.length > 0); url = next;
    }
    assert.deepEqual(ids, expected); assert.equal(new Set(ids).size, ids.length);
    assert.ok(pages[0].work.candidateIdVisits <= 128, JSON.stringify(pages[0]));
    assert.ok(pages[0].work.bodyVisits <= 128, JSON.stringify(pages[0]));
    assert.ok(pages[0].work.allocatedBytes <= 268435456);
    report.cases.push({ name, source: ho.id, pages, expected, ids });
}

/** Run only the named real-token sparse regression and cross-source refusal on this disposable team. */
async function main() {
    assert.equal(process.env.PCM_AUTHORIZED_SEARCH_OWNED, 'disposable');
    const seed = process.env.PCM_AUTHORIZED_SEARCH_SEED === 'true';
    try {
        const positive = await approve('000000018'), negative = await approve('000000026');
        for (const [index, ho] of runtime.config.healthOrganizations.entries()) {
            const targets = Array.from({ length: 25 }, (_, i) => observation(prefix + String(i).padStart(2, '0'), target));
            targets.push(observation(prefix + 'performer', other, { performer: [{ reference: `Patient/${target}` }] }));
            targets.push(observation(prefix + 'repeated', other, { performer: [{ reference: `Patient/${other}` }, { reference: `Patient/${target}` }] }));
            const expected = targets.map(resource => resource.id).sort();
            if (seed) await put(ho, [{ resourceType: 'Patient', id: target, identifier: [{ system: identitySystem, value: '000000018' }] },
                { resourceType: 'Patient', id: empty, identifier: [{ system: identitySystem, value: '000000026' }] },
                { resourceType: 'Patient', id: other }, ...targets, observation(prefix + 'unauthorized', other)]);
            for (const population of seed ? [1000, 10000] : [10000]) {
                if (seed) for (let offset = population === 1000 ? 0 : 1000; offset < population; offset += 100) {
                    await put(ho, Array.from({ length: 100 }, (_, i) => observation(prefix + 'unrelated-' + (offset + i), other)));
                }
                await traverse(`population-${population}-positive`, ho, index, positive, expected);
                await traverse(`population-${population}-empty`, ho, index, negative, []);
            }
            const issued = await runtime.issue(positive, undefined, index); assert.equal(issued.status, 200);
            const otherSource = runtime.config.healthOrganizations[(index + 1) % 3];
            const rejected = await read(otherSource.endpoint + '/Observation?_count=10', issued.json.access_token);
            assert.ok([401, 403].includes(rejected.status), rejected.text);
            report.cases.push({ name: 'cross-source-token-refused', source: ho.id, target: otherSource.id, status: rejected.status });
        }
        report.status = 'pass';
    } catch (error) { report.status = 'fail'; report.error = error.stack; throw error; }
    finally { fs.writeFileSync(process.env.PCM_AUTHORIZED_SEARCH_OUTPUT, JSON.stringify(report, null, 2)); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main, approve, read, put, work };
