'use strict';

/** Fake-clock qualification of home membership, OTP controls and dependent joins. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { NOW, dataGrantFixture } = require('../../../test-support/data-grants');
const { SystemFlowStore } = require('../src/system-flow-store');
const { SystemWorkflows, LocalOtpTransport, CONTACT_EVIDENCE, OTP_PURPOSE, PURPOSE_SYSTEM, selectOtpContact, joinDependents, continuationUrl } = require('../src/system-workflows');
const browserBinding = 'b'.repeat(40);

/** One marked, fresh contact from the explicitly fabricated local HMO fixture. */
function contact(now = NOW) {
    return { system: 'sms', value: '+972500000000', extension: [
        { url: OTP_PURPOSE, valueCodeableConcept: { coding: [{ system: PURPOSE_SYSTEM, code: 'OTP' }] } },
        { url: CONTACT_EVIDENCE, extension: [{ url: 'verifiedAt', valueDateTime: new Date(now * 1000).toISOString() }] }
    ] };
}

/** Create an injectable source and OTP channel without any external identity service. */
function harness() {
    const fixture = dataGrantFixture();
    for (const ho of fixture.config.healthOrganizations.slice(1)) ho.institutionType = 'other';
    const source = require('../src/data-sources').getConfiguredDataSources(fixture.config)[0];
    let now = NOW;
    let code = 123456;
    const flows = new SystemFlowStore(fixture.config, { clock: () => now });
    const transport = new LocalOtpTransport({ clock: () => now });
    const patient = { resourceType: 'Patient', id: 'representative', identifier: [fixture.strongPatient], birthDate: '1980-01-02', name: [{ family: 'Synthetic' }], telecom: [contact()] };
    const sourceResponse = { resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ resource: patient }] };
    const logs = [];
    const workflow = new SystemWorkflows({ logger: { info: (message, details) => logs.push({ message, ...details }) }, config: fixture.config, flows, clock: () => now, codeGenerator: () => String(code++), transport,
        request: async (source, request) => {
            assert.equal(source.id, fixture.source.dataSourceOrganization.id);
            assert.equal(request.headers.Prefer, 'handling=strict');
            assert.equal(new URL(request.url).searchParams.get('_elements'), 'identifier,name,telecom,birthDate');
            return sourceResponse;
        } });
    return { ...fixture, source, flows, workflow, transport, logs, patient, sourceResponse, advance: seconds => { now += seconds; }, input: { homeHmoId: source.id, identifier: fixture.strongPatient, birthDate: patient.birthDate, browserBinding } };
}

test('home-HMO identity match and OTP succeed once with browser-bound private evidence', async () => {
    const h = harness();
    const started = await h.workflow.authenticate(h.input);
    assert.deepEqual(Object.keys(started).sort(), ['flowId', 'status', 'transport']);
    assert.throws(() => h.workflow.verify(started.flowId, 'other-browser', '123456'), /unavailable/);
    const authenticated = h.workflow.verify(started.flowId, browserBinding, '123456');
    assert.equal(authenticated.status, 'authenticated');
    assert.deepEqual(authenticated.identifier, h.strongPatient);
    assert.throws(() => h.workflow.verify(started.flowId, browserBinding, '123456'), /unavailable/);
    const clientId = h.config.oauthClients.discoveryOrchestrator.clientId;
    h.flows.bindAssertion(started.flowId, clientId, 'fresh-jti');
    assert.equal(h.flows.consumeAssertion(clientId, 'fresh-jti').phase, 'authenticated');
    assert.equal(h.flows.consumeAssertion(clientId, 'fresh-jti'), null);
    h.advance(h.config.systemAuthorization.authentication.authenticatedLifetimeSeconds);
    assert.equal(h.flows.invocation(started.flowId, clientId), null);
});

test('unmarked, stale, ambiguous, disabled-channel and unasserted phone contacts fail closed', () => {
    const h = harness();
    const settings = h.config.systemAuthorization.otp;
    assert.equal(selectOtpContact(h.patient, settings, NOW).channel, 'sms');
    for (const telecom of [[{ system: 'sms', value: 'unmarked' }], [contact(NOW - settings.contactMaxAgeSeconds - 1)], [contact(), contact()], [{ ...contact(), system: 'email' }], [{ ...contact(), system: 'phone', use: 'mobile' }]]) {
        assert.throws(() => selectOtpContact({ telecom }, settings, NOW));
    }
    const phone = { ...contact(), system: 'phone', use: 'mobile' };
    phone.extension[1].extension.push({ url: 'smsUsable', valueBoolean: true });
    assert.equal(selectOtpContact({ telecom: [phone] }, settings, NOW).channel, 'sms');
});

