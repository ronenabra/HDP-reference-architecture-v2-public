'use strict';
/** Owned 201-row sparse fixture plus four-row mutation proof; every temporary resource is deleted in finally. */
const assert = require('node:assert/strict'), fs = require('node:fs');
const { request } = require('./hapi-authorization-matrix');
const { traverse, primary } = require('./hapi-page-matrix');
const ho = 'ho-a', marker = 'urn:ds-page-fixture|small', resources = [];

/** The approved private loader boundary creates only tagged test-owned resources. */
async function maintenance(method, path, body) {
    assert.ok(process.env.PCM_A_IMPORT_CREDENTIAL?.length >= 32, 'owned runtime maintenance credential');
    const response = await fetch(`https://${ho}-hapi:8080/fhir${path}`, { method,
        headers: { 'content-type': 'application/fhir+json', accept: 'application/fhir+json', 'X-PCM-Import-Credential': process.env.PCM_A_IMPORT_CREDENTIAL },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch (_) {}
    assert.ok(response.ok, `${method} ${path}: HTTP${response.status} ${text}`); return json;
}
/** Predictable tied sort keys make logical-ID ordering an independent oracle. */
function observation(id, status = 'cancelled') {
    return { resourceType: 'Observation', id, meta: { tag: [{ system: 'urn:ds-page-fixture', code: 'small' }] },
        status, code: { text: 'PAGE temporary fixture' }, subject: { reference: 'Patient/patient-ho-a-0001' }, effectiveDateTime: '2026-01-01T00:00:00Z' };
}
/** Follow exactly the emitted opaque cursor. */
function next(bundle) { const value = new URL(bundle.link.find(l => l.relation === 'next').url); return value.pathname + value.search; }
async function main() {
    const result = { status: 'running', scope: 'page-small-sparse-mutation', created: 0 };
    try {
        const entries = Array.from({ length: 201 }, (_, n) => {
            const resource = observation(`ds-page-sparse-${String(n).padStart(3, '0')}`, n === 200 ? 'amended' : 'cancelled');
            resources.push(`Observation/${resource.id}`); return { resource, request: { method: 'PUT', url: `Observation/${resource.id}` } };
        });
        await maintenance('POST', '', { resourceType: 'Bundle', type: 'transaction', entry: entries }); result.created = entries.length;
        const query = `/fhir/Observation?_tag=${encodeURIComponent(marker)}&_sort=date`;
        result.sparse = await traverse(ho, `${query}&_count=1`, 'patient/Observation.s?status=amended', ['ds-page-sparse-200']);
        result.broad = await traverse(ho, `${query}&_count=25`, 'patient/Observation.s', entries.map(e => e.resource.id));
        result.visibility = { visible: 1, candidates: 201, fraction: 1 / 201 };
        // Independent four-row membership is fully collected in the first native phase.
        const base = [];
        for (let n = 0; n < 4; n++) {
            const resource = observation(`ds-page-mutation-${n}`, 'final');
            resources.push(`Observation/${resource.id}`); base.push(resource);
        }
        await maintenance('POST', '', { resourceType: 'Bundle', type: 'transaction', entry: base.map(resource => ({ resource, request: { method: 'PUT', url: `Observation/${resource.id}` } })) });
        const scope = 'patient/Observation.s', idsQuery = `_id=${base.map(r => r.id).join(',')}`;
        const first = await request(ho, `/fhir/Observation?${idsQuery}&status=final&_count=1&_sort=date`, scope);
        assert.equal(first.response.status, 200, first.text); assert.deepEqual(primary(first.body), [base[0].id]);
        await maintenance('PUT', `/Observation/${base[1].id}`, { ...base[1], status: 'amended' });
        const continued = await request(ho, next(first.body), scope);
        assert.equal(continued.response.status, 200, continued.text);
        assert.deepEqual(primary(continued.body), [base[2].id], 'query-mutation hole must advance, not expose stale match');
        await maintenance('DELETE', `/Observation/${base[3].id}`);
        const exhausted = await request(ho, next(continued.body), scope);
        assert.equal(exhausted.response.status, 200, exhausted.text);
        assert.deepEqual(primary(exhausted.body), []); assert.ok(!exhausted.body.link.some(l => l.relation === 'next'));
        result.mutation = { initial: primary(first.body), afterClientQueryChange: primary(continued.body), afterDelete: primary(exhausted.body), contract: 'native cached candidate membership, current body/query recheck, no cross-request snapshot' };
        // A different real Patient must not reuse this cursor even with identical scope text.
        const patient = { resourceType: 'Patient', id: 'ds-page-other-patient', identifier: [{ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000026' }] };
        resources.push('Patient/' + patient.id); await maintenance('PUT', '/Patient/' + patient.id, patient);
        const crossed = await request(ho, next(first.body), scope, { claims: { patient_identifier: patient.identifier[0] } });
        assert.equal(crossed.response.status, 403, 'different selected Patient continuation'); result.otherPatientStatus = crossed.response.status;
        result.status = 'pass';
    } finally {
        const failures = [];
        for (const resource of resources.reverse()) {
            try { await maintenance('DELETE', `/${resource}`); } catch (error) { failures.push(error.message); }
        }
        result.cleanup = { deleted: resources.length, failures }; assert.deepEqual(failures, []);
        if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(result, null, 2));
    }
    console.log(JSON.stringify(result));
}
if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { observation, maintenance, main };
