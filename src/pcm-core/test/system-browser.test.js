'use strict';

/** HTTP qualification of browser isolation, local OTP diagnostics and private identity selection. */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('path');
require('../../../test-support/team-config').installTestRuntime();
const { dataGrantFixture, NOW } = require('../../../test-support/data-grants');
const { SystemFlowStore } = require('../src/system-flow-store');
const { SystemWorkflows, CONTACT_EVIDENCE, OTP_PURPOSE, PURPOSE_SYSTEM } = require('../src/system-workflows');
const { createSystemWorkflowRouter, BASE } = require('../src/routes/system-workflows');
const { BrowserAuthenticatedIdentityProvider } = require('../src/sandbox-identity-provider');

/** Start an isolated browser app using the real flow and OTP implementations. */
async function harness(t) {
    const { config, strongPatient } = dataGrantFixture();
    let now = NOW;
    const flows = new SystemFlowStore(config, { clock: () => now });
    const patient = { resourceType: 'Patient', id: 'representative', identifier: [strongPatient], birthDate: '1980-01-02', name: [{ family: 'Private family' }], telecom: [{ system: 'sms', value: '0500000000', extension: [
        { url: OTP_PURPOSE, valueCodeableConcept: { coding: [{ system: PURPOSE_SYSTEM, code: 'OTP' }] } },
        { url: CONTACT_EVIDENCE, extension: [{ url: 'verifiedAt', valueDateTime: new Date(NOW * 1000).toISOString() }] }
    ] }] };
    const workflow = new SystemWorkflows({ config, flows, clock: () => now, codeGenerator: () => '123456', request: async () => ({ resourceType: 'Bundle', type: 'searchset', entry: [{ resource: patient }] }) });
    const app = express(); app.set('view engine', 'ejs'); app.set('views', path.resolve(__dirname, '../src/views'));
    const diagnostics = [];
    app.use(createSystemWorkflowRouter({ authorize: () => ({ canResume: id => ['owned-continuation', 'second-continuation'].includes(id) }), loadConfig: () => config, runtime: () => workflow, diagnostics: { info: (message, details) => diagnostics.push({ message, ...details }) } }));
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const root = `http://127.0.0.1:${server.address().port}`;
    const jar = new Map();
    async function request(route = BASE, body, useJar = jar) {
        const response = await fetch(`${root}${route}`, { redirect: 'manual', method: body ? 'POST' : 'GET', headers: { Cookie: [...useJar].map(([key, value]) => `${key}=${value}`).join('; '), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: body ? new URLSearchParams(body) : undefined });
        for (const value of response.headers.getSetCookie()) { const pair = value.split(';')[0]; const split = pair.indexOf('='); useJar.set(pair.slice(0, split), pair.slice(split + 1)); }
        return { status: response.status, location: response.headers.get('location'), html: await response.text() };
    }
    const page = await request();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.html)[1];
    return { config, flows, workflow, diagnostics, strongPatient, request, csrf, jar, advance: value => { now += value; } };
}

test('browser cannot see demographics before OTP, steal another flow, replay OTP, or reuse an expired identity', async t => {
    const h = await harness(t);
    assert.equal((await h.request(`${BASE}/start`, { csrf: 'wrong' })).status, 303);
    const start = await h.request(`${BASE}/start`, { csrf: h.csrf, homeHmoId: h.config.healthOrganizations[0].dataSourceOrganization.id, system: h.strongPatient.system, identifier: h.strongPatient.value, birthDate: '1980-01-02' });
    assert.equal(start.status, 303);
    let page = await h.request(); assert.match(page.html, /Verify code/); assert.doesNotMatch(page.html, /Private family/);
    const local = await h.request(`${BASE}/local-code`, { csrf: h.csrf }); assert.equal(local.status, 303); const codePage = await h.request(); assert.match(codePage.html, /123456/); assert.match(codePage.html, /<details class="mt-3" open>/);
    const other = new Map([['pcmSystemFlow', h.jar.get('pcmSystemFlow')]]);
    const otherPage = await h.request(BASE, undefined, other); assert.doesNotMatch(otherPage.html, /<h2[^>]*>Verify code<|Private family/);
    assert.equal((await h.request(`${BASE}/verify`, { csrf: h.csrf, code: '123456' })).status, 303);
    page = await h.request(); assert.match(page.html, /Private family/);
    assert.equal((await h.request(`${BASE}/verify`, { csrf: h.csrf, code: '123456' })).status, 303);
    const provider = new BrowserAuthenticatedIdentityProvider(h.config.patients, h.flows);
    const browser = { headers: { cookie: [...h.jar].map(([k, v]) => `${k}=${v}`).join('; ') } };
    assert.deepEqual(provider.resolve('authenticated-self', browser), h.strongPatient);
    assert.equal(provider.resolve('authenticated-self', { headers: {} }), null);
    h.advance(h.config.systemAuthorization.authentication.authenticatedLifetimeSeconds);
    assert.equal(provider.resolve('authenticated-self', browser), null);
    assert.doesNotMatch((await h.request()).html, /Private family/);
});

