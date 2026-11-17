'use strict';
/** Sprint30 exact handoffs and actual protected export/clear/outcome seams on owned files. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const config = require('../../../test-support/team-config').installTestRuntime({ publicBaseUrls: { pcmUi: 'http://localhost:14100/pcm' }, observability: { sources: [{ id: 'owned-addon', label: 'Owned addon', role: 'addon' }] } });
process.env.LOG_DIR = path.join(process.env.SHARED_LOGS_DIR, 'pcm-core');
const { bridge } = require('../src/admin-log-context');
const record = (operationId, sourceId, extra = {}) => ({ timestamp: '2026-11-14T01:00:00Z', level: 'INFO', message: 'owned evidence', details: { operationId, sourceId, visibility: 'diagnostic', category: 'admin', ...extra } });
/** Write only the owned fixture inventory; no retained-team path is read. */
function write(component, filename, records) { const file = path.join(process.env.SHARED_LOGS_DIR, component, filename); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, records.map(item => JSON.stringify(item)).join('\n') + '\n'); return file; }

test('legacy bridge preserves exact supported values, discloses all broader scope and rejects ambiguous inputs', () => {
    const exact = bridge({ operationId: 'op:/ exact', severity: 'ERROR', component: 'pcm-core' }, config);
    assert.equal(exact.exact, true); const query = new URLSearchParams(exact.query);
    assert.equal(query.get('operationId'), 'op:/ exact'); assert.equal(query.get('diagnostics'), 'true'); assert.equal(query.get('source'), 'pcm-core'); assert.equal(query.get('level'), 'ERROR');
    for (const input of [{ stage: 'failure' }, { cursor: 'old' }, { since: 'invalid' }, { target: 'removed' }, { component: 'unknown' }, { target: 'ho-a', operationId: 'old-op' }]) { const result = bridge(input, config); assert.equal(result.exact, false); assert.match(result.notice, /broader context/); assert.match(result.notice, /No event has been selected/); }
    assert.throws(() => bridge({ operationId: ['one', 'two'] }, config), /Invalid diagnostic context/);
    assert.throws(() => bridge({ operationId: 'x'.repeat(257) }, config), /Invalid diagnostic context/);
});

test('central matcher uses parsed exact operation/source IDs, including old native imports, without substring or category relabelling', () => {
    const { matchesSearch, candidate } = require('../src/log-search-contract');
    const { normalizeLogEntry } = require('../src/log-normalization');
    const filters = { operationId: 'owned-op', sourceId: 'owned-source', diagnostics: 'true' };
    assert.equal(matchesSearch(record('owned-op', 'owned-source'), filters), true);
    for (const value of [record('owned-op-other', 'owned-source'), record('owned-op', 'other'), record(undefined, undefined, { payload: 'owned-op owned-source' })]) assert.equal(matchesSearch(value, filters), false);
    for (const field of ['operationId', 'sourceId']) assert.equal(matchesSearch(record(undefined, undefined), { [field]: 'undefined', diagnostics: 'true' }), false);
    assert.equal(candidate(JSON.stringify(record('owned-op', 'owned-source')), filters, {}), true);
    const native = normalizeLogEntry(record('owned-op', undefined, { type: 'OUTGOING_REQUEST', category: 'system', visibility: 'default' }));
    assert.equal(native.details.category, 'system'); assert.equal(native.details.visibility, 'default');
    assert.equal(matchesSearch(native, { operationId: 'owned-op' }), true);
    assert.equal(matchesSearch({ operationId:'legacy-top-level', details:{} }, { operationId:'legacy-top-level' }),true);
    const hapi = normalizeLogEntry({ message:'HAPI private import complete', details:{ type:'HAPI_IMPORT_DIAGNOSTIC', operationId:'owned-op' } });
    assert.equal(hapi.details.visibility,'default'); assert.equal(hapi.details.category,'uncategorized'); assert.equal(matchesSearch(hapi,{ operationId:'owned-op' }),true);
});

