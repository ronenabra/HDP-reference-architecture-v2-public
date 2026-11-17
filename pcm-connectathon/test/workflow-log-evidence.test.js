'use strict';

/** Qualification distinguishes issuance from actual correlated source access. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyWorkflowLogs } = require('../scripts/workflow-log-evidence');

/** Build separate component observations matching preserved runtime JSON records. */
function observedRecords() {
    const records = [];
    const add = (component, details) => {
        const time = Date.parse('2026-10-05T00:00:00Z') + (records.length + 1) * 10;
        const timestamp = new Date(time).toISOString();
        if (component.endsWith('-gateway')) details.timestampEpoch = String(time / 1000);
        records.push({ component, file: `${component}/current.log`, line: records.length + 1,
            record: { timestamp: component.endsWith('-gateway') ? timestamp.replace(/\.\d{3}Z$/, 'Z') : timestamp, details } });
    };
    for (const [scenario, kind, localKind, url, method] of [
        ['consent-access', 'data_source_access', 'data-source-access', '/fhir/Observation', 'GET'],
        ['presence-check', 'presence_online', 'online-presence', '/fhir/Patient?identifier=urn:synthetic%7C1&_summary=count&_count=0', 'GET'],
        ['patient-authentication', 'patient_authentication', 'patient-authentication', '/fhir/Patient?identifier=urn:synthetic%7C1&_elements=identifier,name,telecom,birthDate', 'GET'],
        ['dependent-discovery', 'dependent_discovery', 'dependent-discovery', '/fhir', 'POST']
    ]) {
        const flowId = scenario;
        const correlationId = `request-${scenario}`;
        add('pcm-core', { type: 'TOKEN_ISSUED', kind, flowId, audience: 'https://ho-a-gateway:8080/fhir' });
        add('ho-a-adapter', { type: 'DS_LOCAL_TOKEN_MINTED', flowId, correlationId, kind: localKind });
        add('ho-a-gateway', { type: 'GATEWAY_RESPONSE', flowId, correlationId, url, method, statusCode: '200' });
        if (scenario === 'consent-access') {
            add('sp-client', { type: 'OUTGOING_RESPONSE', flowId, status: 200, url: 'https://ho-a/fhir/Observation' });
            add('pcm-core', { type: 'TOKEN_AUTHORIZATION_DENIED', basis: { type: 'Consent' }, flowId: 'denied-consent' });
        } else {
            add('pcm-core', { type: 'SYSTEM_WORKFLOW_RESPONSE', scenario, flowId, body: { resourceType: 'Bundle' } });
            add('pcm-core', { type: scenario === 'presence-check' ? 'SYSTEM_PRESENCE' : scenario === 'patient-authentication' ? 'SYSTEM_OTP' : 'SYSTEM_DISCOVERY', state: scenario === 'patient-authentication' ? 'denied' : 'unknown', flowId: `denied-${scenario}` });
        }
    }
    return records;
}

test('each scenario requires issuance, access, signed context and its own negative outcome', () => {
    const records = observedRecords();
    assert.equal(verifyWorkflowLogs(records).scenarios.length, 4);
    for (const type of ['GATEWAY_RESPONSE', 'DS_LOCAL_TOKEN_MINTED', 'SYSTEM_OTP', 'SYSTEM_PRESENCE', 'SYSTEM_DISCOVERY', 'TOKEN_AUTHORIZATION_DENIED']) {
        assert.throws(() => verifyWorkflowLogs(records.filter(item => item.record.details.type !== type)), /Required/);
    }
    const forged = structuredClone(records);
    for (const item of forged.filter(item => item.component.endsWith('-gateway'))) item.record.details.flowId = 'another-flow';
    assert.throws(() => verifyWorkflowLogs(forged), /issuance\/access/);
    const onlyAuthSubrequest = structuredClone(records);
    for (const item of onlyAuthSubrequest.filter(item => item.component.endsWith('-gateway'))) item.record.details.url = '/auth';
    assert.throws(() => verifyWorkflowLogs(onlyAuthSubrequest), /issuance\/access/);
    assert.doesNotThrow(() => verifyWorkflowLogs(records.filter(item => !item.component.endsWith('-adapter')), { protectedPreset: false }));
});