test('dependent selection refreshes evidence and clears stale selection without approving Consent', async t => {
    const h = await harness(t);
    await h.request(`${BASE}/start`, { csrf: h.csrf, homeHmoId: h.config.healthOrganizations[0].dataSourceOrganization.id, system: h.strongPatient.system, identifier: h.strongPatient.value, birthDate: '1980-01-02' });
    await h.request(`${BASE}/verify`, { csrf: h.csrf, code: '123456' });
    const identifier = { ...h.strongPatient, value: '000000026' };
    let discoveries = 0;
    h.workflow.discover = async () => ({ status: 'complete', sources: [], dependents: ++discoveries === 1 ? [{ identifier, name: [], sources: [] }] : [] });
    assert.equal((await h.request(`${BASE}/discover`, { csrf: h.csrf })).status, 303);
    assert.equal((await h.request(`${BASE}/select`, { csrf: h.csrf, patient: `${identifier.system}|${identifier.value}` })).status, 303);
    assert.equal(discoveries, 2);
    assert.equal(h.flows.flows.values().next().value.selectedPatient, undefined);
    await h.request(`${BASE}/cancel`, { csrf: h.csrf });
    assert.equal(h.flows.flows.size, 0);
});

test('browser presence uses the verified identity and ignores caller-selected patient context', async t => {
    const h = await harness(t);
    assert.equal((await h.request(`${BASE}/presence`, { csrf: h.csrf })).status, 303);
    await h.request(`${BASE}/start`, { csrf: h.csrf, homeHmoId: h.config.healthOrganizations[0].dataSourceOrganization.id, system: h.strongPatient.system, identifier: h.strongPatient.value, birthDate: '1980-01-02' });
    await h.request(`${BASE}/verify`, { csrf: h.csrf, code: '123456' });
    let patients;
    const sourceId = h.config.healthOrganizations[0].dataSourceOrganization.id;
    h.workflow.presence = async values => { patients = values; return { status: 'partial', results: [{ identifier: values[0], sourceId, state: 'unknown', previouslyKnown: { state: 'present', checkedAt: 10 } }] }; };
    assert.equal((await h.request(`${BASE}/presence`, { csrf: h.csrf, patient: 'forged' })).status, 303);
    assert.deepEqual(patients, [h.strongPatient]);
    const page = await h.request();
    assert.match(page.html, /Record location checks: some could not be completed/);
    assert.match(page.html, /Previously known: present/);
    assert.ok(page.html.includes(`${h.strongPatient.value} · ${h.config.healthOrganizations[0].name} Data Source: Could not check`));
    const stored = h.flows.flows.values().next().value.presence.results[0];
    assert.equal(stored.sourceId, sourceId);
    assert.equal(stored.sourceLabel, undefined);
});

