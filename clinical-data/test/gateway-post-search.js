'use strict';
/** Focused disposable POST proof: real Consent/opaque identity plus separately labelled native boundary cases. */
const assert = require('node:assert/strict'), fs = require('node:fs'), https = require('node:https'), crypto = require('node:crypto');
const { approve, put } = require('./gateway-authorized-search-matrix');
const runtime = require('./demo-runtime-client');
const { localToken } = require('./hapi-authorization-matrix');
const { observation } = require('./hapi-authorized-search-matrix');
const ho = runtime.config.healthOrganizations[0], p = 'post-search-';
const target = p + 'patient', other = p + 'other', system = 'http://fhir.health.gov.il/identifier/il-national-id';
const configPath = process.env.TEAM_CONFIG_PATH, original = fs.readFileSync(configPath);
let report = { status: 'running', baseline: process.env.PCM_AUTHORIZED_SEARCH_REVISION, source: ho.id, cases: [] };
const evidence = process.env.PCM_POST_EVIDENCE;

/** Real SP TLS identity and exact raw POST bytes; no method or URI translation. */
function gateway(path, bearer, { method = 'GET', body, type = 'application/x-www-form-urlencoded; charset=UTF-8',
    correlation = p + crypto.randomUUID() } = {}) {
    const role = runtime.config.certificateRoles.serviceProvider.mtls;
    return new Promise((resolve, reject) => {
        const request = https.request(ho.endpoint + path, { method, agent: false, ca: fs.readFileSync('/runtime/certs/rootCA.crt'),
            cert: fs.readFileSync('/runtime/certs/' + role.cert), key: fs.readFileSync('/runtime/certs/' + role.key),
            headers: { accept: 'application/fhir+json', authorization: 'Bearer ' + bearer, 'x-correlation-id': correlation,
                'x-pcm-request-method': 'GET', 'x-pcm-request-uri': '/fhir/Patient/spoofed',
                ...(method === 'POST' ? { 'content-type': type } : {}) } }, response => {
            let text = ''; response.on('data', value => { text += value; });
            response.on('end', () => { let json; try { json = JSON.parse(text); } catch (_) { /* retain failure text */ }
                resolve({ status: response.statusCode, headers: response.headers, body: json, text, correlation, method, path, form: body }); });
        });
        request.setTimeout(15000, () => request.destroy(new Error('POST proof deadline'))); request.on('error', reject); request.end(body);
    });
}

/** Fresh ordinary PCM opaque token per request, from an actual saved approved Consent. */
async function call(consent, path, options, scope, source = 0) {
    const token = await runtime.issue(consent, scope, source);
    assert.equal(token.status, 200, JSON.stringify(token.json));
    report.effectiveScope = token.json.scope;
    return gateway(path, token.json.access_token, options);
}

/** Keep credentials outside evidence while retaining exact operation, status, IDs and correlation. */
function record(name, result) {
    const ids = (result.body?.entry || []).map(entry => entry.resource.resourceType + '/' + entry.resource.id);
    report.cases.push({ name, method: result.method, path: result.path, form: result.form, status: result.status,
        correlation: result.correlation, ids, total: result.body?.total });
    return ids;
}
/** Extract ordered primary IDs without assigning included resources primary authority. */
function matches(result) { return (result.body.entry || []).filter(entry => entry.search?.mode === 'match').map(entry => entry.resource.id); }