test('a snapshot before browser clear retains the protocol denial needed by the complete log gate', t => {
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pcm-log-snapshot-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const logs = path.join(directory, 'logs');
    const records = observedRecords();
    const denied = records.find(item => item.record.details.type === 'TOKEN_AUTHORIZATION_DENIED');
    fs.mkdirSync(path.join(logs, 'pcm-core'), { recursive: true });
    fs.writeFileSync(path.join(logs, 'pcm-core/current.log'), JSON.stringify(denied.record) + '\nmalformed legacy line\n');
    const { snapshotWorkflowLogs } = require('../scripts/workflow-log-evidence');
    const early = snapshotWorkflowLogs(directory, path.join(directory, 'protocol.jsonl'));
    assert.equal(early.length, 1);
    fs.rmSync(logs, { recursive: true });
    for (const item of records.filter(item => item !== denied)) {
        const file = path.join(logs, item.component, 'current.log');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(item.record) + '\n');
    }
    const later = snapshotWorkflowLogs(directory, path.join(directory, 'workflow.jsonl'));
    assert.throws(() => verifyWorkflowLogs(later), /consent-access denied/);
    assert.equal(verifyWorkflowLogs([...early, ...later]).scenarios.length, 4);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'protocol.jsonl'), 'utf8')).record.details.flowId, 'denied-consent');
});


test('authentication in a shared flow cannot substitute for actual discovery access', () => {
    const records = observedRecords();
    for (const item of records) {
        if (['patient-authentication', 'dependent-discovery'].includes(item.record.details.flowId)) item.record.details.flowId = 'shared-flow';
    }
    const passed = verifyWorkflowLogs(records);
    const discovery = passed.scenarios.find(item => item.id === 'logs-dependent-discovery');
    assert.equal(discovery.evidence[1].url, '/fhir');
    assert.equal(discovery.evidence[2].kind, 'dependent-discovery');
    const missingDiscovery = records.filter(item => item.record.details.correlationId !== 'request-dependent-discovery');
    assert.throws(() => verifyWorkflowLogs(missingDiscovery), /dependent-discovery issuance\/access/);
    const wrongPath = structuredClone(records);
    const gateway = wrongPath.find(item => item.component.endsWith('-gateway') && item.record.details.correlationId === 'request-dependent-discovery');
    gateway.record.details.url = '/fhir/Patient?identifier=urn:synthetic%7C1&_elements=identifier,name,telecom,birthDate';
    gateway.record.details.method = 'GET';
    assert.throws(() => verifyWorkflowLogs(wrongPath), /dependent-discovery issuance\/access/);
    assert.throws(() => verifyWorkflowLogs(wrongPath.filter(item => !item.component.endsWith('-adapter')), { protectedPreset: false }), /dependent-discovery issuance\/access/);
});

test('protected access requires the correct HO, scenario, request ID and issuance ordering', () => {
    for (const mutation of [
        rows => { rows.find(item => item.record.details.kind === 'dependent-discovery').record.details.kind = 'patient-authentication'; },
        rows => { rows.find(item => item.record.details.kind === 'dependent-discovery').record.details.correlationId = 'other-request'; },
        rows => { for (const item of rows.filter(item => item.record.details.correlationId === 'request-dependent-discovery')) item.component = item.component.replace('ho-a', 'ho-b'); },
        rows => { rows.find(item => item.record.details.kind === 'dependent-discovery').record.timestamp = '2026-10-04T23:59:59Z'; },
        rows => { rows.find(item => item.record.details.kind === 'dependent_discovery').record.timestamp = '2026-10-05T00:00:01Z'; },
        rows => { rows.find(item => item.component.endsWith('-gateway') && item.record.details.correlationId === 'request-dependent-discovery').record.details.timestampEpoch = 'invalid'; }
    ]) {
        const records = observedRecords();
        mutation(records);
        assert.throws(() => verifyWorkflowLogs(records), /dependent-discovery issuance\/access/);
    }
});

test('nginx millisecond timestamps preserve valid access ordering within the issuance second', () => {
    const records = observedRecords();
    const issued = records.find(item => item.record.details.kind === 'data_source_access');
    const access = records.find(item => item.record.details.type === 'GATEWAY_RESPONSE');
    assert.ok(Date.parse(access.record.timestamp) < Date.parse(issued.record.timestamp));
    assert.ok(Number(access.record.details.timestampEpoch) * 1000 > Date.parse(issued.record.timestamp));
    assert.equal(verifyWorkflowLogs(records).scenarios.length, 4);
    const missingPrecision = structuredClone(records);
    delete missingPrecision.find(item => item.record.details.type === 'GATEWAY_RESPONSE').record.details.timestampEpoch;
    assert.throws(() => verifyWorkflowLogs(missingPrecision), /consent-access issuance\/access/);
});
