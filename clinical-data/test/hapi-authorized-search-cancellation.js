'use strict';
/** Host-controlled owned PostgreSQL lock proves cancellation, admission and captured-budget behavior. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { localToken } = require('./hapi-authorization-matrix');
const type = process.env.PCM_AUTHORIZED_SEARCH_TYPE || 'Observation';
assert.ok(['Patient', 'Observation'].includes(type));
const scope = 'patient/' + type + '.s', uri = '/fhir/' + type + '?_count=10';
const root = process.env.PCM_AUTHORIZED_SEARCH_CONTROL;
const configPath = process.env.TEAM_CONFIG_PATH, original = fs.readFileSync(configPath);
const output = { status: 'running', scope: 'owned-native-blocked-reference-index', cases: [] };
/** Only operational limits change; each request's current verifier captures its own immutable snapshot. */
function limits(values) { const config = JSON.parse(original); config.clinicalQuery = { sources: { 'ho-a': values } }; fs.writeFileSync(configPath, JSON.stringify(config)); }
/** Barrier files contain no credentials and refer only to this named disposable fixture. */
async function barrier(name) {
    for (let attempt = 0; attempt < 2400; attempt++) {
        if (fs.existsSync(root + '/' + name)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Host barrier expired: ' + name);
}
function mark(name) { fs.writeFileSync(root + '/' + name, 'ready'); }
/** The client carries ordinary signed authority and an actual abortable TLS connection. */
async function call(signal, seconds) {
    let token = localToken('ho-a', scope, uri);
    if (seconds) {
        const jwt = require('jsonwebtoken'), decoded = jwt.decode(token, { complete: true });
        decoded.payload.exp = Math.floor(Date.now() / 1000) + seconds;
        decoded.payload.pcm_expires_at = decoded.payload.exp;
        token = jwt.sign(decoded.payload, fs.readFileSync(process.env.PCM_MATRIX_CERTS_DIR + '/ho-a-gateway.key'),
            { algorithm: 'RS256', header: decoded.header });
    }
    const response = await fetch('https://ho-a-hapi:8080' + uri, { headers: { authorization: 'Bearer ' + token,
        'X-PCM-Request-Method': 'GET', 'X-PCM-Request-URI': uri }, signal: signal || AbortSignal.timeout(15000) });
    const text = await response.text(); return { status: response.status, text };
}
/** The external lock stays held until timeout/abort cleanup has been independently inspected. */
async function main() {
    assert.equal(process.env.PCM_AUTHORIZED_SEARCH_OWNED, 'disposable');
    try {
        if (process.env.PCM_AUTHORIZED_SEARCH_PHASE === 'expiry') {
            limits({}); const result = await call(undefined, 2); assert.equal(result.status, 503, result.text);
            output.cases.push({ name: 'verified-authority-expiry-cancels-blocked-native-work', status: result.status });
            mark('expiry-finished'); await barrier('continue-expiry-recovery');
            const recovered = await call(); assert.equal(recovered.status, 200, recovered.text);
            output.cases.push({ name: 'expiry-releases-reservation-and-query-before-recovery', status: recovered.status });
            output.status = 'pass'; return;
        }
        limits({ maxConcurrentQueries: 1 });
        const abort = new AbortController(); const pending = call(abort.signal).then(value => ({ value }), error => ({ error: error.name }));
        await new Promise(resolve => setTimeout(resolve, 300));
        const excess = await call(); assert.equal(excess.status, 503, excess.text);
        abort.abort(); const cancelled = await pending; assert.equal(cancelled.error, 'AbortError');
        await new Promise(resolve => setTimeout(resolve, 300));
        output.cases.push({ name: 'blocked-query-concurrency-refusal-and-client-disconnect', excess: excess.status, client: cancelled.error });
        mark('abort-finished'); await barrier('continue-timeout');
        limits({ timeoutMilliseconds: 1200 });
        const timeout = await call(); assert.equal(timeout.status, 503, timeout.text);
        output.cases.push({ name: 'blocked-reference-query-deadline', status: timeout.status });
        mark('timeout-finished'); await barrier('continue-snapshot');
        limits({}); const captured = call();
        await new Promise(resolve => setTimeout(resolve, 300)); limits({ maxPageIdVisits: 1 });
        mark('snapshot-updated');
        const first = await captured; assert.equal(first.status, 200, first.text);
        const subsequent = await call(); assert.equal(subsequent.status, 503, subsequent.text);
        limits({}); const recovered = await call(); assert.equal(recovered.status, 200, recovered.text);
        output.cases.push({ name: 'in-flight-snapshot-preserved-next-admission-tightened-and-recovered', captured: first.status, subsequent: subsequent.status, recovered: recovered.status });
        output.status = 'pass';
    } catch (error) { output.status = 'fail'; output.error = error.stack; throw error; }
    finally { fs.writeFileSync(configPath, original); fs.writeFileSync(process.env.PCM_AUTHORIZED_SEARCH_OUTPUT, JSON.stringify(output, null, 2)); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
