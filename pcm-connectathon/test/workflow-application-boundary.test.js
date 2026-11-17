'use strict';
/** Fixture application must materialize PCM authority and probes must reach the browser transport. */
const test = require('node:test'), assert = require('node:assert/strict');
const { buildTeamConfig } = require('../../test-support/team-config');
const { configureWorkflowFixtures, applyRunningWorkflowFixtures } = require('../scripts/configure-system-workflow-fixtures');
const { workflowPostUrl, workflowCsrfSelector } = require('../ui/workflow-tests/browser-boundary');

/** Model the protected complete backup/review/restore/readback boundary without logging material. */
function reviewedTransport(config, { calls = [], postStatus = 200, applied = 'pcm-runtime-reset' } = {}) {
    let current = structuredClone(config);
    const certificates = { 'rootCA.crt': 'synthetic certificate', 'pcm.key': 'synthetic private fixture' };
    return async (url, options) => {
        calls.push({ url, options });
        const pathname = new URL(url).pathname;
        assert.equal(new URL(url).hostname, '127.0.0.1');
        if (pathname === '/admin/backup') {
            assert.equal(options.method, 'GET');
            return { ok: true, status: 200, json: async () => ({ teamId: current.teamId, teamConfig: structuredClone(current), certificates }) };
        }
        assert.equal(pathname, '/admin/restore'); assert.equal(options.method, 'POST');
        const body = JSON.parse(options.body), backup = JSON.parse(body.backupJson);
        assert.equal(body.expectedRevision, String(current.runtime.revision || 0));
        assert.equal(backup.teamId, current.teamId); assert.deepEqual(backup.certificates, certificates);
        assert.deepEqual(backup.teamConfig.securitySimulation, config.securitySimulation);
        current = structuredClone(backup.teamConfig); current.runtime.revision = (current.runtime.revision || 0) + 1;
        return { ok: postStatus === 200, status: postStatus, json: async () => ({ status: 'restored', applied,
            revision: current.runtime.revision, listenerAdoption: 'not-checked' }) };
    };
}

test('running workflow configuration uses complete reviewed restore and verifies PCM adoption only', async () => {
    const original = buildTeamConfig({}, 'strict'), configured = configureWorkflowFixtures(original, { candidate042: true });
    const calls = [];
    const result = await applyRunningWorkflowFixtures(configured, 'synthetic-admin', reviewedTransport(original, { calls }));
    assert.equal(result.applied, 'pcm-runtime-reset'); assert.equal(result.listenerAdoption, 'not-checked');
    assert.deepEqual(calls.map(call => [new URL(call.url).pathname, call.options.method]),
        [['/admin/backup', 'GET'], ['/admin/restore', 'POST'], ['/admin/backup', 'GET']]);
    assert.ok(calls.every(call => call.options.headers['x-admin-password'] === 'synthetic-admin'));
    const applied = JSON.parse(JSON.parse(calls[1].options.body).backupJson).teamConfig;
    assert.equal(applied.systemAuthorization.memberships.length, 5);
    assert.deepEqual(applied.systemAuthorization.participatingHmos, ['ho-a', 'ho-b', 'ho-c']);
    assert.deepEqual(applied.securitySimulation, original.securitySimulation);
    assert.equal(original.systemAuthorization.memberships.length, 0);
});

test('fixture application fails closed on missing authentication, nonlocal destination or failed materialization', async () => {
    const config = buildTeamConfig({}, 'strict');
    const never = () => { throw new Error('unexpected network'); };
    await assert.rejects(applyRunningWorkflowFixtures(config, '', never), /Admin password/);
    await assert.rejects(applyRunningWorkflowFixtures({ ...config, publicBaseUrls: { pcmUi: 'https://remote.example/' } }, 'synthetic', never), /local disposable/);
    await assert.rejects(applyRunningWorkflowFixtures(config, 'synthetic', reviewedTransport(config, { postStatus: 401 })), /HTTP 401/);
    await assert.rejects(applyRunningWorkflowFixtures(config, 'synthetic', reviewedTransport(config, { applied: 'runtime-reload' })), /application failed/);
});

