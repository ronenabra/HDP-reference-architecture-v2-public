'use strict';
/** Browser bookkeeping corrections are source-bound; nested security/protocol evidence stays visible. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { classifyRoute, knownLogClassification, isCriticalDiagnostic } = require('../../shared/log-policy');
const { normalizeLogEntry, expandLogEntry } = require('../src/log-normalization');
const { readUnifiedPage } = require('../src/unified-log-page');
const actions = ['start', 'local-sso', 'fixture-start', 'verify', 'resend', 'cancel', 'local-code', 'discover', 'presence', 'presence-dependents', 'select'];
const source = { componentId: 'pcm-core', role: 'pcm' };
test('all browser actions are diagnostic without blanket SYSTEM or foreign-source corrections', () => {
    for (const action of actions) {
        const url = `/sandbox/authentication/${action}`;
        assert.equal(classifyRoute(url, 'pcm-core').visibility, 'diagnostic');
        assert.equal(classifyRoute(url, 'sp-client').visibility, 'default');
        for (const type of ['REQUEST', 'RESPONSE', 'ROUTE_ERROR']) assert.equal(knownLogClassification({ details: { type, url, status: 400 } }, source).visibility, 'diagnostic');
        const row = { details: { type: 'SYSTEM_BROWSER_ACTION', action, state: 'denied' } };
        assert.equal(knownLogClassification(row, source).visibility, 'diagnostic'); assert.equal(knownLogClassification(row, { componentId: 'extensions/custom' }), null);
    }
    assert.equal(classifyRoute('/sandbox/authentication', 'pcm-core').causesSystemFlow, false);
    assert.equal(classifyRoute('/sandbox/authentication/local-code', 'pcm-core').causesSystemFlow, false);
    assert.equal(classifyRoute('/sandbox/authentication/cancel', 'pcm-core').causesSystemFlow, false);
    assert.equal(classifyRoute('/sandbox/authentication/discover', 'pcm-core').causesSystemFlow, true);
    assert.equal(knownLogClassification({ details: { type: 'SYSTEM_FUTURE_UNKNOWN' } }, source), null);
    assert.equal(knownLogClassification({ message: 'System browser action denied', details: {} }, source), null);
    assert.equal(classifyRoute('/sandbox/authentication-elsewhere', 'pcm-core').visibility, 'default');
});
test('retained projections preserve raw content and real denied authority despite inherited diagnostic metadata', () => {
    for (const type of ['SYSTEM_AUTHENTICATION', 'SYSTEM_OTP', 'SYSTEM_WORKFLOW_REQUEST', 'SYSTEM_WORKFLOW_RESPONSE', 'SYSTEM_WORKFLOW_FAILURE', 'SYSTEM_DISCOVERY', 'SYSTEM_PRESENCE', 'TOKEN_ISSUED', 'TOKEN_AUTHORIZATION_DENIED', 'INTROSPECTION_DECISION', 'AUTHENTICATION_ROLE_DENIED', 'PUBLIC_MTLS_REJECTED']) {
        const input = { event: { source }, details: { type, state: 'denied', visibility: 'diagnostic', payload: 'local private evidence' } }, before = JSON.stringify(input);
        const result = normalizeLogEntry(input); assert.equal(result.details.visibility, 'default', type); assert.equal(result.details.payload, input.details.payload); assert.equal(JSON.stringify(input), before);
    }
    assert.equal(isCriticalDiagnostic({ level: 'WARN', details: { visibility: 'diagnostic', status: 400 } }), false);
    assert.equal(isCriticalDiagnostic({ level: 'INFO', details: { visibility: 'diagnostic', type: 'SYSTEM_BROWSER_ACTION', state: 'denied' } }), false);
    assert.equal(isCriticalDiagnostic({ level: 'ERROR', details: { visibility: 'diagnostic', type: 'ROUTE_ERROR' } }), true);
});
test('concurrent diagnostic wrapper emissions retain real nested decisions and trace isolation', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-log-context-')), previous = process.env.LOG_DIR; process.env.LOG_DIR = path.join(root, 'pcm-core');
    const { createLogger } = require('../../shared/logger'); const logger = createLogger({ service: 'pcm-core', onFinished: require('on-finished') });
    if (previous === undefined) delete process.env.LOG_DIR; else process.env.LOG_DIR = previous;
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await Promise.all(['one', 'two'].map((flowId, index) => logger.withContext({ flowId, traceId: String(index + 1).repeat(32), spanId: 'a'.repeat(16), traceFlags: '01', logCategory: 'harness', logVisibility: 'diagnostic' }, async () => {
        logger.info('Generic browser denial', { type: 'SYSTEM_BROWSER_ACTION', action: 'start', state: 'denied' });
        await new Promise(resolve => setImmediate(resolve));
        logger.info('Fixture actual decision event', { type: 'SYSTEM_AUTHENTICATION', state: 'denied', payload: 'non-AWS-private-evidence' });
        logger.info('Fixture outbound protocol', { type: 'SYSTEM_WORKFLOW_REQUEST', scenario: 'patient-authentication' });
    })));
    const raw = fs.readFileSync(logger.getLogPath(), 'utf8'), records = raw.trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 6);
    for (const row of records) {
        assert.equal(row.details.visibility, row.details.type === 'SYSTEM_BROWSER_ACTION' ? 'diagnostic' : 'default');
        assert.equal(row.details.traceId, (row.details.flowId === 'one' ? '1' : '2').repeat(32));
    }
    const normalize = row => expandLogEntry(normalizeLogEntry(row));
    const off = readUnifiedPage(root, [{ dir: 'pcm-core', role: 'pcm' }], { diagnostics: 'false' }, '', normalize);
    assert.equal(off.entries.length, 4); assert.equal(off.criticalDiagnostic, null);
    const on = readUnifiedPage(root, [{ dir: 'pcm-core', role: 'pcm' }], { diagnostics: 'true' }, '', normalize); assert.equal(on.entries.length, 6);
    assert.equal(fs.readFileSync(logger.getLogPath(), 'utf8'), raw);
});