test('presence display labels known HOs and preserves unknown source labels and success state', async t => {
    const h = await harness(t);
    await h.request(`${BASE}/start`, { csrf: h.csrf, homeHmoId: h.config.healthOrganizations[0].dataSourceOrganization.id, system: h.strongPatient.system, identifier: h.strongPatient.value, birthDate: '1980-01-02' });
    await h.request(`${BASE}/verify`, { csrf: h.csrf, code: '123456' });
    h.workflow.presence = async () => ({ status: 'complete', results: [
        { identifier: h.strongPatient, sourceId: h.config.healthOrganizations[0].dataSourceOrganization.id, state: 'present' },
        { identifier: h.strongPatient, sourceId: 'unknown-source', state: 'absent' }
    ] });
    await h.request(`${BASE}/presence`, { csrf: h.csrf });
    const page = await h.request();
    assert.ok(page.html.includes(`${h.strongPatient.value} · ${h.config.healthOrganizations[0].name} Data Source: Records found`));
    assert.ok(page.html.includes(`${h.strongPatient.value} · unknown-source: No matching record found`));
});

test('authentication page binds help for every meaningful input and action', async t => {
    const h = await harness(t);
    const catalog = require('../../../scripts/generate-ui-help').parseCatalog(require('node:fs').readFileSync(path.resolve(__dirname, '../../../docs/ui-explanation-catalog.md'), 'utf8'));
    const verify = html => {
        assert.match(html, /data-help-team=/);
        assert.match(html, /assets\/help.js/);
        for (const tag of html.matchAll(/<(?:button|a|input|select|summary)\b[^>]*>/g)) {
            if (/type="hidden"/.test(tag[0])) continue;
            const key = /data-help-key="([^"]+)"/.exec(tag[0])?.[1];
            assert.ok(catalog[key], tag[0]);
        }
    };
    verify((await h.request()).html);
    await h.request(`${BASE}/start`, { csrf: h.csrf, homeHmoId: h.config.healthOrganizations[0].dataSourceOrganization.id, system: h.strongPatient.system, identifier: h.strongPatient.value, birthDate: '1980-01-02' });
    verify((await h.request()).html);
    await h.request(`${BASE}/verify`, { csrf: h.csrf, code: '123456' });
    verify((await h.request()).html);
});


test('successful and denied browser actions expose current flow diagnostics without stale identity', async t => {
    const h = await harness(t);
    assert.equal((await h.request(`${BASE}/discover`, { csrf: h.csrf })).status, 303);
    assert.equal(h.diagnostics.at(-1).state, 'denied');
    assert.equal(h.diagnostics.at(-1).action, 'discover');
    assert.equal(h.diagnostics.at(-1).flowId, undefined);
    await h.request(`${BASE}/start`, { csrf: h.csrf, homeHmoId: h.config.healthOrganizations[0].dataSourceOrganization.id, system: h.strongPatient.system, identifier: h.strongPatient.value, birthDate: '1980-01-02' });
    const id = h.diagnostics.at(-1).flowId;
    assert.ok(id);
    await h.request(`${BASE}/verify`, { csrf: h.csrf, code: '000000' });
    assert.equal(h.diagnostics.at(-1).state, 'denied');
    assert.equal(h.diagnostics.at(-1).flowId, id);
    await h.request(`${BASE}/verify`, { csrf: h.csrf, code: '123456' });
    assert.equal(h.diagnostics.at(-1).state, 'complete');
    assert.equal(h.diagnostics.at(-1).flowId, id);
});

/** Authenticate and select a fabricated dependent through the HTTP boundary. */
async function selectedBrowser(t) {
    const h = await harness(t);
    await h.request(`${BASE}/start`, { csrf: h.csrf, homeHmoId: h.config.healthOrganizations[0].dataSourceOrganization.id, system: h.strongPatient.system, identifier: h.strongPatient.value, birthDate: '1980-01-02' });
    await h.request(`${BASE}/verify`, { csrf: h.csrf, code: '123456' });
    h.child = { ...h.strongPatient, value: '000000026' };
    h.result = { status: 'complete', sources: [], dependents: [{ identifier: h.child, name: [], sources: [] }] };
    h.workflow.discover = async () => h.result;
    assert.equal((await h.request(`${BASE}/select`, { csrf: h.csrf, patient: `${h.child.system}|${h.child.value}` })).status, 303);
    h.flow = h.flows.flows.values().next().value;
    assert.deepEqual(h.flow.selectedPatient, h.child);
    assert.match((await h.request()).html, /Selected for this PCM test:/);
    return h;
}