test('review failure and a changed revision never submit or replay fixture restoration', async () => {
    const config = buildTeamConfig({}, 'strict'), calls = [];
    const changed = structuredClone(config); changed.runtime.revision = (config.runtime.revision || 0) + 1;
    await assert.rejects(applyRunningWorkflowFixtures(config, 'synthetic', async (url, options) => {
        calls.push([new URL(url).pathname, options.method]);
        return { ok: true, status: 200, json: async () => ({ teamId: changed.teamId, teamConfig: changed, certificates: {} }) };
    }), /changed|review/i);
    assert.deepEqual(calls, [['/admin/backup', 'GET']]);
    const refused = [];
    await assert.rejects(applyRunningWorkflowFixtures(config, 'synthetic', async (url, options) => {
        refused.push(options.method); return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
    }), /review.*401/i);
    assert.deepEqual(refused, ['GET']);
    const raced = [];
    await assert.rejects(applyRunningWorkflowFixtures(config, 'synthetic', reviewedTransport(config, { calls: raced, postStatus: 409 })), /HTTP 409/);
    assert.deepEqual(raced.map(call => call.options.method), ['GET', 'POST']);
});
test('portal direct probes retain the actual redirected HTTPS origin and explicit rendered form identity', () => {
    for (const action of ['discover', 'verify', 'local-code']) {
        assert.equal(workflowPostUrl('https://127.0.0.1:14000/sandbox/authentication', action), `https://127.0.0.1:14000/sandbox/authentication/${action}`);
    }
    assert.equal(workflowCsrfSelector('start'), 'form[action="/sandbox/authentication/start"] input[name="csrf"]');
    assert.equal(workflowCsrfSelector('verify'), 'form[action="/sandbox/authentication/verify"] input[name="csrf"]');
    for (const url of ['https://example.test/admin', 'file:///sandbox/authentication', 'https://user:pass@example.test/sandbox/authentication']) assert.throws(() => workflowPostUrl(url, 'discover'));
    assert.throws(() => workflowPostUrl('https://example.test/sandbox/authentication', '../admin'));
    assert.throws(() => workflowCsrfSelector('unknown'));
});

test('direct OTP probes admit only exact supported rendered action paths on the actual page origin', () => {
    for (const path of ['', '/start', '/local-sso', '/fixture-start', '/verify', '/resend', '/cancel', '/local-code', '/discover', '/presence', '/presence-dependents', '/select']) {
        assert.equal(workflowPostUrl(`https://127.0.0.1:14000/sandbox/authentication${path}`, 'local-code'), 'https://127.0.0.1:14000/sandbox/authentication/local-code');
    }
    for (const path of ['/admin', '/sandbox/authentication/', '/sandbox/authentication/unknown', '/sandbox/authentication/local-code/extra', '/sandbox/authentication-evil']) {
        assert.throws(() => workflowPostUrl(`https://127.0.0.1:14000${path}`, 'local-code'));
    }
});


test('expired OTP delivery leaves a restartable flow until explicit cancellation', () => {
    const { dataGrantFixture, NOW } = require('../../test-support/data-grants');
    const { SystemFlowStore } = require('../../src/pcm-core/src/system-flow-store');
    const { SystemWorkflows } = require('../../src/pcm-core/src/system-workflows');
    const { config, strongPatient } = dataGrantFixture();
    let now = NOW, cleared = 0;
    const flows = new SystemFlowStore(config, { clock: () => now });
    const input = { identifier: strongPatient, birthDate: '1980-01-02', browserBinding: 'b'.repeat(40), homeHmoId: config.healthOrganizations[0].dataSourceOrganization.id };
    const id = flows.begin(input), flow = flows.browserFlow(id, input.browserBinding);
    flow.otpHash = 'expired'; flow.otpExpiresAt = now + 30;
    const workflow = new SystemWorkflows({ config, flows, clock: () => now, transport: { clear: () => cleared++ } });
    now += 30;
    assert.throws(() => workflow.verify(id, input.browserBinding, '123456'));
    assert.equal(cleared, 1);
    assert.equal(flows.browserFlow(id, input.browserBinding).phase, 'authenticating');
    flows.cancel(id);
    assert.throws(() => flows.browserFlow(id, input.browserBinding));
    const fresh = flows.begin(input);
    assert.notEqual(fresh, id); assert.equal(flows.browserFlow(fresh, input.browserBinding).phase, 'authenticating');
});


for (const preset of require('../../src/shared/conformance-policy').PRESETS) test(`running fixture Admin authentication preserves actual ${preset} policy`, async () => {
    const config = configureWorkflowFixtures(buildTeamConfig({}, preset), { candidate042: true });
    const controls = structuredClone(config.securitySimulation), calls = [];
    if (preset === 'strict') {
        await assert.rejects(applyRunningWorkflowFixtures(config, '', reviewedTransport(config, { calls })), /Admin password/); assert.equal(calls.length, 0);
    } else {
        await applyRunningWorkflowFixtures(config, '', reviewedTransport(config, { calls }));
        assert.ok(calls.every(call => !Object.hasOwn(call.options.headers, 'x-admin-password') && !Object.hasOwn(call.options.headers, 'authorization')));
    }
    const authenticated = [];
    await applyRunningWorkflowFixtures(config, 'configured-synthetic-admin', reviewedTransport(config, { calls: authenticated }));
    assert.ok(authenticated.every(call => call.options.headers['x-admin-password'] === 'configured-synthetic-admin'));
    assert.deepEqual(config.securitySimulation, controls);
    await assert.rejects(applyRunningWorkflowFixtures(config, 'wrong', reviewedTransport(config, { postStatus: 401 })), /HTTP 401/);
    await assert.rejects(applyRunningWorkflowFixtures(config, 'configured', reviewedTransport(config, { applied: 'not-runtime-reset' })), /application failed/);
    await assert.rejects(applyRunningWorkflowFixtures({ ...config, publicBaseUrls: { ...config.publicBaseUrls, pcmUi: 'https://foreign.invalid' } }, 'configured', reviewedTransport(config)), /local disposable/);
});
