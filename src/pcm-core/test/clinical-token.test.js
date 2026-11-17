'use strict';

/** Exact approval ownership and independent eligibility/window decisions. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { clinicalTokenFixture, EXACT, V } = require('../../../test-support/clinical-token-fixture');
const { NOW, rar } = require('../../../test-support/data-grants');
const { createTokenService } = require('../src/token-service');
const { evaluateSubjectToken } = require('../src/introspection-service');
const { resolveGrant } = require('../src/data-grant');
const { FileFirstUseWindowStore } = require('../src/state-store');
const { firstUseKey } = require('../src/clinical-first-use');
const { readApprovalSnapshot } = require('../../shared/consent-scope-snapshot');
const { IDENTIFIER_SYSTEMS } = require('../../shared/pcm-contract');

/** Exercise real decision services with a mutable clock and owned durable usage. */
function harness(t, options = {}) {
    const f = clinicalTokenFixture(options);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clinical-token-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    f.firstUseStore = new FileFirstUseWindowStore(directory);
    const records = [];
    let now = options.now || NOW, client = f.client;
    const clients = new Map([[client.clientId, client]]);
    for (const source of f.config.healthOrganizations) clients.set(source.clientId, { clientId: source.clientId,
        role: 'data-source', organizationId: source.dataSourceOrganization.id });
    const service = createTokenService({ fhirStore: f.store, firstUseStore: f.firstUseStore,
        tokenStore: { issue(kind, claims, lifetime) { const record = structuredClone({ ...claims, kind, iat: now, exp: now + lifetime }); records.push(record); return { token: `opaque-${records.length}`, record }; } },
        authenticate: req => { req.mtls = { thumbprint: client.mtlsThumbprint }; return { client, transportVerified: true, signatureVerified: true, assertionSigningThumbprint: client.assertionThumbprint }; },
        getConfig: () => f.config, getIssuer: () => f.config.contract.operational.fhirBase,
        getPolicy: () => ({}), getLifetime: () => 86400, clock: () => now, logger: { info() {}, warn() {} } });
    const issue = (changes = {}) => service({ body: { grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: 'owned-test-double', scope: f.request.scope, resource: f.source.endpoint,
        authorization_details: JSON.stringify(rar('Consent', f.consent.identifier[0].value).details), ...changes } });
    const evaluate = (record = records.at(-1), source = f.source, extra = {}) => evaluateSubjectToken({ token: record,
        caller: { clientId: source.clientId, organizationId: source.dataSourceOrganization.id },
        store: f.store, config: f.config, firstUseStore: f.firstUseStore, now,
        findClient: id => clients.get(id), ...extra });
    return { ...f, directory, records, clients, issue, evaluate, time: value => { now = value; },
        useClient(value) { client = value; clients.set(client.clientId, client); } };
}

test('clinical services never call compiler; manual unions, different patients, clocks and sources remain exact', t => {
    const f = harness(t);
    const compiler = require('../src/grant-compiler'), original = compiler.compileConsentScope;
    compiler.compileConsentScope = () => { throw new Error('Clinical compiler was called'); };
    t.after(() => { compiler.compileConsentScope = original; });
    for (const patient of [{ system: IDENTIFIER_SYSTEMS.israelNationalId, value: '000000018' }, { system: IDENTIFIER_SYSTEMS.palestinianNationalId, value: '987654321' }]) {
        const consent = f.approve(patient);
        for (const source of f.config.healthOrganizations.slice(0, 2)) for (const offset of [0, 10000]) {
            f.time(NOW + offset);
            const response = f.issue({ authorization_details: JSON.stringify(rar('Consent', consent.identifier[0].value).details), resource: source.endpoint });
            assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.scope, EXACT);
            const active = f.evaluate(f.records.at(-1), source); assert.ok(active); assert.equal(active.scope, EXACT);
            assert.deepEqual(active.authorization_details, response.body.authorization_details);
            assert.deepEqual(active.authorization_details[0].fhirContext.find(item => item.type === 'Patient').identifier, patient);
        }
    }
    assert.equal(fs.readdirSync(f.directory).length, 0);
});