test('mounted routes share protected full exports and exact missing evidence, clear both scopes with exclusions/partial/new writes, and emit bounded outcomes only', async t => {
    process.env.TEAM_ADMIN_PASSWORD = 'owned30';
    const express = require('express'), inner = require('../src/index').createUiApp(), app = express(); app.use('/pcm', inner);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { delete process.env.TEAM_ADMIN_PASSWORD; inner.locals.closeLogSearch(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}/pcm`, headers = { 'x-admin-password': 'owned30', Accept: 'application/json' };
    const addon = write('extensions/owned-addon', 'current.log', [record('extension', 'addon')]);
    for (let index = 0; index < 8; index++) write('pcm-core', `history/day${index}/app.log`, [record(`retained-${index}`, 'source30')]);
    write('pcm-core', 'current.log', [record('exact30', 'source30', { payload: 'x'.repeat(300000), aws_secret_access_key: 'canary-aws-only', token: 'non-AWS-full-token' }), record('unrelated', 'other')]);
    for (const route of ['/admin/logs', '/admin/logs/download']) {
        assert.equal((await fetch(base + route)).status, 401);
        const response = await fetch(base + route + '?operationId=unrelated', { headers }); assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store'); if (route.endsWith('/download')) assert.match(response.headers.get('content-disposition'), /attachment; filename="logs.json"/);
        const body = await response.json(); assert.equal(body.complete, true); assert.equal(body.logs['pcm-core'].length, 10); const json = JSON.stringify(body); assert.ok(json.includes('x'.repeat(300000))); assert.match(json, /non-AWS-full-token/); assert.doesNotMatch(json, /canary-aws-only/); assert.match(json, /retained-7/);
    }
    const bridgeResponse = await fetch(base + '/admin/logs/view?operationId=exact30', { headers, redirect: 'manual' }); assert.equal(bridgeResponse.status, 303); assert.equal(bridgeResponse.headers.get('location'), '/pcm/logs-view?diagnostics=true&operationId=exact30');
    const unsupported = await fetch(base + '/admin/logs/view?operationId=exact30&stage=failure', { headers }); assert.match(await unsupported.text(), /Open broader Logs context/);
    const noMatch = await fetch(base + '/api/unified-logs?page=true&operationId=missing&diagnostics=true'); assert.deepEqual((await noMatch.json()).entries, []);
    // A non-file stream creates a deterministic per-source failure without permissions assumptions.
    fs.mkdirSync(path.join(process.env.SHARED_LOGS_DIR, 'sp-client', 'current.log'), { recursive: true });
    const partial = await fetch(base + '/admin/logs/download', { headers }); assert.equal(partial.status, 207); const exported = await partial.json(); assert.equal(exported.complete, false); assert.ok(exported.failures.some(item => item.component === 'sp-client'));
    for (const route of ['/admin/logs/clear', '/api/unified-logs/clear']) {
        write('pcm-core', 'history/owned/app.log', [record('old', 'source30')]); write('pcm-core', 'current.log', [record('old-current', 'source30')]);
        const response = await fetch(base + route, { method: 'POST', headers }); assert.equal(response.status, 207); const result = await response.json(); assert.equal(result.scope, 'current-and-retained-history'); assert.ok(result.results.some(item => item.component === 'extensions/owned-addon' && item.status === 'retained')); assert.ok(result.results.some(item => item.component === 'sp-client' && item.status === 'failed')); assert.equal(fs.readFileSync(path.join(process.env.SHARED_LOGS_DIR, 'pcm-core/current.log'), 'utf8'), ''); assert.equal(fs.existsSync(path.join(process.env.SHARED_LOGS_DIR, 'pcm-core/history')), false); assert.match(fs.readFileSync(addon, 'utf8'), /extension/);
        write('pcm-core', 'current.log', [record('new-write', 'source30')]); assert.equal((await (await fetch(base + '/api/unified-logs?page=true&operationId=new-write&diagnostics=true')).json()).entries.length, 1);
        assert.deepEqual((await (await fetch(base + '/api/unified-logs?page=true&operationId=old-current&diagnostics=true')).json()).entries, []);
    }
    const rejected = await fetch(base + '/admin/config/data-sources/removed/institution', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ institutionType: 'other', expectedRevision: Number(config.runtime.revision) || 0, secretCanary: 'do-not-log-body' }) }); assert.equal(rejected.status, 404);
    const sourceId = config.healthOrganizations[0].dataSourceOrganization.id;
    const saved = await fetch(base + '/admin/config/data-sources/' + sourceId + '/institution', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ institutionType: 'hospital', expectedRevision: Number(config.runtime.revision) || 0 }) }); assert.equal(saved.status, 200);
    const afterCommand = fs.readFileSync(path.join(process.env.LOG_DIR, 'current.log'), 'utf8');
    await fetch(base + '/admin?section=logs', { headers }); await fetch(base + '/logs-view'); await fetch(base + '/api/unified-logs?page=true');
    assert.equal(fs.readFileSync(path.join(process.env.LOG_DIR, 'current.log'), 'utf8'), afterCommand, 'passive Logs/Admin GETs emit no new command or middleware noise');
    const log = fs.readFileSync(path.join(process.env.LOG_DIR, 'current.log'), 'utf8'); assert.doesNotMatch(log, /do-not-log-body/); const outcomes = log.trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.details?.type === 'ADMIN_COMMAND_OUTCOME'); assert.equal(outcomes.length, 2); assert.equal(outcomes[1].details.outcome, 'saved'); assert.equal(outcomes[1].details.revision, 1); assert.equal(outcomes[1].details.sourceId, sourceId); const outcome = outcomes[0].details; assert.equal(outcome.category, 'admin'); assert.equal(outcome.visibility, 'diagnostic'); assert.equal(outcome.sourceId, 'removed'); assert.equal(outcome.actor, 'team-admin'); assert.equal(outcome.teamId, config.teamId); assert.equal(outcome.failurePhase, 'command-response'); assert.equal(outcome.correlationId, rejected.headers.get('x-correlation-id')); assert.equal(rejected.headers.get('x-admin-diagnostics'), '/pcm/logs-view?diagnostics=true&inspection=correlationId&correlationId=' + encodeURIComponent(outcome.correlationId));
});

test('bounded outcome audit covers command families and accepted-versus-complete, without capturing bodies or claiming a disconnected command finished', () => {
    const { EventEmitter } = require('node:events');
    const events = [], logger = { getCorrelationId: () => 'owned-correlation', info: (message, details) => events.push(details), warn: (message, details) => events.push(details) };
    const middleware = require('../src/admin-outcome').middleware({ logger, getConfig: () => config });
    const cases = [
        ['/config/security', { status:'saved' }, 200],
        ['/config/data-sources/source30/server-trust/ca', { status:'saved' }, 200],
        ['/config/data-sources/source30/cert/generate', { status:'saved' }, 200],
        ['/api/fhir-servers/independent-server30/imports', { id:'operation30', serverId:'independent-server30' }, 202],
        ['/api/data-operations/operation30/recover', { error:'failed' }, 409],
        ['/migration/checkpoint', { status:'prepared' }, 200],
        ['/restore', { status:'restored' }, 200],
        ['/reset', { status:'reset' }, 200]
    ];
    for (const [pathname, body, status] of cases) {
        const req = { path:pathname, method:'POST', body:{ privateKey:'unlogged-body' }, baseUrl:'/pcm/admin' };
        const res = new EventEmitter(); res.statusCode=status; res.set=()=>res; res.redirect=()=>res; res.json=()=>res;
        let continued=false; middleware(req, res, () => { continued=true; }); assert.equal(continued,true); res.json(body); res.emit('finish');
    }
    assert.equal(events.length,cases.length); assert.ok(events.every(event => event.category==='admin' && event.visibility==='diagnostic' && event.teamId===config.teamId));
    assert.equal(events[3].outcome,'accepted'); assert.equal(events[3].operationId,'operation30'); assert.equal(events[3].serverId,'independent-server30'); assert.equal(events[4].operationId,'operation30'); assert.equal(events[4].failurePhase,'command-response'); assert.doesNotMatch(JSON.stringify(events),/unlogged-body/);
    for (const [pathname, method] of [['/logs/view','GET'],['/logs/clear','POST'],['/sanity-check','POST']]) { const res=new EventEmitter(); middleware({ path:pathname, method },res,()=>{}); res.emit('finish'); }
    assert.equal(events.length,cases.length,'viewer/clear GETs and existing harness producer do not get duplicate outcomes');
    const interrupted=new EventEmitter(); interrupted.set=()=>interrupted; interrupted.redirect=()=>interrupted; interrupted.json=()=>interrupted;
    middleware({ path:'/reset', method:'POST', body:{} },interrupted,()=>{}); interrupted.emit('close'); assert.equal(events.length,cases.length,'disconnect does not claim completion');
});

test('actual import wrapper producer keeps captured source/operation identity and diagnostic admin visibility while real nested protocol stays normal', () => {
    const logger = require('../src/logger'), emit = require('../src/routes/ui')._test.logImportDiagnostic;
    const original = { id:'captured-ho', dataSourceOrganization:{ id:'captured-source30' } };
    logger.withContext({ logCategory:'admin', logVisibility:'diagnostic', correlationId:'admin30-wrapper' }, () => {
        emit({ id:'operation30', serverId:'independent-server30', targetIdentity:JSON.stringify(original) },'failure','error',{ failureStage:'read-only-verification' });
        logger.info('real nested protocol evidence', { type:'OUTGOING_REQUEST', operationId:'operation30' });
    });
    const records=fs.readFileSync(logger.getLogPath(),'utf8').trim().split('\n').map(JSON.parse);
    const wrapper=records.findLast(row=>row.details?.type==='IMPORT_DIAGNOSTIC');
    assert.equal(wrapper.details.category,'admin'); assert.equal(wrapper.details.visibility,'diagnostic'); assert.equal(wrapper.details.operationId,'operation30'); assert.equal(wrapper.details.sourceId,'captured-source30'); assert.equal(wrapper.details.serverId,'independent-server30'); assert.equal(wrapper.details.failureStage,'read-only-verification');
    const protocol=records.at(-1); assert.equal(protocol.details.type,'OUTGOING_REQUEST'); assert.equal(protocol.details.visibility,'default'); assert.equal(protocol.details.category,'system'); assert.equal(protocol.details.correlationId,'admin30-wrapper');
});