test('failed identity/DOB/Hospital target never sends OTP or returns retrieved demographics', async () => {
    for (const mutate of [h => { h.sourceResponse.entry.push(h.sourceResponse.entry[0]); }, h => { h.patient.birthDate = '1981-01-02'; }, h => { h.config.healthOrganizations[0].institutionType = 'hospital'; }, h => { h.patient.identifier = []; }]) {
        const h = harness(); mutate(h);
        await assert.rejects(h.workflow.authenticate(h.input));
        assert.equal(h.transport.deliveries.size, 0);
    }
    const h = harness();
    await assert.rejects(h.workflow.authenticate({ ...h.input, identifier: { system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '1' } }));
});

test('resend invalidates earlier code, retains attempt budget and exact expiry fails', async () => {
    const h = harness();
    const { flowId } = await h.workflow.authenticate(h.input);
    await assert.rejects(h.workflow.resend(flowId, browserBinding));
    h.advance(h.config.systemAuthorization.otp.resendSeconds);
    await h.workflow.resend(flowId, browserBinding);
    assert.throws(() => h.workflow.verify(flowId, browserBinding, '123456'));
    assert.equal(h.workflow.verify(flowId, browserBinding, '123457').status, 'authenticated');
    const expired = harness();
    const started = await expired.workflow.authenticate(expired.input);
    expired.advance(expired.config.systemAuthorization.otp.expirySeconds);
    assert.throws(() => expired.workflow.verify(started.flowId, browserBinding, '123456'));
    const attempts = harness();
    const active = await attempts.workflow.authenticate(attempts.input);
    for (let i = 0; i < attempts.config.systemAuthorization.otp.maxAttempts; i++) assert.throws(() => attempts.workflow.verify(active.flowId, browserBinding, '000000'));
    assert.throws(() => attempts.workflow.verify(active.flowId, browserBinding, '123456'));
});

test('dependent join requires the same active record, explicit relationship and same-source reference', () => {
    const h = harness();
    const patient = { resourceType: 'Patient', id: 'child', identifier: [{ ...h.strongPatient, value: '000000026' }], name: [{ given: ['Synthetic child'] }] };
    const eligible = [{ system: 'http://example.test/relationship', code: 'parent' }];
    const related = { resourceType: 'RelatedPerson', id: 'relationship', identifier: [h.strongPatient], active: true,
        relationship: [{ coding: eligible }], patient: { reference: 'Patient/child' } };
    const join = values => joinDependents([patient], values, h.strongPatient, eligible, h.source.endpoint);
    assert.equal(join([related]).length, 1);
    assert.equal(join([{ ...related, active: false }, { ...related, identifier: [{ ...h.strongPatient, value: '000000026' }] }]).length, 0);
    assert.equal(join([{ ...related, active: undefined }]).length, 0);
    assert.equal(join([{ ...related, patient: { reference: 'https://other.test/fhir/Patient/child' } }]).length, 0);
    assert.equal(join([{ ...related, relationship: [{ coding: [{ system: 'unknown', code: 'parent' }] }] }]).length, 0);
    assert.equal(continuationUrl(h.source.endpoint, `${h.source.endpoint}?_getpages=opaque`, 'Patient'), `${h.source.endpoint}?_getpages=opaque`);
    for (const link of ['https://other.test/fhir?_getpages=x', `${h.source.endpoint}/../Patient?x=1`, `${h.source.endpoint}/Observation?x=1`]) assert.throws(() => continuationUrl(h.source.endpoint, link, 'Patient'));
});

