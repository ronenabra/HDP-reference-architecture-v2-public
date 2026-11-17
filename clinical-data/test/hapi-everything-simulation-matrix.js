'use strict';
/** Current signed clinical context exercises operation boundaries after successful admission. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const scope = 'patient/Observation.s?_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|laboratoryTests&_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V&date=ge2026-01-01';
const caseName = 'scoped-signature-raw-query-target-expiry-and-count-denials';
const boundaryNames = ['missing-target', 'wrong-target', 'cursor-target', 'raw-query', 'signature', 'unsigned', 'expiry', 'zero-count', 'summary-count', 'accurate-total'];
const uri = '/fhir/Patient/$everything?_type=Observation&_count=1';
/** Lazy imports let the focused fixture-plan test run without runtime secrets or an HO. */
function runtime() {
    return { ...require('./hapi-authorization-matrix'), ...require('./hapi-everything-matrix'),
        ...require('./hapi-page-small-fixture'), fetch: global.fetch };
}
/** A successful scoped traversal is mandatory before attributing any later boundary denial. */
async function runHo(ho, io = runtime()) {
    const expected = [1, 2].map(n => `Observation/observation-${ho}-000${n}`);
    const pages = await io.traverse(ho, uri, scope, expected);
    const first = await io.request(ho, uri, scope);
    assert.equal(first.response.status, 200, first.text);
    const nextLink = first.body.link?.find(link => link.relation === 'next')?.url;
    assert.ok(nextLink, 'the scoped two-result fixture must exercise continuation');
    const next = new URL(nextLink);
    assert.equal(next.origin, `https://${ho}-gateway:8080`);
    const checks = [];
    async function denied(name, path, status, claims) {
        const result = await io.request(ho, path, scope, { claims });
        assert.equal(result.response.status, status, `${ho} ${name}: ${result.text}`);
        checks.push(name);
    }
    await denied('missing-target', `/fhir/Patient/patient-${ho}-0001/$everything`, 403, { patient_identifier: undefined });
    await denied('wrong-target', `/fhir/Patient/patient-${ho}-htest-1/$everything`, 403);
    await denied('cursor-target', next.pathname + next.search, 403, {
        patient_identifier: { system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' }
    });
    // Only the wire query changes: all accepted signature/context fields remain current.
    const signed = io.localToken(ho, scope, uri);
    const tampered = await io.fetch(`https://${ho}-hapi:8080/fhir/Patient/$everything?_type=Patient&_count=1`, {
        headers: { Authorization: `Bearer ${signed}`, 'X-PCM-Request-URI': uri, 'X-PCM-Request-Method': 'GET', Accept: 'application/fhir+json' }
    });
    assert.equal(tampered.status, 403, 'actual raw query must match signature'); await tampered.text(); checks.push('raw-query');
    const parts = signed.split('.');
    // Corrupt only signature bytes, leaving the supported authority and raw request intact.
    parts[2] = (parts[2]?.startsWith('A') ? 'B' : 'A') + (parts[2] || '').slice(1);
    const badSignature = await io.fetch(`https://${ho}-hapi:8080${uri}`, {
        headers: { Authorization: `Bearer ${parts.join('.')}`, 'X-PCM-Request-URI': uri, 'X-PCM-Request-Method': 'GET' }
    });
    assert.equal(badSignature.status, 403); await badSignature.text(); checks.push('signature');
    const unsigned = await io.fetch(`https://${ho}-hapi:8080${uri}`, {
        headers: { 'X-PCM-Request-URI': uri, 'X-PCM-Request-Method': 'GET' }
    });
    assert.equal(unsigned.status, 403); await unsigned.text(); checks.push('unsigned');
    await denied('expiry', uri, 403, { iat: Math.floor(Date.now() / 1000) - 31 });
    for (const [name, control] of [['zero-count', '_count=0'], ['summary-count', '_summary=count'], ['accurate-total', '_total=accurate']]) {
        await denied(name, `/fhir/Patient/$everything?${control}`, 400);
    }
    assert.deepEqual(checks, boundaryNames);
    // Retired envelopes are separate admission negatives, never evidence for checks above.
    for (const claims of [{ schema: 'pcm-ds-local-token/4' }, { authorization_schema: 'pcm-ds-authorization-context/3' },
        { kind: 'unfiltered-simulation', scope: 'system/*.*' }]) {
        assert.equal((await io.request(ho, uri, scope, { claims })).response.status, 403, 'retired envelope denied');
    }
    return { ho, name: caseName, status: 'pass', scope, expected, pages, baselineStatus: 200, checks,
        admissionNegatives: ['private-version-4', 'context-version-3', 'unfiltered-kind'] };
}
/** Run only on owned disposable native fixtures; the duplicate identifier is always removed. */
async function main(io = runtime()) {
    const cases = [];
    for (const ho of ['ho-a', 'ho-b', 'ho-c']) cases.push(await runHo(ho, io));
    const id = 'ds-everything-ambiguous-target';
    try {
        await io.maintenance('PUT', `/Patient/${id}`, { resourceType: 'Patient', id,
            identifier: [{ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' }] });
        assert.equal((await io.request('ho-a', '/fhir/Patient/$everything', scope)).response.status, 403,
            'ambiguous trusted identifier fails before instance delegation');
        cases.push({ ho: 'ho-a', name: 'ambiguous-resolver', status: 'pass' });
    } finally { await io.maintenance('DELETE', `/Patient/${id}`); }
    const result = { status: 'pass', allOffSimulation: false, cases, temporaryResourcesDeleted: 1 };
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    return result;
}
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { main, runHo, scope, caseName, boundaryNames };