for (const action of ['discover', 'presence-dependents', 'select']) {
    for (const outcome of ['empty', 'partial', 'throw']) {
        test(`REM-01 ${action} clears selection before ${outcome} refresh and never renders stale identity`, async t => {
            const h = await selectedBrowser(t);
            h.workflow.discover = async () => {
                assert.equal(h.flow.selectedPatient, undefined, 'clear before awaiting evidence');
                if (outcome === 'throw') throw new Error('source unavailable');
                return { status: outcome === 'partial' ? 'partial' : 'complete', sources: [{ sourceId: 'ho-a', state: 'unknown' }], dependents: [] };
            };
            h.workflow.presence = async () => ({ status: 'complete', results: [] });
            const response = await h.request(`${BASE}/${action}`, { csrf: h.csrf, patient: `${h.child.system}|${h.child.value}` });
            assert.equal(response.status, 303);
            assert.equal(h.flow.selectedPatient, undefined);
            assert.doesNotMatch((await h.request()).html, /Selected for this PCM test:/);
        });
    }
}

for (const later of ['discover', 'presence-dependents', 'cancel', 'start', 'expiry']) {
    test(`REM-01 delayed select cannot publish after later ${later}`, async t => {
        const h = await selectedBrowser(t);
        let release, entered;
        const waiting = new Promise(resolve => { entered = resolve; });
        let calls = 0;
        h.workflow.discover = async () => {
            if (++calls === 1) { entered(); return new Promise(resolve => { release = resolve; }); }
            return { status: 'complete', sources: [], dependents: [] };
        };
        h.workflow.presence = async () => ({ status: 'complete', results: [] });
        const older = h.request(`${BASE}/select`, { csrf: h.csrf, patient: `${h.child.system}|${h.child.value}` });
        await waiting;
        assert.equal(h.flow.selectedPatient, undefined);
        if (later === 'expiry') h.advance(h.config.systemAuthorization.authentication.authenticatedLifetimeSeconds);
        else await h.request(`${BASE}/${later}`, { csrf: h.csrf, homeHmoId: h.config.healthOrganizations[0].dataSourceOrganization.id, system: h.strongPatient.system, identifier: h.strongPatient.value, birthDate: '1980-01-02' });
        const accepted = h.flow.discovery;
        release(structuredClone(h.result));
        assert.equal((await older).status, 303);
        assert.equal(h.flow.selectedPatient, undefined);
        assert.equal(h.flow.discovery, accepted, 'old result never published');
        assert.doesNotMatch((await h.request()).html, /Selected for this PCM test:/);
    });
}

test('REM-01 partial verified results permit explicit reselection and refresh retains known presence', async t => {
    const h = await selectedBrowser(t);
    const sourceId = h.config.healthOrganizations[0].dataSourceOrganization.id;
    h.flow.presence = { status: 'complete', results: [{ sourceId, identifier: h.child, state: 'present', checkedAt: 10 }] };
    h.workflow.presence = async (patients, previous) => {
        assert.deepEqual(previous[`${sourceId}|${h.child.system}|${h.child.value}`], { state: 'present', checkedAt: 10 });
        return { status: 'partial', results: [{ sourceId, identifier: h.child, state: 'unknown', previouslyKnown: previous[`${sourceId}|${h.child.system}|${h.child.value}`] }] };
    };
    await h.request(`${BASE}/presence-dependents`, { csrf: h.csrf });
    assert.equal(h.flow.selectedPatient, undefined);
    assert.match((await h.request()).html, /Previously known: present/);
    h.result.status = 'partial';
    h.result.sources = [{ sourceId: 'ho-b', state: 'unknown' }];
    await h.request(`${BASE}/select`, { csrf: h.csrf, patient: `${h.child.system}|${h.child.value}` });
    assert.deepEqual(h.flow.selectedPatient, h.child);
    assert.match((await h.request()).html, /Selected for this PCM test:/);
});

