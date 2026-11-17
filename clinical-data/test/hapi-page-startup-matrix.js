'use strict';
/** Observe native startup admission: connection refusal/503 then protected403; never a native200 window. */
const assert = require('node:assert/strict'), fs = require('node:fs');
async function observe(ho) {
    const start = Date.now(), transitions = []; let previous, protectedReady = false;
    while (Date.now() - start < 120000) {
        let status = 'unreachable';
        try {
            const response = await fetch(`https://${ho}-hapi:8080/fhir/Observation?_count=1`, { headers: { accept: 'application/fhir+json' }, signal: AbortSignal.timeout(1500) });
            status = response.status;
            assert.ok([403,503].includes(status), `${ho} startup must never expose unprotected HTTP${status}`);
            const body = await response.json();
            assert.equal(body.resourceType, 'OperationOutcome');
            if (status === 403) protectedReady = true;
        } catch (error) {
            if (error.code === 'ERR_ASSERTION' || error instanceof SyntaxError) throw error;
        }
        if (status !== previous) transitions.push({ elapsedMs: Date.now() - start, status });
        previous = status;
        if (protectedReady) break;
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(protectedReady, `${ho} verified module-ready denial before test requests`);
    return { ho, transitions, protectedReady, status: 'pass' };
}
async function main() {
    const result = { scope: 'page-startup-protected-seam', status: 'pass', results: await Promise.all(['ho-a','ho-b','ho-c'].map(observe)) };
    if (process.env.PCM_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_MATRIX_OUTPUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
}
if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
module.exports = { main, observe };
