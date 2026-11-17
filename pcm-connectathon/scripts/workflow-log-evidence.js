'use strict';

/** Retain actual component records and require correlated decisions plus actual gateway access. */
const fs = require('node:fs');
const path = require('node:path');

/** Snapshot JSON log records before browser clear tests or process rotations can remove them. */
function snapshotWorkflowLogs(teamDir, output) {
    const records = [];
    const root = path.join(teamDir, 'logs');
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.name.endsWith('.log')) {
                if (fs.statSync(file).size > 64 * 1024 * 1024) throw new Error(`Qualification log exceeds snapshot bound: ${file}`);
                fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
                    if (!line) return;
                    let record;
                    try { record = JSON.parse(line); } catch (_) { return; }
                    records.push({ component: path.relative(root, file).split(path.sep)[0], file: path.relative(root, file), line: index + 1, record });
                });
            }
        }
    };
    walk(root);
    fs.writeFileSync(output, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    return records;
}

/** Require each supported scenario's correlated issuance/access and meaningful negative outcome. */
function verifyWorkflowLogs(records, { protectedPreset = true } = {}) {
    const details = item => item.record.details || {};
    const ref = item => ({ component: item.component, file: item.file, line: item.line, timestamp: item.record.timestamp,
        flowId: details(item).flowId, type: details(item).type, kind: details(item).kind,
        correlationId: details(item).correlationId, url: details(item).url, method: details(item).method,
        timestampEpoch: details(item).timestampEpoch });
    const requireRecord = (predicate, label) => {
        const result = records.find(predicate);
        if (!result) throw new Error(`Required correlated log evidence is missing: ${label}`);
        return result;
    };
    const localKinds = { data_source_access: 'data-source-access', presence_online: 'online-presence',
        presence_batch: 'batch-presence', patient_authentication: 'patient-authentication', dependent_discovery: 'dependent-discovery' };
    // nginx's ISO time is only second-resolution; timestampEpoch retains milliseconds.
    const instant = item => details(item).timestampEpoch != null
        ? Math.round(Number(details(item).timestampEpoch) * 1000) : Date.parse(item.record.timestamp);
    /** Return the signed mint for this issuance/access pair, or undefined when its request does not match. */
    const signedContext = (issued, access) => records.find(item => item.component === access.component.replace('-gateway', '-adapter')
        && details(item).type === 'DS_LOCAL_TOKEN_MINTED' && details(item).flowId === details(issued).flowId
        && details(item).kind === localKinds[details(issued).kind] && details(access).correlationId
        && details(item).correlationId === details(access).correlationId
        && instant(item) >= instant(issued) && instant(item) <= instant(access));
    /** Return whether an access belongs to the issued scenario and its own protected gateway request. */
    const matchingAccess = (issued, access, scenario) => {
        const value = details(access);
        let endpoint;
        try { endpoint = new URL(details(issued).audience); } catch (_) { return false; }
        if (access.component !== endpoint.hostname || value.flowId !== details(issued).flowId
            || value.type !== 'GATEWAY_RESPONSE' || Number(value.statusCode) !== 200 || !value.url?.startsWith('/fhir')
            || !Number.isFinite(instant(issued)) || !Number.isFinite(instant(access)) || instant(access) < instant(issued)) return false;
        let url;
        try { url = new URL(value.url, 'https://qualification.invalid'); } catch (_) { return false; }
        const rootBatch = url.pathname === '/fhir' && value.method === 'POST';
        const expected = scenario === 'consent-access' ? url.pathname === '/fhir/Observation'
            : scenario === 'presence-check' ? rootBatch || url.pathname === '/fhir/Patient' && url.searchParams.get('_summary') === 'count'
                : scenario === 'patient-authentication' ? value.method === 'GET' && url.pathname === '/fhir/Patient'
                    && url.searchParams.has('identifier') && !url.searchParams.has('_summary')
                    && !url.searchParams.has('_has:RelatedPerson:patient:identifier')
                    : rootBatch || value.method === 'GET' && (url.pathname === '/fhir/RelatedPerson'
                        || url.pathname === '/fhir/Patient' && url.searchParams.has('_has:RelatedPerson:patient:identifier'));
        return expected && (!protectedPreset || Boolean(signedContext(issued, access)));
    };
    const scenarios = [];
    for (const [scenario, kinds] of [
        ['consent-access', ['data_source_access']], ['presence-check', ['presence_online', 'presence_batch']],
        ['patient-authentication', ['patient_authentication']], ['dependent-discovery', ['dependent_discovery']]
    ]) {
        const issued = requireRecord(item => item.component === 'pcm-core' && details(item).type === 'TOKEN_ISSUED'
            && kinds.includes(details(item).kind) && details(item).flowId
            && records.some(access => matchingAccess(item, access, scenario)), `${scenario} issuance/access`);
        const flowId = details(issued).flowId;
        const access = requireRecord(item => matchingAccess(issued, item, scenario), `${scenario} actual gateway access`);
        const evidence = [ref(issued), ref(access)];
        if (protectedPreset) evidence.push(ref(signedContext(issued, access)));
        if (scenario === 'consent-access') {
            evidence.push(ref(requireRecord(item => item.component === 'sp-client' && details(item).flowId === flowId
                && details(item).type === 'OUTGOING_RESPONSE' && details(item).status === 200 && details(item).url?.includes('/fhir/Observation')
                && instant(item) >= instant(issued), 'Doctor clinical response')));
        } else evidence.push(ref(requireRecord(item => item.component === 'pcm-core' && details(item).flowId === flowId
            && details(item).type === 'SYSTEM_WORKFLOW_RESPONSE' && details(item).scenario === scenario
            && instant(item) >= instant(issued) && details(item).body?.resourceType === 'Bundle', `${scenario} orchestration response`)));
        const denied = requireRecord(item => item.component === 'pcm-core' && details(item).flowId && (
            scenario === 'consent-access' ? details(item).type === 'TOKEN_AUTHORIZATION_DENIED' && details(item).basis?.type === 'Consent'
                : scenario === 'presence-check' ? details(item).type === 'SYSTEM_PRESENCE' && details(item).state === 'unknown'
                    : scenario === 'patient-authentication' ? details(item).type === 'SYSTEM_OTP' && details(item).state === 'denied'
                        : details(item).type === 'SYSTEM_DISCOVERY' && details(item).state === 'unknown'), `${scenario} denied/failed outcome`);
        if (!details(denied).flowId) throw new Error(`Required denial correlation is missing: ${scenario}`);
        scenarios.push({ id: `logs-${scenario}`, status: 'pass', executed: true, successfulFlowId: flowId, evidence, negative: ref(denied) });
    }
    return { schemaVersion: 'pcm-workflow-log-evidence/2', scenarios, conformanceException: 'PCM-SANDBOX-FULL-DIAGNOSTICS', records: records.length };
}
module.exports = { snapshotWorkflowLogs, verifyWorkflowLogs };
