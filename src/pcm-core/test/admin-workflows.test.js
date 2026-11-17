'use strict';
/** Bounded editor, real private publication and clock/adoption regression tests. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { installTestRuntime, buildTeamConfig } = require('../../../test-support/team-config');
const baseline = installTestRuntime();
const router = require('../src/routes/ui'), model = require('../src/admin-workflows');
const read = () => JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));
const form = config => ({ expectedRevision: String(config.runtime.revision || 0), ...Object.fromEntries(model.FIELDS.map(field => [field.key, String(config.systemAuthorization[field.group][field.name])])) });
function seed() { const config = buildTeamConfig(); config.runtime = baseline.runtime; fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config)); return config; }
/** Exercise the actual route handler and config/private publication owners. */
function submit(body) {
    const route = '/admin/config/test-workflows', result = { status: 200 };
    const req = { body, path: route, query: {}, params: {}, get: () => 'application/json' };
    const res = { status(code) { result.status = code; return this; }, json(value) { result.body = value; return this; }, format(types) { return types.json(); } };
    router.stack.find(layer => layer.route?.path === route).route.stack[0].handle(req, res); return result;
}
test('every bounded workflow field saves exact integer limits and preserves independently owned configuration', () => {
    seed();
    for (const field of model.FIELDS) for (const value of [field.min, field.max]) {
        const before = read(), body = form(before); body[field.key] = String(value);
        if (field.key === 'otp.expirySeconds') body['otp.resendSeconds'] = '1';
        if (field.key === 'otp.resendSeconds') body['otp.expirySeconds'] = '600';
        const result = submit(body); assert.equal(result.status, 200, JSON.stringify(result));
        const next = read(); assert.equal(next.systemAuthorization[field.group][field.name], value);
        for (const key of ['organizations', 'oauthClients', 'presence', 'securitySimulation', 'contract']) assert.deepEqual(next[key], before[key]);
        for (const key of ['memberships', 'clientEntitlements', 'presenceEligiblePatients']) assert.deepEqual(next.systemAuthorization[key], before.systemAuthorization[key]);
        assert.match(result.body.adoption, /invalidate/);
    }
});
test('invalid finite/integer/range/retry/cross-policy and stale forms leave bytes and revision unchanged', () => {
    seed();
    for (const field of model.FIELDS) for (const invalid of [String(field.min - 1), String(field.max + 1), 'NaN', 'Infinity', '1.5', '1e2', '', [], {}, null, false]) {
        const config = read(), bytes = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
        const result = submit({ ...form(config), [field.key]: invalid });
        assert.equal(result.status, 400, `${field.key} ${JSON.stringify(invalid)}`); assert.equal(result.body.field, field.key); assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), bytes);
    }
    for (const extra of [{ expectedRevision: '-1' }, { memberships: [] }, { 'discovery.eligibleRelationships': [] }, { 'otp.channels': ['email'] }, { 'otp.expirySeconds': '30', 'otp.resendSeconds': '30' }]) {
        const bytes = fs.readFileSync(process.env.TEAM_CONFIG_PATH); assert.equal(submit({ ...form(read()), ...extra }).status, extra.expectedRevision ? 409 : 400); assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), bytes);
    }
});
/** Ordinary strong-identity OTP fixture with controlled time and real process-local flow state. */
function flowFixture() {
    const f = require('../../../test-support/data-grants').dataGrantFixture();
    const { SystemFlowStore } = require('../src/system-flow-store');
    const { SystemWorkflows, OTP_PURPOSE, PURPOSE_SYSTEM, CONTACT_EVIDENCE } = require('../src/system-workflows');
    let now = require('../../../test-support/data-grants').NOW;
    const flows = new SystemFlowStore(f.config, { store: f.store, clock: () => now });
    const patient = { resourceType: 'Patient', id: 'clock-patient', identifier: [f.strongPatient], birthDate: '1980-01-02', telecom: [{ system: 'sms', value: '+972500000000', extension: [
        { url: OTP_PURPOSE, valueCodeableConcept: { coding: [{ system: PURPOSE_SYSTEM, code: 'OTP' }] } },
        { url: CONTACT_EVIDENCE, extension: [{ url: 'verifiedAt', valueDateTime: new Date(now * 1000).toISOString() }] }
    ] }] };
    const bundle = { resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ resource: patient }] };
    const workflow = new SystemWorkflows({ config: f.config, store: f.store, flows, clock: () => now, codeGenerator: () => '123456', request: async () => bundle });
    const binding = 'workflow28-ordinary-browser-binding-at-least-32';
    return { ...f, flows, workflow, bundle, binding, advance(seconds) { now += seconds; }, input: { browserBinding: binding, identifier: f.strongPatient, birthDate: patient.birthDate, homeHmoId: f.source.dataSourceOrganization.id } };
}
test('unchanged settings retain attempts/deadlines; changed clocks invalidate old code and invocation, new flow captures new limits', async t => {
    const f = flowFixture(); t.after(() => f.flows.dispose()); const started = await f.workflow.authenticate(f.input);
    const flow = f.flows.browserFlow(started.flowId, f.binding); const original = { expiresAt: flow.expiresAt, otpExpiresAt: flow.otpExpiresAt };
    assert.throws(() => f.workflow.verify(flow.id, f.binding, '999999')); assert.equal(flow.attempts, 1);
    f.flows.updateConfiguration(structuredClone(f.config)); assert.equal(f.flows.browserFlow(flow.id, f.binding).attempts, 1); assert.equal(flow.expiresAt, original.expiresAt); assert.equal(flow.otpExpiresAt, original.otpExpiresAt);
    const changed = structuredClone(f.config); changed.systemAuthorization.authentication.flowLifetimeSeconds = 60; changed.systemAuthorization.otp.expirySeconds = 45; changed.systemAuthorization.otp.resendSeconds = 2;
    f.flows.updateConfiguration(changed); assert.equal(f.workflow.transport.inspect(flow.id), null); assert.throws(() => f.workflow.verify(flow.id, f.binding, '123456'));
    assert.equal(f.flows.invocation(flow.id, changed.oauthClients.authenticationOrchestrator.clientId), null);
    const { SystemWorkflows } = require('../src/system-workflows'); const next = new SystemWorkflows({ config: changed, store: f.store, flows: f.flows, transport: f.workflow.transport, clock: f.workflow.clock, codeGenerator: () => '123456', request: async () => f.bundle });
    const fresh = await next.authenticate(f.input), captured = f.flows.browserFlow(fresh.flowId, f.binding);
    assert.equal(captured.expiresAt - next.clock(), 60); assert.equal(captured.otpExpiresAt - next.clock(), 45);
    assert.throws(() => next.verify(fresh.flowId, f.binding, '999999')); f.advance(2); await next.resend(fresh.flowId, f.binding); assert.equal(captured.attempts, 1);
    f.advance(45); assert.throws(() => next.verify(fresh.flowId, f.binding, '123456'));
});
test('save-time reconfiguration prevents a delayed authentication lookup from delivering a late OTP', async t => {
    const f = flowFixture(); t.after(() => f.flows.dispose()); let release;
    f.workflow.request = async () => new Promise(resolve => { release = resolve; }); const pending = f.workflow.authenticate(f.input); await Promise.resolve();
    const changed = structuredClone(f.config); changed.systemAuthorization.discovery.maxRetries = 0; f.flows.updateConfiguration(changed);
    release(f.bundle); await assert.rejects(pending); assert.equal(f.workflow.transport.deliveries.size, 0); assert.equal(f.flows.flows.size, 0);
});