/** Separate signed-native context probes exercise exact grant boundaries without claiming PCM opaque provenance. */
async function native(path, scope, body, claims = {}, method = body === undefined ? 'GET' : 'POST') {
    const uri = '/fhir' + path, correlation = p + crypto.randomUUID();
    const token = localToken(ho.id, scope, uri, claims, method);
    const response = await fetch('https://' + ho.id + '-hapi:8080' + uri, { method,
        headers: { authorization: 'Bearer ' + token, 'X-PCM-Request-Method': method, 'X-PCM-Request-URI': uri,
            'x-correlation-id': correlation, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(15000) });
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch (_) { /* retain failure */ }
    return { status: response.status, body: json, text, correlation, method, path, form: body };
}

/** Assert exact first page and POST-origin GET continuation using fresh equivalent authority. */
async function paired(consent, type, predicates, expected, scope, otherConsent) {
    const query = predicates + '&_count=1&_sort=_id&_total=accurate';
    const all = [];
    for (const method of ['GET', 'POST']) {
        let result = await call(consent, '/' + type + (method === 'POST' ? '/_search' : '?' + query),
            method === 'POST' ? { method, body: query } : {}, scope);
        assert.equal(result.status, 200, result.text); assert.equal(result.body.total, expected.length);
        const ids = [];
        for (let page = 0; page < 10; page++) {
            ids.push(...matches(result)); record('opaque-' + type + '-' + method + '-page-' + page, result);
            const next = result.body.link?.find(link => link.relation === 'next')?.url;
            if (!next) break;
            const parsed = new URL(next);
            if (method === 'POST' && page === 0 && otherConsent) {
                const denied = await call(otherConsent, parsed.pathname.replace(/^\/fhir/, '') + parsed.search, {}, scope);
                assert.equal(denied.status, 403, denied.text); record('post-origin-continuation-other-patient-denied', denied);
            }
            result = await call(consent, parsed.pathname.replace(/^\/fhir/, '') + parsed.search, {}, scope);
            assert.equal(result.status, 200, result.text); assert.equal(result.body.total, expected.length);
        }
        assert.deepEqual(ids, expected); all.push(ids);
    }
    assert.deepEqual(all[0], all[1]);
}

/** Run the selected bounded proof phase; persist only credential-free evidence and always restore owned config. */
async function main() {
    assert.equal(process.env.PCM_AUTHORIZED_SEARCH_OWNED, 'disposable');
    try {
        if (process.env.PCM_POST_PHASE === 'patient-selection') {
            const selected = 'authorized-search-patient';
            const ids = ['a', 'b', 'c'].map(id => p + id);
            await put(ho, ids.map(id => observation(id, selected)));
            const consent = await approve('000000018');
            await paired(consent, 'Patient', 'identifier=' + encodeURIComponent(system + '|000000018'), [selected], 'patient/Patient.s');
            await paired(consent, 'Observation', '_id=' + ids.join(',') + '&status=final', ids, 'patient/Observation.s');
            const conflict = await native('/Observation/_search?status=final', 'patient/Observation.s',
                '_id=' + ids.join(',') + '&status=preliminary&_count=10');
            assert.equal(conflict.status, 200, conflict.text); assert.deepEqual(matches(conflict), []);
            record('split-URL-form-repeated-AND-conflict', conflict);
            report.status = 'pass'; return;
        }
        if (process.env.PCM_POST_PHASE === 'final-smoke') {
            report = JSON.parse(fs.readFileSync(evidence + '/gateway-native.json'));
            const consent = await runtime.client.checkConsentStatus(report.consentId, 'hospital-a');
            const result = await call(consent, '/Observation/_search', { method: 'POST', body: 'status=final&_count=3&_sort=_id' });
            assert.equal(result.status, 200, result.text); assert.deepEqual(matches(result), ['a', 'b', 'c'].map(id => p + id));
            record('final-binary-opaque-smoke', result); return;
        }
        if (process.env.PCM_POST_PHASE === 'projection') {
            report = JSON.parse(fs.readFileSync(evidence + '/gateway-native.json'));
            for (const method of ['GET', 'POST']) {
                if (report.cases.some(row => row.name === 'existing-clinical-projection-rejection-' + method)) continue;
                const query = '_id=' + p + 'a&_elements=status,code&_count=1';
                const result = await native('/Observation' + (method === 'POST' ? '/_search' : '?' + query), 'patient/Observation.s', method === 'POST' ? query : undefined);
                assert.equal(result.status, 400, result.text); record('existing-clinical-projection-rejection-' + method, result);
            }
            await put(ho, [{ resourceType: 'Patient', id: target, identifier: [{ system, value: '000000018' }],
                meta: { security: [{ system: 'http://fhir.health.gov.il/cs/il-hdp-information-buckets', code: 'patientDemographics' }] },
                name: [{ family: 'Owned' }], birthDate: '1980-01-02', address: [{ city: 'Not projected' }] }]);
            const scope = require('./pcm-042-native-fixture').authenticationScope;
            const claims = require('./hapi-system-workflow-matrix').claims('patient-authentication');
            const query = 'identifier=' + encodeURIComponent(system + '|000000018') + '&_elements=identifier,name,birthDate';
            for (const method of ['GET', 'POST']) {
                const result = await native('/Patient' + (method === 'POST' ? '/_search' : '?' + query), scope, method === 'POST' ? query : undefined, claims);
                assert.equal(result.status, 200, result.text); assert.deepEqual(matches(result), [target]);
                assert.equal(result.body.entry[0].resource.address, undefined); assert.equal(result.body.entry[0].resource.birthDate, '1980-01-02');
                record('native-authentication-projection-' + method, result);
            }
            report.status = 'pass'; delete report.error; return;
        }
        if (process.env.PCM_POST_PHASE === 'continuation') {
            report = JSON.parse(fs.readFileSync(evidence + '/gateway-native.json'));
            const grant = 'patient/Observation.s?_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V';
            const first = await native('/Observation/_search', grant, 'status=final&_count=1&_sort=_id');
            assert.equal(first.status, 200, first.text); assert.deepEqual(matches(first), [p + 'a']); record('native-post-client-filter-first', first);
            const next = new URL(first.body.link.find(link => link.relation === 'next').url);
            try {
                await put(ho, [observation(p + 'b', target, { status: 'preliminary' })]);
                const continued = await native(next.pathname.replace(/^\/fhir/, '') + next.search, grant);
                assert.equal(continued.status, 200, continued.text); assert.deepEqual(matches(continued), [p + 'c']);
                record('native-post-form-filter-rechecked-on-current-body', continued);
            } finally { await put(ho, [observation(p + 'b', target)]); }
            report.status = 'pass'; delete report.error;
            return;
        }
        let consent;
        if (process.env.PCM_POST_PHASE === 'remaining') {
            report = JSON.parse(fs.readFileSync(evidence + '/gateway-native.json')); report.status = 'running'; delete report.error;
            consent = await runtime.client.checkConsentStatus(report.consentId, 'hospital-a');
        } else {
            await put(ho, [{ resourceType: 'Patient', id: target, identifier: [{ system, value: '000000018' }] },
                { resourceType: 'Patient', id: other, identifier: [{ system, value: '000000026' }] },
                ...['a', 'b', 'c'].map(id => observation(p + id, target)), observation(p + 'wrong-patient', other),
                observation(p + 'preliminary', target, { status: 'preliminary' }),
                observation(p + 'confidential', target, { meta: { security: [
                    { system: 'http://fhir.health.gov.il/cs/il-hdp-information-buckets', code: 'laboratoryTests' },
                    { system: 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality', code: 'V' }] } })]);
            consent = await approve('000000018'); const otherConsent = await approve('000000026');
            report.consentId = consent.id;
            await paired(consent, 'Patient', 'identifier=' + encodeURIComponent(system + '|000000018'), [target], 'patient/Patient.s');
            await paired(consent, 'Observation', 'status=final', ['a', 'b', 'c'].map(id => p + id), 'patient/Observation.s', otherConsent);
            for (const method of ['GET', 'POST']) {
                const count = await call(consent, '/Observation' + (method === 'POST' ? '/_search' : '?status=final&_summary=count'),
                    method === 'POST' ? { method, body: 'status=final&_summary=count' } : {}, 'patient/Observation.s');
                assert.equal(count.status, 200, count.text); assert.equal(count.body.total, 3); record('opaque-count-' + method, count);
            }
        }
        const denied = await native('/Observation/_search', 'patient/Observation.r', '_count=2');
        assert.equal(denied.status, 403, denied.text); record('native-r-only-denied', denied);
        const noScope = await call(consent, '/Condition/_search', { method: 'POST', body: '_count=1' });
        assert.equal(noScope.status, 403, noScope.text); record('opaque-no-type-scope-denied', noScope);
        const wrongPatient = await call(consent, '/Observation/_search', { method: 'POST', body: 'subject=Patient%2F' + other }, 'patient/Observation.s');
        assert.equal(wrongPatient.status, 200, wrongPatient.text); assert.deepEqual(matches(wrongPatient), []); record('opaque-other-patient-empty', wrongPatient);
        const wrongSource = await call(consent, '/Observation/_search', { method: 'POST', body: '_count=1' }, 'patient/Observation.s', 1);
        assert.equal(wrongSource.status, 401, wrongSource.text); record('opaque-wrong-source-denied', wrongSource);
        const inactive = await gateway('/Observation/_search', 'post-search-inactive-opaque', { method: 'POST', body: '_count=1' });
        assert.equal(inactive.status, 401); record('inactive-denied', inactive);
        for (const [name, path, body, status, type] of [
            ['ordinary-post-denied', '/Patient?identifier=x', '_count=1', 401],
            ['unsupported-type-denied', '/Basic/_search', '_count=1', 403],
            ['wrong-media', '/Observation/_search', '{}', 415, 'application/json'],
            ['malformed-form', '/Observation/_search', 'status=%ZZ', 400],
            ['unsupported-form-control', '/Observation/_search', '_filter=status%20eq%20final', 403]
        ]) {
            const result = await call(consent, path, { method: 'POST', body, ...(type ? { type } : {}) }, 'patient/Observation.s');
            assert.equal(result.status, status, name + ': ' + result.text); record(name, result);
        }
        const grant = 'patient/Observation.s?status=final&_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V';
        for (const [name, path, form, expected] of [
            ['native-repeated-encoded', '/Observation/_search?status=final', 'code=http%3A%2F%2Floinc.org%7C718-7&code=718-7&_count=10&_sort=_id', ['a', 'b', 'c']],
            ['native-combined-conflict', '/Observation/_search?status=final', 'status=preliminary&_count=10', []],
            ['native-scope-filter-conflict', '/Observation/_search', 'status=preliminary&_count=10', []],
            ['native-unauthorized-include', '/Observation/_search', '_id=' + p + 'a&_include=Observation:subject&_count=10', ['a']]
        ]) {
            const result = await native(path, grant, form); assert.equal(result.status, 200, result.text);
            assert.deepEqual(matches(result), expected.map(id => p + id));
            assert.ok(!(result.body.entry || []).some(entry => entry.search?.mode === 'include'));
            record(name, result);
        }
        const expired = await native('/Observation/_search', grant, '_count=1', { pcm_expires_at: Math.floor(Date.now() / 1000) - 1 });
        assert.equal(expired.status, 403, expired.text); record('native-expired-denied', expired);
        const config = JSON.parse(original); config.clinicalQuery = { sources: { [ho.id]: { maxPageBodyVisits: 1 } } };
        fs.writeFileSync(configPath, JSON.stringify(config));
        const failed = await call(consent, '/Observation/_search', { method: 'POST', body: '_count=3' }, 'patient/Observation.s');
        assert.equal(failed.status, 503, failed.text); assert.equal(failed.body.resourceType, 'OperationOutcome');
        assert.doesNotMatch(failed.text, /budgetFailure|maxPageBodyVisits|QUERY_BUDGET_EXCEEDED/); record('opaque-existing-budget-failure', failed);
        fs.writeFileSync(configPath, original);
        const recovered = await call(consent, '/Observation/_search', { method: 'POST', body: '_count=3&status=final' }, 'patient/Observation.s');
        assert.equal(recovered.status, 200, recovered.text); record('opaque-budget-recovery', recovered);
        report.status = 'pass';
    } catch (error) { report.status = 'fail'; report.error = error.stack; throw error; }
    finally { fs.writeFileSync(configPath, original); fs.writeFileSync(evidence + '/gateway-native.json', JSON.stringify(report, null, 2)); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main, gateway, native, call, matches };