test('discovery pages both streams independently and reports partial sources without inventing results', async () => {
    const h = harness();
    h.config.healthOrganizations[1].institutionType = 'hmo';
    h.config.systemAuthorization.discovery.eligibleRelationships = [{ system: 'http://example.test/relationship', code: 'parent' }];
    const { flowId } = await h.workflow.authenticate(h.input);
    h.workflow.verify(flowId, browserBinding, '123456');
    const child = { resourceType: 'Patient', id: 'child', identifier: [{ ...h.strongPatient, value: '000000026' }] };
    const related = { resourceType: 'RelatedPerson', id: 'relationship', identifier: [h.strongPatient], patient: { reference: 'Patient/child' }, active: true,
        relationship: [{ coding: h.config.systemAuthorization.discovery.eligibleRelationships }] };
    const page = (entry = [], next) => ({ resourceType: 'Bundle', type: 'searchset', entry: entry.map(resource => ({ resource })), ...(next ? { link: [{ relation: 'next', url: next }] } : {}) });
    const calls = [];
    h.workflow.request = async (source, operation) => {
        calls.push(operation.url);
        if (source.id !== h.source.id) return { resourceType: 'Bundle', type: 'batch-response', entry: [{ response: { status: '500' } }, { response: { status: '200' }, resource: page() }] };
        if (operation.method === 'POST') return { resourceType: 'Bundle', type: 'batch-response', entry: [
            { response: { status: '200' }, resource: page([], `${source.endpoint}/Patient?_getpages=patients`) },
            { response: { status: '200' }, resource: page([], `${source.endpoint}/RelatedPerson?_getpages=relationships`) }
        ] };
        return operation.url.includes('RelatedPerson') ? page([related]) : page([child]);
    };
    const result = await h.workflow.discover(flowId, browserBinding);
    assert.equal(result.status, 'partial');
    assert.equal(result.dependents.length, 1);
    assert.deepEqual(result.sources.map(source => source.state), ['complete', 'unknown']);
    assert.equal(calls.filter(url => url.includes('_getpages=')).length, 2);
});

test('presence associates each batch entry and preserves old state for failed or malformed counts', async () => {
    const h = harness();
    const patients = [h.patient.identifier[0], { system: 'http://fhir.health.gov.il/identifier/il-hdp-test-id', value: '2' }];
    h.config.systemAuthorization.presenceEligiblePatients = patients;
    h.workflow.request = async (source, request) => {
        assert.equal(request.body.entry.length, 2);
        assert.match(request.body.entry[0].request.url, /_summary=count/);
        return { resourceType: 'Bundle', type: 'batch-response', entry: [
            { response: { status: '200' }, resource: { resourceType: 'Bundle', type: 'searchset', total: 1 } },
            { response: { status: '500' }, resource: { resourceType: 'OperationOutcome' } }
        ] };
    };
    const result = await h.workflow.presence(patients);
    assert.equal(result.status, 'partial');
    assert.ok(result.results.filter(item => item.identifier.value === '1').every(item => item.state === 'present'));
    assert.ok(result.results.filter(item => item.identifier.value === '2').every(item => item.state === 'unknown'));
    await assert.rejects(h.workflow.presence([...patients, patients[0]]));
});


test('successful delivery and denied OTP retain correlated full sandbox diagnostics', async () => {
    const h = harness();
    const started = await h.workflow.authenticate(h.input);
    assert.throws(() => h.workflow.verify(started.flowId, browserBinding, '000000'));
    const sent = h.logs.find(entry => entry.type === 'SYSTEM_OTP' && entry.state === 'sent');
    const denied = h.logs.find(entry => entry.type === 'SYSTEM_OTP' && entry.state === 'denied');
    assert.equal(sent.flowId, started.flowId);
    assert.equal(denied.flowId, sent.flowId);
    assert.equal(sent.sourceId, h.source.id);
    assert.equal(sent.code, '123456');
    assert.equal(denied.submittedCode, '000000');
    assert.equal(denied.attempts, 1);
    assert.equal(sent.conformanceException, 'PCM-SANDBOX-FULL-DIAGNOSTICS');
});

test('enabled email is explicit and contact validity is start-inclusive/end-exclusive', () => {
    const h = harness();
    const email = { ...contact(), system: 'email', value: 'synthetic@example.invalid' };
    const settings = { ...h.config.systemAuthorization.otp, channels: ['email'] };
    assert.equal(selectOtpContact({ telecom: [email] }, settings, NOW).channel, 'email');
    const at = seconds => new Date(seconds * 1000).toISOString();
    assert.equal(selectOtpContact({ telecom: [{ ...email, period: { start: at(NOW), end: at(NOW + 1) } }] }, settings, NOW).channel, 'email');
    for (const period of [{ start: at(NOW + 1) }, { end: at(NOW) }, { end: 'invalid' }]) {
        assert.throws(() => selectOtpContact({ telecom: [{ ...email, period }] }, settings, NOW));
    }
});