test('REM-03 local code cannot be inspected or verified at exact expiry or after cancellation/replacement', async t => {
    const h = await harness(t);
    const start = () => h.request(`${BASE}/start`, { csrf: h.csrf, homeHmoId: h.config.healthOrganizations[0].dataSourceOrganization.id, system: h.strongPatient.system, identifier: h.strongPatient.value, birthDate: '1980-01-02' });
    await start();
    const firstId = h.jar.get('pcmSystemFlow');
    h.advance(h.config.systemAuthorization.otp.expirySeconds);
    assert.equal((await h.request(`${BASE}/local-code`, { csrf: h.csrf })).status, 303);
    assert.equal((await h.request(`${BASE}/verify`, { csrf: h.csrf, code: '123456' })).status, 303);
    assert.equal(h.workflow.transport.inspect(firstId), null);
    await start();
    const replacedId = h.jar.get('pcmSystemFlow');
    await start();
    assert.equal(h.workflow.transport.inspect(replacedId), null);
    await h.request(`${BASE}/cancel`, { csrf: h.csrf });
    assert.equal((await h.request(`${BASE}/local-code`, { csrf: h.csrf })).status, 303);
    assert.equal(h.workflow.transport.deliveries.size, 0);
});

test('REM-01 reordered selections retain only the newest explicitly verified patient', async t => {
    const h = await selectedBrowser(t);
    const newest = { ...h.child, value: '000000034' };
    let entered, release, calls = 0;
    const waiting = new Promise(resolve => { entered = resolve; });
    h.workflow.discover = async () => {
        if (++calls === 1) { entered(); return new Promise(resolve => { release = resolve; }); }
        return { status: 'complete', sources: [], dependents: [{ identifier: newest, name: [], sources: [] }] };
    };
    const older = h.request(`${BASE}/select`, { csrf: h.csrf, patient: `${h.child.system}|${h.child.value}` });
    await waiting;
    await h.request(`${BASE}/select`, { csrf: h.csrf, patient: `${newest.system}|${newest.value}` });
    release(h.result);
    assert.equal((await older).status, 303);
    assert.deepEqual(h.flow.selectedPatient, newest);
    const page = await h.request();
    assert.match(page.html, /Selected for this PCM test:/);
    assert.match(page.html, /000000034/);
    assert.doesNotMatch(page.html, /000000026/);
});

test('manual HMO form retains input, redirects failures safely and filters unavailable hospitals', async t => {
    const h = await harness(t);
    h.config.patients = [];
    h.config.systemAuthorization.memberships = [];
    const { getConfiguredDataSources } = require('../src/data-sources');
    const sources = getConfiguredDataSources(h.config);
    const sourceId = h.config.healthOrganizations[0].dataSourceOrganization.id;
    const data = { csrf: h.csrf, homeHmoId: sourceId, system: h.strongPatient.system, identifier: ' 000000018 ', birthDate: '1980-01-02invalid' };
    const failed = await h.request(`${BASE}/start`, data);
    assert.equal(failed.status, 303); assert.equal(failed.location, BASE);
    let page = await h.request();
    assert.match(page.html, /complete date of birth/); assert.match(page.html, /value="000000018"/);
    assert.equal(h.flows.flows.size, 0);
    assert.match(page.html, /configured-patient[^>]+disabled/);
    const accepted = await h.request(`${BASE}/start`, { ...data, birthDate: '1980-01-02' });
    assert.equal(accepted.location, BASE);
    assert.equal(h.flows.flows.size, 1, 'ordinary national ID needs no enrollment');
    await h.request(`${BASE}/cancel`, { csrf: h.csrf });
    for (const ho of h.config.healthOrganizations) ho.institutionType = 'hospital';
    // The managed source's explicit classification resides in dataSources when present.
    for (const source of getConfiguredDataSources(h.config)) assert.notEqual(source.institutionType, 'hmo');
    page = await h.request();
    assert.match(page.html, /No HMO is ready/); assert.match(page.html, /home-hmo[^>]+disabled/);
    await h.request(`${BASE}/start`, { ...data, birthDate: '1980-01-02' });
    assert.equal(h.flows.flows.size, 0, 'forged hospital target is revalidated');
});