test('well-formed Consent request actions are advisory; mixed families and caller filters reject atomically', t => {
    const f = harness(t, { mode: 'one-time' });
    for (const scope of [f.request.scope, `${f.request.scope} patient/Condition.rs`, 'patient/Observation.rs',
        'patient/Patient.rs patient/Observation.s patient/Encounter.s', 'patient/Patient.rs patient/Observation.rs',
        `${f.request.scope} patient/Unknown.rs`, `${f.request.scope} patient/Organization.s`]) {
        assert.equal(f.issue({ scope }).body.scope, EXACT);
    }
    const before = f.records.length;
    for (const scope of ['system/Patient.rs', 'patient/Patient.rs system/Observation.s', 'patient/Observation.s?status=final']) {
        const response = f.issue({ scope }); assert.equal(response.status, 400); assert.equal(response.body.error, 'invalid_scope');
    }
    assert.equal(f.records.length, before); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('selected approval can exceed experimental default; retired full-access configuration cannot authorize introspection', t => {
    const f = harness(t);
    const canonical = f.store.get('HealthcareService', require('../src/fhir/healthcare-service-lifecycle').basedOnId(f.service));
    require('../../../test-support/private-definition').replaceDefinition(f.store, canonical, { name: 'Experimental default', purpose: 'Diagnostic only', category: '35',
        accessMode: 'continuous', duration: 1, durationUnit: 'a', allowChanges: false,
        buckets: [{ code: 'laboratoryTests', history: 1, historyUnit: 'a', sensitivity: [] }], permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 's' }],
        scopeOrigin: 'custom', approvalScope: `patient/Patient.rs?${V} patient/DocumentReference.s?${V}` }, { now: NOW });
    const consent = f.approve();
    assert.equal(f.store.privateRecords.approvals.getDecision(consent.id).snapshot.service.grant.diagnostics.capability, 'unsupported');
    const response = f.issue({ authorization_details: JSON.stringify(rar('Consent', consent.identifier[0].value).details) });
    assert.equal(response.status, 200); assert.equal(response.body.scope, EXACT); assert.equal(f.evaluate().scope, EXACT);
    f.config.sandbox.grantFullClinicalAccess = true;
    assert.throws(() => f.evaluate(), /retired/);
});