test('failed discovery pages, cycles, deadlines and expired authentication remain unknown', async () => {
    for (const failure of ['page-error', 'cycle', 'timeout', 'expired', 'cross-source']) {
        const h = harness();
        const { flowId } = await h.workflow.authenticate(h.input);
        h.workflow.verify(flowId, browserBinding, '123456');
        const next = `${h.source.endpoint}/Patient?_getpages=patients`;
        const page = { resourceType: 'Bundle', type: 'searchset', entry: [], link: [{ relation: 'next', url: failure === 'cross-source' ? 'https://other.test/fhir?_getpages=x' : next }] };
        h.workflow.request = async (source, operation) => {
            if (operation.method === 'POST') {
                if (failure === 'timeout') h.advance(Math.ceil(h.config.systemAuthorization.discovery.timeoutMilliseconds / 1000));
                if (failure === 'expired') h.advance(h.config.systemAuthorization.authentication.authenticatedLifetimeSeconds);
                return { resourceType: 'Bundle', type: 'batch-response', entry: [
                    { response: { status: '200' }, resource: page },
                    { response: { status: '200' }, resource: { resourceType: 'Bundle', type: 'searchset', entry: [] } }
                ] };
            }
            if (failure === 'page-error') throw new Error('page unavailable');
            return page;
        };
        const result = await h.workflow.discover(flowId, browserBinding);
        assert.equal(result.status, 'partial', failure);
        assert.deepEqual(result.dependents, [], failure);
        assert.ok(result.sources.every(source => source.state === 'unknown'), failure);
    }
});

test('a racing relationship join is refreshed once and never invents a missing Patient', async () => {
    const h = harness();
    const { flowId } = await h.workflow.authenticate(h.input);
    h.workflow.verify(flowId, browserBinding, '123456');
    let attempts = 0;
    h.workflow.discoverySource = async () => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('changed page evidence'), { code: 'RACING_JOIN' });
        return [];
    };
    assert.equal((await h.workflow.discover(flowId, browserBinding)).status, 'complete');
    assert.equal(attempts, 2);
    attempts = 0;
    h.workflow.discoverySource = async () => { attempts++; throw Object.assign(new Error('still missing'), { code: 'RACING_JOIN' }); };
    const result = await h.workflow.discover(flowId, browserBinding);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.dependents, []);
    assert.equal(attempts, 2);
});

/** Empty independent streams with an optional Patient continuation. */
function discoveryBatch(next) {
    const page = { resourceType: 'Bundle', type: 'searchset', entry: [] };
    return { resourceType: 'Bundle', type: 'batch-response', entry: [
        { response: { status: '200' }, resource: { ...page, ...(next ? { link: [{ relation: 'next', url: next }] } : {}) } },
        { response: { status: '200' }, resource: page }
    ] };
}

for (const scenario of ['29+29', 'boundary', 'racing-join', 'flow-expiry', 'both-streams']) {
    test(`REM-02 one source deadline includes ${scenario} and other sources keep their budget`, async () => {
        const h = harness();
        h.config.systemAuthorization.discovery.timeoutMilliseconds = 30000;
        for (const ho of h.config.healthOrganizations) ho.institutionType = 'hmo';
        h.config.systemAuthorization.discovery.eligibleRelationships = [{ system: 'http://example.test/relationship', code: 'parent' }];
        const { flowId } = await h.workflow.authenticate(h.input);
        h.workflow.verify(flowId, browserBinding, '123456');
        const calls = [];
        h.workflow.request = async (source, operation) => {
            calls.push({ source: source.id, deadline: operation.deadlineMilliseconds, method: operation.method });
            if (source.id !== h.source.id) return discoveryBatch();
            if (scenario === 'flow-expiry') h.advance(h.config.systemAuthorization.authentication.authenticatedLifetimeSeconds);
            else if (scenario === 'boundary') h.advance(30);
            else if (scenario === 'racing-join') {
                h.advance(29);
                const batch = discoveryBatch();
                batch.entry[1].resource.entry = [{ resource: { resourceType: 'RelatedPerson', id: 'r', identifier: [h.strongPatient], active: true,
                    relationship: h.config.systemAuthorization.discovery.eligibleRelationships.map(coding => ({ coding: [coding] })), patient: { reference: 'Patient/missing' } } }];
                return batch;
            } else h.advance(scenario === 'both-streams' ? 11 : 29);
            if (operation.method === 'GET') return discoveryBatch().entry[0].resource;
            const batch = discoveryBatch(`${source.endpoint}/Patient?_getpages=p`);
            if (scenario === 'both-streams') batch.entry[1].resource.link = [{ relation: 'next', url: `${source.endpoint}/RelatedPerson?_getpages=r` }];
            return batch;
        };
        const result = await h.workflow.discover(flowId, browserBinding);
        assert.equal(result.status, 'partial');
        assert.equal(result.sources[0].state, 'unknown');
        const first = calls.filter(call => call.source === h.source.id);
        assert.equal(new Set(first.map(call => call.deadline)).size, 1);
        assert.equal(first.length, scenario === 'boundary' || scenario === 'flow-expiry' ? 1 : scenario === 'both-streams' ? 3 : 2);
        if (scenario !== 'flow-expiry') assert.ok(result.sources.slice(1).every(source => source.state === 'complete'));
        else assert.equal(calls.length, 1, 'expired flow issues no requests to later sources');
    });
}

