'use strict';
/** Ordinary opaque-token continuation isolation and revocation; no synthetic private grants. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const runtime = require('./demo-runtime-client');
const { approve, read } = require('./gateway-authorized-search-matrix');
const report = { status: 'running', preset: runtime.config.conformance.preset, scope: 'opaque-token-continuation-authority', cases: [] };
/** Reuse a real saved native membership while changing only the independently issued current authority. */
async function main() {
    assert.equal(process.env.PCM_AUTHORIZED_SEARCH_OWNED, 'disposable');
    try {
        const clinical = await approve('000000018'), empty = await approve('000000026'), retained = [];
        for (const [index, ho] of runtime.config.healthOrganizations.entries()) {
            if (process.env.PCM_AUTHORIZED_SEARCH_HOS && !process.env.PCM_AUTHORIZED_SEARCH_HOS.split(',').includes(ho.id)) continue;
            const issued = await runtime.issue(clinical, undefined, index); assert.equal(issued.status, 200);
            const type = process.env.PCM_AUTHORIZED_SEARCH_TYPE || 'Observation';
            assert.ok(['Observation', 'Patient'].includes(type));
            const first = await read(ho.endpoint + '/' + type + '?_count=1', issued.json.access_token); assert.equal(first.status, 200, first.text);
            const next = first.body.link?.find(link => link.relation === 'next')?.url; assert.ok(next);
            const foreignPatient = await runtime.issue(empty, undefined, index); assert.equal(foreignPatient.status, 200);
            const refused = await read(next, foreignPatient.json.access_token); assert.equal(refused.status, 403, refused.text);
            const tampered = await read(next + '&status=final', issued.json.access_token); assert.equal(tampered.status, 403, tampered.text);
            report.cases.push({ source: ho.id, name: 'other-patient-cursor-denied', status: refused.status },
                { source: ho.id, name: 'continuation-query-tampering-denied', status: tampered.status });
            retained.push({ index, ho, next });
        }
        for (const row of retained) {
            const issued = await runtime.issue(clinical, undefined, row.index); assert.equal(issued.status, 200);
            row.token = issued.json.access_token;
        }
        const parameters = JSON.parse(fs.readFileSync(require('node:path').resolve(__dirname,
            '../../docs/FHIR-examples/Parameters-parameters-consent-hosp-a-lifecycle.json')));
        const cancellation = parameters.parameter.find(item => item.name === 'deactivationRequest').resource;
        cancellation.id = clinical.id;
        const pcmToken = await runtime.client._test.getToken(runtime.config.contract.operational.fhirBase, 'hospital-a');
        const cancelled = await runtime.request(runtime.config.internalBaseUrls.pcmFhir + '/Consent/' + clinical.id,
            { method: 'PUT', body: cancellation, bearer: pcmToken });
        assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
        for (const { ho, next, token } of retained) {
            const result = await read(next, token); assert.ok([401, 403].includes(result.status), result.text);
            report.cases.push({ source: ho.id, name: 'revoked-consent-continuation-denied', status: result.status });
        }
        report.status = 'pass';
    } catch (error) { report.status = 'fail'; report.error = error.stack; throw error; }
    finally { fs.writeFileSync(process.env.PCM_AUTHORIZED_SEARCH_OUTPUT, JSON.stringify(report, null, 2)); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