test('missing/unsupported snapshots and corrupted retained grants deny without token or first-use publication', t => {
    const f = harness(t, { mode: 'one-time' });
    const legacy = f.store.get('Consent', 'consent-test');
    for (const consent of [legacy, f.approve(undefined, '  unsupported  '), f.approve(undefined, `patient/Patient.rs?${V} patient/DocumentReference.s?${V}`)]) {
        const response = f.issue({ authorization_details: JSON.stringify(rar('Consent', consent.identifier[0].value).details) });
        assert.equal(response.body.error, 'invalid_scope');
    }
    assert.equal(f.records.length, 0); assert.deepEqual(fs.readdirSync(f.directory), []);
    assert.equal(f.issue().status, 200);
    const retained = f.records[0], original = structuredClone(retained);
    for (const mutate of [record => { record.scope += ' patient/Condition.s'; }, record => { record.authorization.scope += ' patient/Condition.s'; },
        record => { record.authorization.approvalSnapshot.scope = 'forged'; }, record => { record.authorization_details[0].fhirContext[0].identifier.value = 'forged'; },
        record => { record.authorization.version = 'pcm-data-grant/5'; }]) {
        const next = structuredClone(retained); mutate(next); assert.equal(f.evaluate(next), null);
    }
    assert.deepEqual(f.records[0], original); assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('response budgets and rejected introspections never consume a first-use window', t => {
    const f = harness(t, { mode: 'one-time' });
    f.config.presence.batch.maxResponseBytes = 50;
    assert.equal(f.issue().body.error, 'invalid_authorization_details'); assert.equal(f.records.length, 0);
    f.config.presence.batch.maxResponseBytes = 262144; assert.equal(f.issue().status, 200);
    const record = f.records[0];
    assert.equal(f.evaluate({ ...record, aud: 'https://wrong.example/fhir' }), null);
    assert.equal(f.evaluate(record, f.config.healthOrganizations[1]), null);
    f.config.presence.batch.maxResponseBytes = 50; assert.equal(f.evaluate(record), null);
    assert.deepEqual(fs.readdirSync(f.directory), []);
    f.config.presence.batch.maxResponseBytes = 262144; assert.ok(f.evaluate(record));
});

test('one-time tuples share deadlines across tokens/retries/credential rotation while clients and sources separate', t => {
    const f = harness(t, { mode: 'one-time' });
    assert.equal(f.issue().status, 200); assert.equal(f.issue().status, 200); assert.deepEqual(fs.readdirSync(f.directory), []);
    assert.equal(f.evaluate(f.records[0]).exp, NOW + 30);
    f.time(NOW + 10); assert.equal(f.evaluate(f.records[1]).scope, EXACT);
    const key = firstUseKey(f.service.id, f.consent.id, f.client.clientId, f.source.dataSourceOrganization.id);
    const bytes = fs.readFileSync(path.join(f.directory, require('../src/state-store').recordName(key)), 'utf8');
    f.useClient({ ...f.client, mtlsThumbprint: 'C'.repeat(43), assertionThumbprint: 'D'.repeat(43) });
    assert.equal(f.issue().body.expires_in, 3590); assert.ok(f.evaluate());
    assert.equal(fs.readFileSync(path.join(f.directory, require('../src/state-store').recordName(key)), 'utf8'), bytes);
    f.useClient({ ...f.client, clientId: 'second-application-same-provider' });
    assert.equal(f.issue().body.expires_in, 86400); assert.ok(f.evaluate());
    const second = f.config.healthOrganizations[1];
    assert.equal(f.issue({ resource: second.endpoint }).body.expires_in, 86400); assert.ok(f.evaluate(f.records.at(-1), second));
    assert.equal(fs.readdirSync(f.directory).length, 3);
    f.useClient(f.client); f.time(NOW + 3599);
    assert.equal(f.issue().body.expires_in, 1); assert.equal(f.evaluate().exp, NOW + 3600);
    f.time(NOW + 3600); assert.equal(f.issue().status, 400); assert.equal(f.evaluate(f.records[0]), null);
    const restored = new FileFirstUseWindowStore(f.directory); assert.equal(restored.get(key).expiresAt, NOW + 3600);
    assert.equal(restored.getOrStart(key, 3600, NOW + 9999).expiresAt, NOW + 3600);
});

test('source removal/readdition permanently revokes old tokens without resetting the client usage deadline', t => {
    const f = harness(t, { mode: 'one-time' }); assert.equal(f.issue().status, 200); assert.ok(f.evaluate());
    const original = structuredClone(f.records[0]);
    const change = ids => require('../src/fhir/sandbox-source-change').simulateSourceChange({ store: f.store, config: f.config,
        consentId: f.consent.id, expectedVersion: f.store.get('Consent', f.consent.id).meta.versionId,
        sourceOrganizationIds: ids, actor: 'owned-test', sessionId: 'owned-session', audit() {} });
    change([]); assert.equal(f.evaluate(), null); change([f.source.dataSourceOrganization.id]);
    assert.equal(f.evaluate(), null); f.time(NOW + 100); assert.equal(f.issue().body.expires_in, 3500);
    assert.equal(f.evaluate().scope, EXACT); assert.deepEqual(f.records[0], original);
    const key = firstUseKey(f.service.id, f.consent.id, f.client.clientId, f.source.dataSourceOrganization.id);
    assert.equal(f.firstUseStore.get(key).startedAt, NOW);
});

test('legacy Consent/source usage is unresolved and cannot be relabelled as an unused new tuple', t => {
    const f = harness(t, { mode: 'one-time' });
    f.firstUseStore.getOrStart(`${f.consent.id}\u0000${f.source.dataSourceOrganization.id}`, 3600, NOW - 4000);
    assert.equal(f.issue().status, 400);
    assert.equal(f.firstUseStore.get(firstUseKey(f.service.id, f.consent.id, f.client.clientId, f.source.dataSourceOrganization.id)), null);
});

test('future or corrupt retained usage denies without recreating or resetting the window', t => {
    const f = harness(t, { mode: 'one-time' }); f.time(NOW + 10);
    assert.equal(f.issue().status, 200); assert.ok(f.evaluate());
    const key = firstUseKey(f.service.id, f.consent.id, f.client.clientId, f.source.dataSourceOrganization.id);
    const file = path.join(f.directory, require('../src/state-store').recordName(key));
    const bytes = fs.readFileSync(file, 'utf8');
    f.time(NOW + 9); assert.equal(f.issue().status, 400); assert.equal(f.evaluate(), null);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    fs.writeFileSync(file, '{corrupt'); f.time(NOW + 11);
    assert.equal(f.issue().status, 400); assert.equal(f.evaluate(), null);
    assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt');
});

test('parseable wrong-duration usage rejects issuance/introspection without mutation and preserves a valid neighbor', t => {
    const f = harness(t, { mode: 'one-time' });
    assert.equal(f.issue().status, 200);
    const issued = structuredClone(f.records);
    const key = firstUseKey(f.service.id, f.consent.id, f.client.clientId, f.source.dataSourceOrganization.id);
    const file = path.join(f.directory, require('../src/state-store').recordName(key));
    const neighbor = f.config.healthOrganizations[1];
    const neighborKey = firstUseKey(f.service.id, f.consent.id, f.client.clientId, neighbor.dataSourceOrganization.id);
    const neighborFile = path.join(f.directory, require('../src/state-store').recordName(neighborKey));
    const validBytes = JSON.stringify({ startedAt: NOW, expiresAt: NOW + 3600 }) + '\n';
    fs.writeFileSync(neighborFile, validBytes);
    const start = t.mock.method(f.firstUseStore, 'getOrStart', () => { throw new Error('Rejected usage must not reach first-use publication'); });
    for (const duration of [7200, 3599]) {
        const invalidBytes = JSON.stringify({ startedAt: NOW, expiresAt: NOW + duration }) + '\n';
        fs.writeFileSync(file, invalidBytes);
        assert.equal(f.firstUseStore.get(key).ok, true, 'generic reader accepts this parseable positive interval');
        assert.throws(() => resolveGrant({ ...f.request, firstUseStore: f.firstUseStore }), /unavailable/);
        assert.equal(f.issue().status, 400); assert.equal(f.evaluate(f.records[0]), null);
        assert.deepEqual(f.records, issued); assert.equal(start.mock.callCount(), 0);
        assert.equal(fs.readFileSync(file, 'utf8'), invalidBytes);
        assert.equal(fs.readFileSync(neighborFile, 'utf8'), validBytes);
    }
    start.mock.restore();
    f.time(NOW + 100);
    assert.equal(f.issue({ resource: neighbor.endpoint }).body.expires_in, 3500);
    assert.equal(f.evaluate(f.records.at(-1), neighbor).scope, EXACT);
    assert.equal(fs.readFileSync(neighborFile, 'utf8'), validBytes);
    assert.deepEqual(f.records[0], issued[0]);
});

test('clinical usage read rejects missing/unsafe fields while preserving an exact valid hour', () => {
    const { readFirstUse } = require('../src/clinical-first-use');
    for (const record of [{ ok: false }, { ok: true, startedAt: NOW }, { ok: true, startedAt: String(NOW), expiresAt: NOW + 3600 },
        { ok: true, startedAt: NOW + 0.5, expiresAt: NOW + 3600.5 }, { ok: true, startedAt: Number.MAX_SAFE_INTEGER, expiresAt: Number.MAX_SAFE_INTEGER + 3600 }]) {
        const before = structuredClone(record);
        assert.deepEqual(readFirstUse({ get: key => key.includes('pcm-clinical-first-use/2') ? record : null }, 'service', 'consent', 'client', 'source'), { ok: false });
        assert.deepEqual(record, before);
    }
    const valid = { ok: true, startedAt: NOW, expiresAt: NOW + 3600 };
    assert.equal(readFirstUse({ get: key => key.includes('pcm-clinical-first-use/2') ? valid : null }, 'service', 'consent', 'client', 'source'), valid);
    assert.equal(readFirstUse({ get: () => null }, 'service', 'consent', 'client', 'source'), null);
});

test('continuous approval start/end are eligibility deadlines; historical literal dates are never clock substitutions', t => {
    const f = harness(t);
    f.time(NOW - 1); assert.equal(f.issue().status, 400);
    f.time(NOW); assert.equal(f.issue().body.scope, EXACT);
    const end = Date.parse(f.consent.provision.period.end) / 1000;
    f.time(end - 1); assert.equal(f.issue().body.expires_in, 1); assert.equal(f.evaluate().exp, end);
    f.time(end); assert.equal(f.issue().status, 400); assert.equal(f.evaluate(), null);
    assert.equal(f.store.privateRecords.approvals.getDecision(f.consent.id).snapshot.scope, EXACT);
});

for (const [anchor, duration, expected] of [
    ['2028-01-31T12:00:00Z', { value: 1, code: 'mo' }, '2028-02-29T12:00:00.000Z'],
    ['2028-02-29T12:00:00Z', { value: 1, code: 'a' }, '2029-02-28T12:00:00.000Z']
]) test(`approval calendar duration ${anchor} binds once and caps token/introspection`, t => {
    const now = Date.parse(anchor) / 1000, f = harness(t, { now, duration });
    assert.equal(f.consent.provision.period.end, expected);
    assert.equal(f.store.privateRecords.approvals.getDecision(f.consent.id).snapshot.validity.end, expected);
    const end = Date.parse(expected) / 1000;
    f.time(end - 1); assert.equal(f.issue().body.expires_in, 1); assert.equal(f.evaluate().exp, end);
    f.time(end); assert.equal(f.issue().status, 400); assert.equal(f.evaluate(), null);
    assert.equal(f.store.privateRecords.approvals.getDecision(f.consent.id).snapshot.scope, EXACT);
    assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('snapshot reader does not need a service compiler or live service definition', t => {
    const f = harness(t), saved = f.store.get('Consent', f.consent.id);
    const snapshot = f.store.privateRecords.approvals.getDecision(saved.id).snapshot;
    assert.equal(JSON.parse(JSON.stringify(snapshot)).scope, EXACT);
    assert.equal(readApprovalSnapshot(saved), null, 'ordinary public Consent carries no private decision');
    assert.equal(resolveGrant({ ...f.request, firstUseStore: f.firstUseStore }).scope, EXACT);
});

test('parallel otherwise-valid introspections in fresh processes publish one stable tuple and recovery keeps it', async t => {
    const f = harness(t, { mode: 'one-time' });
    const script = `
        const { clinicalTokenFixture } = require(${JSON.stringify(path.resolve(__dirname, '../../../test-support/clinical-token-fixture'))});
        const { resolveGrant } = require(${JSON.stringify(path.resolve(__dirname, '../src/data-grant'))});
        const { evaluateSubjectToken } = require(${JSON.stringify(path.resolve(__dirname, '../src/introspection-service'))});
        const { FileFirstUseWindowStore } = require(${JSON.stringify(path.resolve(__dirname, '../src/state-store'))});
        const f = clinicalTokenFixture({mode:'one-time'});
        const firstUseStore = new FileFirstUseWindowStore(${JSON.stringify(f.directory)});
        const grant = resolveGrant({...f.request, firstUseStore});
        const client = f.client, source = f.source;
        const token = {kind:'data_source_access',scope:grant.scope,authorization:grant,authorization_details:grant.authorization_details,
            iat:${NOW},exp:${NOW + 86400},client_id:client.clientId,sub:client.clientId,aud:source.endpoint,iss:f.config.contract.operational.fhirBase,
            pcm_authentication_context:{token_endpoint_mtls:{'x5t#S256':client.mtlsThumbprint},client_assertion_signing:{'x5t#S256':client.assertionThumbprint},correlation_verified:true}};
        const response = evaluateSubjectToken({token,firstUseStore,store:f.store,config:f.config,now:${NOW},
            caller:{clientId:source.clientId,organizationId:source.dataSourceOrganization.id},findClient:id=>id===client.clientId?client:{clientId:source.clientId,role:'data-source',organizationId:source.dataSourceOrganization.id}});
        process.stdout.write(JSON.stringify(response));`;
    const outputs = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
        const child = require('node:child_process').spawn(process.execPath, ['-e', script]);
        let output = '', errors = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
        child.once('error', reject); child.once('close', code => code ? reject(new Error(errors)) : resolve(JSON.parse(output)));
    })));
    assert.ok(outputs.every(value => value?.active && value.scope === EXACT && value.exp === NOW + 30));
    assert.equal(fs.readdirSync(f.directory).length, 1);
    const key = firstUseKey(f.service.id, f.consent.id, f.client.clientId, f.source.dataSourceOrganization.id);
    assert.deepEqual(f.firstUseStore.get(key), { ok: true, startedAt: NOW, expiresAt: NOW + 3600 });
    const recovered = require('node:child_process').spawnSync(process.execPath, ['-e', `const {FileFirstUseWindowStore}=require(${JSON.stringify(path.resolve(__dirname, '../src/state-store'))});process.stdout.write(JSON.stringify(new FileFirstUseWindowStore(${JSON.stringify(f.directory)}).getOrStart(${JSON.stringify(key)},3600,${NOW + 5000})))`], { encoding: 'utf8' });
    assert.equal(recovered.status, 0, recovered.stderr); assert.equal(JSON.parse(recovered.stdout).expiresAt, NOW + 3600);
});