test('REM-02 millisecond boundary rejects a racing retry before any new request', async () => {
    const h = harness();
    h.config.systemAuthorization.discovery.timeoutMilliseconds = 1;
    const { flowId } = await h.workflow.authenticate(h.input);
    h.workflow.verify(flowId, browserBinding, '123456');
    let now = NOW * 1000, calls = 0;
    h.workflow.clockMilliseconds = () => now;
    h.workflow.discoverySource = async () => {
        calls++; now++;
        throw Object.assign(new Error('raced'), { code: 'RACING_JOIN' });
    };
    const result = await h.workflow.discover(flowId, browserBinding);
    assert.equal(result.sources[0].state, 'unknown');
    assert.equal(calls, 1);
});

/** Deterministic expiry scheduler: advancing time runs idle reclamation without inspection. */
function scheduledTransport(clock) {
    const pending = new Map();
    let next = 0;
    const transport = new LocalOtpTransport({ clock, schedule: (callback, milliseconds) => {
        const id = ++next; pending.set(id, { callback, at: clock() + milliseconds / 1000 }); return id;
    }, unschedule: id => pending.delete(id) });
    return { transport, pending, sweep: () => {
        for (const [id, task] of [...pending]) if (task.at <= clock()) { pending.delete(id); task.callback(); }
    } };
}

for (const disposal of ['otp-expiry', 'flow-expiry', 'cancel', 'success', 'exhaustion', 'send-failure', 'source-failure', 'dispose']) {
    test(`REM-03 ${disposal} reclaims only owned deliveries and permits duplicate cleanup`, async () => {
        const h = harness();
        let now = NOW;
        const scheduled = scheduledTransport(() => now);
        h.transport = h.workflow.transport = scheduled.transport;
        h.flows.registerCleanup(h.transport);
        const { flowId } = await h.workflow.authenticate(h.input);
        await h.transport.send({ flowId: 'unrelated', code: '654321', expiresAt: NOW + 100000 });
        assert.equal(h.transport.inspect(flowId).code, '123456');
        if (disposal === 'otp-expiry') { now += h.config.systemAuthorization.otp.expirySeconds; scheduled.sweep(); }
        if (disposal === 'flow-expiry') { h.advance(h.config.systemAuthorization.authentication.flowLifetimeSeconds); h.flows.prune(); }
        if (disposal === 'cancel') h.flows.cancel(flowId);
        if (disposal === 'dispose') h.flows.dispose();
        if (disposal === 'success') h.workflow.verify(flowId, browserBinding, '123456');
        if (disposal === 'exhaustion') for (let i = 0; i < h.config.systemAuthorization.otp.maxAttempts; i++) assert.throws(() => h.workflow.verify(flowId, browserBinding, '000000'));
        if (disposal === 'send-failure') {
            h.advance(h.config.systemAuthorization.otp.resendSeconds);
            h.transport.send = async () => { throw new Error('delivery failed'); };
            await assert.rejects(h.workflow.resend(flowId, browserBinding));
        }
        if (disposal === 'source-failure') {
            h.flows.cancel(flowId);
            h.workflow.request = async () => { throw new Error('source failed'); };
            await assert.rejects(h.workflow.authenticate(h.input));
        }
        assert.equal(h.transport.inspect(flowId), null);
        assert.equal(h.transport.deliveries.size, 1);
        h.flows.cancel(flowId); h.transport.clear(flowId);
        assert.equal(h.transport.inspect('unrelated').code, '654321');
        assert.equal(scheduled.pending.size, 1);
        h.transport.dispose();
    });
}