test('a delayed earlier start cannot replace the newer browser flow or its local code', async t => {
    const h = await harness(t);
    let entered, release, calls = 0;
    const waiting = new Promise(resolve => { entered = resolve; });
    const normalRequest = h.workflow.request;
    h.workflow.request = async (...args) => {
        if (++calls === 1) { entered(); await new Promise(resolve => { release = resolve; }); }
        return normalRequest(...args);
    };
    const body = { csrf: h.csrf, homeHmoId: h.config.healthOrganizations[0].dataSourceOrganization.id, system: h.strongPatient.system, identifier: h.strongPatient.value, birthDate: '1980-01-02' };
    const older = h.request(`${BASE}/start`, body); await waiting;
    assert.equal((await h.request(`${BASE}/start`, body)).status, 303);
    const accepted = h.jar.get('pcmSystemFlow');
    release(); assert.equal((await older).status, 303);
    assert.equal(h.jar.get('pcmSystemFlow'), accepted);
    assert.equal(h.flows.flows.size, 1); assert.ok(h.flows.flows.has(accepted));
    assert.equal(h.workflow.transport.deliveries.size, 1);
    assert.match((await h.request()).html, /Waiting for verification code/);
});

test('form feedback is private to the browser binding and expires without extending authentication', async t => {
    const h = await harness(t); h.config.patients = [];
    await h.request(`${BASE}/start`, { csrf: h.csrf, homeHmoId: h.config.healthOrganizations[0].dataSourceOrganization.id, system: h.strongPatient.system, identifier: h.strongPatient.value, birthDate: 'bad-date' });
    assert.match((await h.request()).html, /complete date of birth/);
    const other = await h.request(BASE, undefined, new Map());
    assert.doesNotMatch(other.html, /Enter the complete date of birth|value="000000018"/);
    h.advance(600);
    assert.doesNotMatch((await h.request()).html, /Enter the complete date of birth|value="000000018"/);
    assert.equal(h.flows.flows.size, 0);
});


test('HMO entry rejects external returns and forged pending SMART handles', async t => {
    const h = await harness(t);
    assert.equal((await h.request(`${BASE}?returnUrl=https%3A%2F%2Fevil.test`)).status, 400);
    assert.equal((await h.request(`${BASE}?smart=forged`)).status, 400);
});

test('pending SMART form retains only its bound handle without corrupting action URLs', async t => {
    const h = await harness(t), page = await h.request(`${BASE}?smart=owned-continuation`);
    assert.equal(page.status, 200);
    assert.match(page.html, /action="\/sandbox\/authentication\/start"[^>]*>\s*<input type="hidden" name="smart" value="owned-continuation">/);
    assert.match(page.html, /authorize\/resume\?transaction_id=owned-continuation/);
    assert.doesNotMatch(page.html, /action="[^"]*<input/);
});

test('stale SMART sign-in tab cannot verify or cancel another tab current HMO flow', async t => {
    const h = await harness(t), start = smart => h.request(`${BASE}/start`, { csrf: h.csrf, smart,
        homeHmoId: h.config.healthOrganizations[0].dataSourceOrganization.id, system: h.strongPatient.system, identifier: h.strongPatient.value, birthDate: '1980-01-02' });
    await start('owned-continuation'); await start('second-continuation');
    const current = [...h.flows.flows.values()][0]; assert.equal(current.smartRequestId, 'second-continuation');
    await h.request(`${BASE}/verify`, { csrf: h.csrf, smart: 'owned-continuation', code: '123456' }); assert.equal(current.phase, 'authenticating');
    await h.request(`${BASE}/cancel`, { csrf: h.csrf, smart: 'owned-continuation' }); assert.equal(h.flows.flows.size, 1);
    const page = await h.request(`${BASE}?smart=owned-continuation`); assert.match(page.html, /Another tab owns/);
    await h.request(`${BASE}/verify`, { csrf: h.csrf, smart: 'second-continuation', code: '123456' }); assert.equal(current.phase, 'authenticated');
});