test('dependency restoration and terminal cancellation cannot renew usage or revive retained tokens', t => {
    const f = harness(t, { mode: 'one-time' }); assert.equal(f.issue().status, 200); assert.ok(f.evaluate());
    const old = f.records[0], service = f.store.get('HealthcareService', f.service.id);
    const suspended = structuredClone(service); suspended.active = false;
    suspended.extension.find(item => item.url === require('../../shared/pcm-contract').EXTENSIONS.serviceBusinessStatus).valueCoding.code = 'suspended';
    f.store.update(suspended); assert.equal(f.evaluate(old), null);
    f.store.update({ ...service, meta: f.store.get('HealthcareService', service.id).meta }); assert.equal(f.evaluate(old), null);
    f.time(NOW + 100); assert.equal(f.issue().body.expires_in, 3500); assert.ok(f.evaluate());
    const { cancelConsent } = require('../src/fhir/consent-lifecycle');
    cancelConsent({ request: require('../../sp-client/src/fhir-builders').buildConsentDeactivate(f.consent.id), store: f.store, consent: f.store.get('Consent', f.consent.id), callerOrganization: f.store.get('Organization', f.client.organizationId), clock: () => new Date((NOW + 100) * 1000) });
    assert.equal(f.issue().status, 400); assert.equal(f.evaluate(), null);
    const key = firstUseKey(f.service.id, f.consent.id, f.client.clientId, f.source.dataSourceOrganization.id);
    assert.equal(new FileFirstUseWindowStore(f.directory).get(key).expiresAt, NOW + 3600);
});