test('REM-03 abandoned deliveries expire without access and repeated wrappers register cleanup once', async () => {
    const h = harness();
    let now = NOW;
    const scheduled = scheduledTransport(() => now);
    h.workflow.transport = scheduled.transport;
    h.flows.registerCleanup(scheduled.transport);
    for (let i = 0; i < 25; i++) await h.workflow.authenticate({ ...h.input, browserBinding: `independent-browser-binding-with-sufficient-length-${i}` });
    assert.equal(scheduled.transport.deliveries.size, 25);
    now += h.config.systemAuthorization.otp.expirySeconds;
    scheduled.sweep();
    assert.equal(scheduled.transport.deliveries.size, 0);
    assert.equal(scheduled.pending.size, 0);
    const owners = h.flows.cleanupOwners.size;
    for (let i = 0; i < 25; i++) new SystemWorkflows({ config: h.config, flows: h.flows, transport: scheduled.transport });
    assert.equal(h.flows.cleanupOwners.size, owners);
});

test('REM-03 delayed asynchronous send cannot recreate cancelled or expired state', async () => {
    for (const disposal of ['cancel', 'expiry']) {
        const h = harness();
        let enter, release;
        const entered = new Promise(resolve => { enter = resolve; });
        const original = h.transport.send.bind(h.transport);
        h.transport.send = async delivery => { enter(); await new Promise(resolve => { release = resolve; }); await original(delivery); };
        const authentication = h.workflow.authenticate(h.input);
        await entered;
        const id = h.flows.flows.keys().next().value;
        if (disposal === 'cancel') h.flows.cancel(id);
        else { h.advance(h.config.systemAuthorization.authentication.flowLifetimeSeconds); h.flows.prune(); }
        release();
        await assert.rejects(authentication);
        assert.equal(h.transport.deliveries.size, 0);
        assert.equal(h.transport.timers.size, 0);
    }
});

test('REM-02 29-second batch plus 29-second continuation cancels at the shared 30-second deadline', async () => {
    const h = harness();
    const { flowId } = await h.workflow.authenticate(h.input);
    h.workflow.verify(flowId, browserBinding, '123456');
    h.config.systemAuthorization.discovery.timeoutMilliseconds = 30000;
    let now = NOW * 1000;
    h.workflow.clockMilliseconds = () => now;
    const budgets = [];
    h.workflow.request = async (source, operation) => {
        const remaining = operation.deadlineMilliseconds === undefined ? 30000 : operation.deadlineMilliseconds - now;
        budgets.push(remaining);
        const elapsed = Math.min(29000, remaining);
        now += elapsed;
        h.advance(elapsed / 1000);
        if (remaining <= 29000) throw Object.assign(new Error('transport deadline'), { code: 'ETIMEDOUT' });
        return operation.method === 'POST' ? discoveryBatch(`${source.endpoint}/Patient?_getpages=p`) : discoveryBatch().entry[0].resource;
    };
    const result = await h.workflow.discover(flowId, browserBinding);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.dependents, []);
    assert.deepEqual(budgets, [30000, 1000]);
    assert.equal(now - NOW * 1000, 30000);
});

test('REM-03 delivery becomes unavailable at exact owning flow expiry after store pruning', async () => {
    const h = harness();
    const { flowId } = await h.workflow.authenticate(h.input);
    h.advance(h.config.systemAuthorization.authentication.flowLifetimeSeconds);
    h.flows.prune();
    assert.equal(h.transport.inspect(flowId), null);
    assert.equal(h.transport.deliveries.size, 0);
});

test('REM-03 resend replaces storage while preserving failed attempts and another team remains live', async () => {
    const h = harness(), other = harness();
    h.config.systemAuthorization.otp.maxAttempts = 2;
    const { flowId } = await h.workflow.authenticate(h.input);
    const live = await other.workflow.authenticate(other.input);
    assert.throws(() => h.workflow.verify(flowId, browserBinding, '000000'));
    h.advance(h.config.systemAuthorization.otp.resendSeconds);
    await h.workflow.resend(flowId, browserBinding);
    assert.equal(h.transport.deliveries.size, 1);
    assert.equal(h.transport.inspect(flowId).code, '123457');
    assert.equal(h.flows.flows.get(flowId).attempts, 1);
    assert.throws(() => h.workflow.verify(flowId, browserBinding, '123456'));
    assert.equal(h.transport.deliveries.size, 0);
    assert.throws(() => h.workflow.verify(flowId, browserBinding, '123457'));
    assert.equal(other.transport.inspect(live.flowId).code, '123456');
    assert.equal(other.workflow.verify(live.flowId, browserBinding, '123456').status, 'authenticated');
});
