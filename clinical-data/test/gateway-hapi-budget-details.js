'use strict';
/** Real opaque-token gateway/adapter/native failures; host-owned DB lock controls only timeout/admission. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { approve, read, put } = require('./gateway-authorized-search-matrix');
const runtime = require('./demo-runtime-client');
const configPath = process.env.TEAM_CONFIG_PATH, original = fs.readFileSync(configPath);
const evidence = process.env.PCM_BUDGET_EVIDENCE, control = process.env.PCM_BUDGET_CONTROL;
const ho = runtime.config.healthOrganizations[0];
const report = { status: 'running', source: ho.id, cases: [], sourceRevision: process.env.PCM_AUTHORIZED_SEARCH_REVISION };
const logFile = path.join(process.env.PCM_AUTHORIZED_SEARCH_LOGS, ho.id + '-hapi-runtime/current.log');
/** Only disposable config bytes change, with no authorizing policy edits or added token claims. */
function limits(values) {
    const config = JSON.parse(original); config.clinicalQuery = { sources: { [ho.id]: values } };
    fs.writeFileSync(configPath, JSON.stringify(config));
}
/** Barrier controls contain no credentials; external lock and release are separately inspectable. */
async function wait(name) {
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(path.join(control, name))) { assert.ok(Date.now() < deadline, 'host barrier ' + name); await new Promise(resolve => setTimeout(resolve, 25)); }
}
function mark(name) { fs.writeFileSync(path.join(control, name), 'ready'); }
/** Read newly emitted raw JSONL directly; no Logs projection or nearby WARN is used as cause authority. */
async function terminal(correlation) {
    for (let attempt = 0; attempt < 150; attempt++) {
        const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(0, -1) : [];
        for (const raw of lines.toReversed()) {
            const record = JSON.parse(raw);
            if (record.details?.correlationId === correlation && ['HAPI_ERROR', 'HAPI_RESPONSE'].includes(record.details.type)) {
                fs.appendFileSync(path.join(evidence, 'native-terminal.jsonl'), raw + '\n'); return record;
            }
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Native terminal missing for ' + correlation);
}
/** Assert exact independent native cause and unchanged public generic failure contract. */
async function failed(result, setting, threshold, status = 503) {
    assert.equal(result.status, status, result.text); assert.equal(result.body.resourceType, 'OperationOutcome');
    assert.equal(result.body.issue[0].diagnostics, 'PCM clinical read could not complete');
    assert.equal(result.headers['retry-after'], status === 503 ? '1' : undefined);
    assert.doesNotMatch(result.text, /budgetFailure|QUERY_BUDGET_EXCEEDED|maxAllocatedBytes|maxPageIdVisits/);
    assert.ok(!Object.keys(result.headers).some(key => /budget|reason-code/.test(key)));
    const native = await terminal(result.correlation), cause = native.details.budgetFailure;
    assert.equal(native.details.type, 'HAPI_ERROR'); assert.equal(native.level, 'ERROR');
    assert.equal(native.details.status, status); assert.equal(native.details.reasonCode, 'QUERY_BUDGET_EXCEEDED');
    assert.equal(cause.setting, setting); assert.equal(cause.threshold, threshold); assert.ok(Number.isSafeInteger(cause.observed));
    assert.ok(cause.observed > (setting === 'maxConcurrentQueries' ? threshold - 1 : setting === 'timeoutMilliseconds' ? 0 : threshold));
    assert.equal(native.message, `HAPI_ERROR · QUERY_BUDGET_EXCEEDED: ${setting} limit=${threshold} ${cause.unit} observed=${cause.observed} ${cause.unit}`);
    assert.equal(native.details.method, 'GET'); assert.ok(native.details.url.includes('/Observation'));
    report.cases.push({ setting, publicStatus: result.status, headers: { contentType: result.headers['content-type'], retryAfter: result.headers['retry-after'] }, native });
}
/** Each positive read gets real registered SP opaque authority with active PCM introspection. */
async function main() {
    assert.equal(process.env.PCM_AUTHORIZED_SEARCH_OWNED, 'disposable');
    try {
        await put(ho, [{ resourceType: 'Patient', id: 'budget-patient', identifier: [{ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000018' }] },
            ...Array.from({ length: 4 }, (_, i) => ({ resourceType: 'Observation', id: 'budget-observation-' + i, status: 'final', code: { text: 'owned budget' }, subject: { reference: 'Patient/budget-patient' } }))]);
        const consent = await approve('000000018');
        async function call(query = '') {
            const token = await runtime.issue(consent, 'patient/Observation.s'); assert.equal(token.status, 200, JSON.stringify(token.json));
            return read(ho.endpoint + '/Observation?_count=1' + query, token.json.access_token);
        }
        async function recover(name) {
            limits({}); const result = await call(); assert.equal(result.status, 200, result.text);
            const native = await terminal(result.correlation); assert.equal(native.details.budgetFailure, undefined);
            report.cases.push({ name, status: result.status, correlation: result.correlation });
        }
        if (process.env.PCM_BUDGET_PHASE !== 'blocked') {
        await recover('initial-success');
        for (const setting of ['maxAllocatedBytes', 'maxPageIdVisits', 'maxPageBodyVisits', 'maxPagePayloadBytes', 'maxCountCandidates']) {
            limits({ [setting]: 1 });
            await failed(await call(setting.startsWith('maxCount') ? '&_summary=count' : ''), setting, 1, setting.startsWith('maxCount') ? 500 : 503);
            await recover(setting + '-recovery');
        }
        } else report.cases = JSON.parse(fs.readFileSync(path.join(evidence, 'gateway-preblocked.json'))).cases;
        mark('needs-lock'); await wait('lock-ready');
        limits({ timeoutMilliseconds: 1200 });
        await failed(await call(), 'timeoutMilliseconds', 1200);
        mark('timeout-finished'); await wait('continue-admission');
        limits({ maxConcurrentQueries: 1, timeoutMilliseconds: 10000 });
        const first = call(); await new Promise(resolve => setTimeout(resolve, 350));
        await failed(await call(), 'maxConcurrentQueries', 1);
        mark('admission-finished'); await wait('lock-released');
        const recovered = await first; assert.equal(recovered.status, 200, recovered.text);
        const native = await terminal(recovered.correlation); assert.equal(native.details.budgetFailure, undefined);
        report.cases.push({ name: 'blocked-owner-recovers-after-admission-refusal', status: recovered.status });
        await recover('following-request-reservation-released'); report.status = 'pass';
    } catch (error) { report.status = 'fail'; report.error = error.stack; throw error; }
    finally { fs.writeFileSync(configPath, original); fs.writeFileSync(path.join(evidence, 'gateway-native.json'), JSON.stringify(report, null, 2)); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
