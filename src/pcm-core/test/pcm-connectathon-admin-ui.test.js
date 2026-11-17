require('../../../test-support/team-config').installTestRuntime();
/**
 * Tests for pcm-connectathon admin UI helper behavior.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

// Set worker-owned paths before importing application modules with runtime state.
const testRuntime = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || require('node:os').tmpdir(), 'pcm-admin-'));
const previousRuntimeEnv = { LOG_DIR: process.env.LOG_DIR, STATE_DIR: process.env.STATE_DIR };
process.env.LOG_DIR = path.join(testRuntime, 'logs');
process.env.STATE_DIR = path.join(testRuntime, 'state');
test.after(() => {
    for (const [key, value] of Object.entries(previousRuntimeEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(testRuntime, { recursive: true, force: true });
});

const tmpRoot = process.env.TEST_TMPDIR || '/tmp';

function seedPendingConsent(store, config, id) {
    const { syncDataSourcesToStore } = require('../src/data-sources');
    const { createConsent } = require('../src/fhir/consent-lifecycle');
    const { CODE_SYSTEMS, IDENTIFIER_SYSTEMS } = require('../../shared/pcm-contract');
    const examples = path.resolve(__dirname, '../../../docs/FHIR-examples');
    const read = name => JSON.parse(fs.readFileSync(path.join(examples, name), 'utf8'));
    store.clear();
    store.add({
        resourceType: 'Organization', id: 'parent-sp', active: true,
        identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value: 'PCM-PARENT-SP' }],
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: 'parent-org' }] }]
    });
    const sp = store.add({
        resourceType: 'Organization', id: 'org-sp', active: true, name: 'Test Service Provider',
        identifier: [{ use: 'official', system: IDENTIFIER_SYSTEMS.organization, value: 'PCM-ORG-SP' }],
        type: [{ coding: [{ system: CODE_SYSTEMS.organizationType, code: 'service-provider' }] }],
        partOf: { reference: 'Organization/parent-sp' }
    });
    const catalog = store.add(read('HealthcareService-svc-catalog-cross-org-summary.json'));
    require('../../../test-support/private-definition').replaceDefinition(store, catalog, structuredClone(require('../../../config/service-templates.json').templates[0].definition));
    const service = read('HealthcareService-svc-instance-hosp-a-cross-org-summary.json');
    service.providedBy.reference = 'Organization/org-sp';
    store.add(service);
    syncDataSourcesToStore(store, config, 'A'.repeat(43));
    const request = read('Consent-consent-request-hosp-a-cross-org-summary.json');
    request.extension[0].valueReference.reference = `HealthcareService/${service.id}`;
    return createConsent({
        store, callerOrganization: sp, request,
        idGenerator: (() => { const ids = [id, `${id}-business`]; return () => ids.shift(); })()
    });
}

test('buildZip creates a ZIP archive containing certificate filenames', () => {
    const router = require('../src/routes/ui');
    const zip = router._test.buildZip({
        'rootCA.crt': 'root certificate',
        'sp-client.key': 'private key'
    });

    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.ok(zip.includes(Buffer.from('rootCA.crt')));
    assert.ok(zip.includes(Buffer.from('sp-client.key')));
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
});

test('clearAllLogs truncates current logs so open file handles keep working', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-admin-logs-'));
    const previousSharedLogsDir = process.env.SHARED_LOGS_DIR;
    process.env.SHARED_LOGS_DIR = tmp;
    delete require.cache[require.resolve('../src/team-config')];
    delete require.cache[require.resolve('../src/routes/ui')];
    const router = require('../src/routes/ui');

    const pcmLog = path.join(tmp, 'pcm-core', 'current.log');
    const historyLog = path.join(tmp, 'pcm-core', 'history', 'old', 'app.log');
    const hapiLog = path.join(tmp, 'ho-a-hapi', 'current.log');
    const hapiHistory = path.join(tmp, 'ho-a-hapi', 'history', '2026-09-28', 'app.log');
    fs.mkdirSync(path.dirname(pcmLog), { recursive: true });
    fs.mkdirSync(path.dirname(historyLog), { recursive: true });
    fs.mkdirSync(path.dirname(hapiHistory), { recursive: true });
    fs.writeFileSync(pcmLog, '{"message":"test"}\n');
    fs.writeFileSync(historyLog, '{"message":"old"}\n');
    fs.writeFileSync(hapiLog, '{"message":"native"}\n');
    fs.writeFileSync(hapiHistory, '{"message":"native-old"}\n');

    router._test.clearAllLogs();

    assert.equal(fs.existsSync(pcmLog), true);
    assert.equal(fs.readFileSync(pcmLog, 'utf8'), '');
    assert.equal(fs.existsSync(historyLog), false);
    assert.equal(fs.readFileSync(hapiLog, 'utf8'), '');
    assert.equal(fs.existsSync(hapiHistory), false);
    if (previousSharedLogsDir === undefined) delete process.env.SHARED_LOGS_DIR;
    else process.env.SHARED_LOGS_DIR = previousSharedLogsDir;
    delete require.cache[require.resolve('../src/routes/ui')];
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('readAllLogs includes rotated history and current logs for every component', () => {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, 'pcm-admin-history-'));
    const previousSharedLogsDir = process.env.SHARED_LOGS_DIR;
    const previousConfigPath = process.env.TEAM_CONFIG_PATH;
    try {
        process.env.SHARED_LOGS_DIR = tmp;
        process.env.TEAM_CONFIG_PATH = path.resolve(__dirname, '../../../pcm-connectathon/example-team-config.json');
        delete require.cache[require.resolve('../src/team-config')];
        delete require.cache[require.resolve('../src/routes/ui')];
        const router = require('../src/routes/ui');

        const historyLog = path.join(tmp, 'ds-gateway', 'history', '2026-05-12T08-00-00.000Z', 'app.log');
        const currentLog = path.join(tmp, 'ds-gateway', 'current.log');
        const errorLog = path.join(tmp, 'ds-gateway', 'error.log');
        const hapiLog = path.join(tmp, 'ho-a-hapi', 'current.log');
        fs.mkdirSync(path.dirname(historyLog), { recursive: true });
        fs.mkdirSync(path.dirname(currentLog), { recursive: true });
        fs.writeFileSync(historyLog, '{"message":"rotated","details":{"type":"GATEWAY_RESPONSE"}}\n');
        fs.writeFileSync(currentLog, '{"message":"current","details":{"type":"GATEWAY_RESPONSE"}}\n');
        fs.writeFileSync(errorLog, '2026/05/12 08:01:02 [error] 29#29: *7 upstream timed out while reading response header from upstream\n');
        fs.mkdirSync(path.dirname(hapiLog), { recursive: true });
        fs.writeFileSync(hapiLog, '{"message":"hapi-complete","details":{"operationId":"op-a","healthOrganizationId":"ho-a"}}\n');

        const result = router._test.readAllLogs();
        assert.equal(result.complete, true);
        assert.equal(result.status, 'complete');
        assert.deepEqual(result.failures, []);
        const { logs } = result;

        assert.deepEqual(logs['ds-gateway'].map(log => log.message), [
            'rotated',
            'current',
            'Gateway Error: *7 upstream timed out while reading response header from upstream'
        ]);
        assert.equal(logs['ds-gateway'][0].logFile, 'history/2026-05-12T08-00-00.000Z/app.log');
        assert.equal(logs['ds-gateway'][1].logFile, 'current.log');
        assert.equal(logs['ds-gateway'][2].details.type, 'GATEWAY_ERROR');
        assert.equal(logs['ds-gateway'][2].logFile, 'error.log');
        assert.equal(logs['ho-a-hapi'][0].message, 'hapi-complete');
        assert.equal(logs['ho-a-hapi'][0].details.healthOrganizationId, 'ho-a');
    } finally {
        if (previousSharedLogsDir === undefined) delete process.env.SHARED_LOGS_DIR;
        else process.env.SHARED_LOGS_DIR = previousSharedLogsDir;
        if (previousConfigPath === undefined) delete process.env.TEAM_CONFIG_PATH;
        else process.env.TEAM_CONFIG_PATH = previousConfigPath;
        delete require.cache[require.resolve('../src/routes/ui')];
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('logs tail spacer targets the newest row according to tail position', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'logs.ejs'), 'utf8');

    assert.match(view, /function addLogTailSpacer\(\)/);
    assert.match(view, /tailIndex = tailIsAtBottom \? currentLogs\.length - 1 : 0/);
    assert.match(view, /let tailSpacerLogs = \{\}/);
    assert.match(view, /tailSpacerUnifiedLogs/);
    assert.match(view, /tailSpacerLogs\[id\] = true/);
    assert.match(view, /const hasTailSpacer = !!tailSpacerLogs\[log\.id\]/);
    assert.match(view, /const tailSpacerAfter = hasTailSpacer && isBottomTailMode\(\)/);
    assert.match(view, /spacerRowId\(log\.id, 'before', 'tail'\)/);
    assert.match(view, /spacerRowId\(log\.id, 'after', 'tail'\)/);
    assert.match(view, /\$\{spacerBefore\}\s+\$\{groupHeader\}/);
    assert.match(view, /renderInlineSpacer\(id, tailIsAtBottom \? 'after' : 'before', true, 'tail'\)/);
    assert.match(view, /Spacer at log tail/);
    assert.doesNotMatch(view, /topSpacerUnifiedLogs/);
    assert.doesNotMatch(view, /Spacer at top/);
});

test('logs UI mark and spacer controls update inline without refreshing the viewport', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'logs.ejs'), 'utf8');
    const markBody = view.match(/function markSelectedLog\(color\) \{([\s\S]*?)\n        \}/)?.[1] || '';
    const spacerBody = view.match(/function toggleSelectedSpacer\(position\) \{([\s\S]*?)\n        \}/)?.[1] || '';

    assert.match(markBody, /row\.classList\.remove\('mark-yellow', 'mark-green', 'mark-red'\)/);
    assert.match(markBody, /row\.classList\.add\(`mark-\$\{color\}`\)/);
    assert.doesNotMatch(markBody, /refreshLogs/);
    assert.match(spacerBody, /renderInlineSpacer\(selectedId, position, Boolean\(current\[position\]\)\)/);
    assert.doesNotMatch(spacerBody, /refreshLogs/);
});

test('logs polling holds accepted rows and selection while buffering updates, then follows when requested', async () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'logs.ejs'), 'utf8');
    const refresh = view.slice(view.indexOf('        function refreshLogs('), view.indexOf('        setInterval(refreshLogs'));
    const held = { entries: [{ id: 'held' }], sources: [], failures: [] };
    const fresh = { entries: [{ id: 'fresh' }], sources: [], failures: [] };
    const context = vm.createContext({
        URLSearchParams, AbortController, performance,
        window: { location: { search: '?role=doctor' } }, document: { body: { dataset: { browserBase: '/mount' } }, getElementById: () => ({ setAttribute() {} }) },
        searchSession: null, criticalView: null, clearing: false, activeRead: null,
        followingLatest: false, currentResult: held, currentLogs: held.entries,
        latestSignature: JSON.stringify(held.entries), queuedResult: null, liveAnchor: null,
        requestRevision: 0, selectedId: 'held', logPages: [held], logOrderMode: 'flow', logTailPosition: 'top',
        FILTER_FIELDS: ['role'], showDiagnosticLogs: false, latestSourceCheck: null,
        fetch: async url => { assert.equal(new URL(url, 'http://fixture').pathname, '/mount/api/unified-logs'); assert.equal(new URL(url, 'http://fixture').searchParams.get('role'), 'doctor'); return { ok: true, json: async () => fresh }; },
        renderSourceCheck() {}, observeCriticalDiagnostic() {}, logStatus() {}, updateViewState() {},
        applyLogResult: result => { context.currentResult = result; context.currentLogs = result.entries; }
    });
    vm.runInContext(refresh, context);
    await vm.runInContext('refreshLogs()', context);
    assert.equal(context.currentResult, held);
    assert.equal(context.currentLogs, held.entries);
    assert.equal(context.selectedId, 'held');
    assert.equal(context.queuedResult, fresh);
    assert.equal(context.activeRead, null);
    context.followingLatest = true;
    await vm.runInContext('refreshLogs()', context);
    assert.equal(context.currentResult, fresh);
    assert.equal(context.selectedId, 'held');
});

test('logs UI defaults to Group related events and hides legacy mode button', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'logs.ejs'), 'utf8');

    assert.doesNotMatch(view, /data-log-order-mode="legacy"/);
    assert.match(view, /data-log-order-mode="flow"/);
    assert.match(view, /data-log-order-mode="timeline"/);
    assert.match(view, /data-log-tail-position="top"/);
    assert.match(view, /data-log-tail-position="bottom"/);
    assert.match(view, /let logOrderMode = 'flow'/);
    assert.match(view, /let logTailPosition = 'top'/);
    assert.match(view, /savedOrderMode === 'timeline' \? 'timeline' : 'flow'/);
    const tailBody = view.match(/function setLogTailPosition\(position\) \{([\s\S]*?)\n        \}/)?.[1] || '';
    assert.match(tailBody, /pageCursor = ''/);
    assert.match(tailBody, /refreshLogs\(true\)/);
    assert.match(view, /log\.flowGroup\.title \|\| log\.flowGroup\.component/);
    assert.match(view, /log\.flowGroup\.subtitle/);
    assert.match(view, /function formatLogMessage\(log\)/);
    assert.match(view, /Request Received:/);
    assert.match(view, /Response Sent:/);
    assert.match(view, /Response Received:/);
    assert.match(view, /function formatTimestamp\(timestamp\)/);
    assert.match(view, /escapeHtml\(formatTimestamp\(log\.timestamp\)\)/);
    assert.match(view, /function escapeHtml\(value\)/);
    assert.match(view, /function escapeAttribute\(value\)/);
    assert.match(view, /new URLSearchParams\(\{ order: logOrderMode, page: 'true' \}\)/);
    assert.match(view, /params\.set\('diagnostics', showDiagnosticLogs \? 'true' : 'false'\)/);
    assert.match(view, /api\/unified-logs\?\$\{params\.toString\(\)\}/);
});

test('logs UI renders correlation IDs for request and response pairs', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'logs.ejs'), 'utf8');

    assert.match(view, /function getCorrelationId\(log\)/);
    assert.match(view, /log\.details\?\.correlationId \|\| log\.details\?\.requestId \|\| ''/);
    assert.match(view, /data-correlation-id=/);
    assert.match(view, /\['Correlation \/ request ID', getCorrelationId\(record\) \|\| 'Not recorded'\]/);
    assert.match(view, /\['Flow ID', getFlowId\(record\) \|\| 'Not recorded'\]/);
    assert.match(view, /<th[^>]*data-column="correlationId"[^>]*>Correlation ID<\/th>/);
});

test('logs UI relies on API filtering and labels diagnostic harness log classes', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'logs.ejs'), 'utf8');

    assert.doesNotMatch(view, /function shouldDisplayLog\(log\)/);
    assert.doesNotMatch(view, /logs\.filter\(shouldDisplayLog\)/);
    assert.doesNotMatch(view, /visibility === 'diagnostic' && log\.details\?\.causesSystemFlow === true/);
    assert.match(view, /return log\.details\?\.category \|\| 'uncategorized'/);
    assert.match(view, /function formatLogClass\(log\)/);
    assert.match(view, /id="diagnosticsSwitch"/);
    assert.match(view, /showDiagnosticUnifiedLogs/);
    assert.match(view, /let showDiagnosticLogs = false/);
    assert.match(view, /<th[^>]*>Class<\/th>/);
    assert.match(view, /\.role-badge\.role-gateway/);
    assert.doesNotMatch(view, /\.log-row \.badge\s*\{/);
    assert.match(view, /HARNESS_ACTION_STARTED/);
    assert.match(view, /HARNESS_ACTION_COMPLETED/);
    assert.match(view, /HARNESS_ACTION_FAILED/);
    assert.match(view, /GATEWAY_REQUEST/);
    assert.match(view, /GATEWAY_RESPONSE/);
    assert.match(view, /GATEWAY_ERROR/);
    assert.match(view, /DATA_FETCH_UNEXPECTED_RESPONSE/);
    assert.match(view, /PROCESS_/);
});

test('logs UI escapes rendered log values before writing table and details HTML', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'logs.ejs'), 'utf8');

    assert.match(view, /function escapeHtml\(value\)/);
    assert.match(view, /\.replace\(\/>\/g, '&gt;'\)/);
    assert.match(view, /data-message="\$\{escapeAttribute\(displayMessage\)\}"/);
    assert.match(view, /escapeHtml\(log\.flowGroup\.title \|\| log\.flowGroup\.component\)/);
    assert.match(view, /escapeHtml\(JSON\.stringify\(record, null, 2\)\)/);
    assert.match(view, /escapeHtml\(raw\)/);
});

test('outbound HTTP logs use consistent direction wording while preserving structured types', () => {
    const spClient = fs.readFileSync(path.join(__dirname, '..', '..', 'sp-client', 'src', 'client.js'), 'utf8');
    const dsAdapter = fs.readFileSync(path.join(__dirname, '..', '..', 'ds-auth-adapter', 'src', 'index.js'), 'utf8');

    for (const source of [spClient, dsAdapter]) {
        assert.match(source, /Request Sent:/);
        assert.match(source, /Response Received:/);
        assert.match(source, /Response Error:/);
        assert.match(source, /type: 'OUTGOING_RESPONSE'/);
        assert.match(source, /correlationId:/);
        assert.doesNotMatch(source, /OUTGOING RESPONSE:/);
        assert.doesNotMatch(source, /RECEIVED RESPONSE:/);
    }
});

test('admin UI exposes source management and custom upstream FHIR configuration', () => {
    const router = require('../src/routes/ui');
    const sourceHtml = router._test.renderAdminHtml({ query: { section: 'sources' } });
    const securityHtml = router._test.renderAdminHtml({ query: { section: 'security' } });
    const overview = router._test.renderAdminHtml();
    const sources = require('../src/data-sources').getConfiguredDataSources(require('../src/team-config').loadTeamConfig());
    const pages = [router._test.renderAdminHtml({query:{section:'sources',view:'onboarding'}}), ...sources.flatMap(source => ['registration','trust','credentials','data','mappings','upstream'].map(view => router._test.renderAdminHtml({query:{section:'sources',source:source.id,view}})))];
    const html = sourceHtml + securityHtml + overview + pages.join('');

    assert.equal((sourceHtml.match(/class="explain-toggle"/g) || []).length, 1);
    assert.match(html, /<label class="explain-toggle" data-help-key="common.explain"><input type="checkbox"> Explain this page<\/label>/);
    assert.doesNotMatch(html, /text-uppercase text-muted small fw-bold">Team/);
    assert.match(html, /PCM OAuth metadata/);
    assert.match(html, /Reference Data Source metadata/);
    assert.match(html, /Access token duration \(seconds\)/);
    assert.match(html, /name="accessTokenExpiresInSeconds"/);
    assert.match(html, /Patient mapping grants no access/);
    assert.doesNotMatch(securityHtml, /name="dsFhirServerEnforceMappedPatients"/);
    assert.doesNotMatch(html, /Introspection returns expired access tokens/);
    assert.match(html, /https:\/\/github\.com\/8400TheHealthNetwork\/PCM-Connect/);
    assert.match(sourceHtml, /Managed HAPI/);
    assert.match(sourceHtml, /source-directory-row/);
    assert.match(html, /data-source-workspace=/);
    assert.match(html, /admin-source-panel/);
    assert.match(html, /Add custom source/);
    assert.match(html, /Client ID/);
    assert.match(html, /Source HTTPS trust/);
    assert.match(html, /enctype="multipart\/form-data"/);
    assert.match(html, /Target counts and history/);
    assert.match(html, /Upload limits: 805\.3 MB \(805306368 bytes\) · 200000 entries per bundle/);
    assert.match(html, /JSON status counts current resources across the managed target and checks target history/);
    assert.match(html, /Bundle verification counts only resources with the uploaded source and dataset tags/);
    assert.match(html, /serverTrustCaFile/);
    assert.match(html, /serverTrustCertFile/);
    assert.match(html, /Or upload CA certificate/);
    assert.match(html, /Or upload server certificate/);
    assert.match(html, /PCM client credentials/);
    assert.match(html, /Source HTTPS trust/);
    assert.match(html, /pcmClientAuthCertFile/);
    assert.match(html, /pcmClientAuthKeyFile/);
    assert.match(html, /credentialProfile/);
    assert.match(html, /Generate sandbox credentials/);
    assert.match(html, /reusePcmClientCertForServerTrust/);
    assert.match(html, /only when the source actually serves that same certificate/);
    assert.match(html, /\/admin\/config\/data-sources\/add/);
    assert.match(html, /Legacy source custom upstream FHIR server URL/);
    assert.match(html, /dsGatewayToFhirServerCustomUrl/);
    assert.match(html, /Identity mapping overrides/);
    assert.match(html, /Managed HAPI resolves its own Patient data/);
    assert.match(html, /system\|value/);
    assert.match(html, /<th[^>]*>Naming system<\/th><th[^>]*>Business value<\/th>/);
    assert.match(html, /Bare identifiers are resolved as http:\/\/fhir\.health\.gov\.il\/identifier\/il-national-id/);
    assert.match(html, /Bare values are preserved as entered/);
    assert.match(html, /businessId/);
    assert.match(html, /internalId/);
    assert.match(html, /\/admin\/config\/identity-mapping\/add/);

    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ui.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'admin', 'source-form.ejs'), 'utf8');
    assert.match(source, /Download JSON/);
    assert.match(source, /Download ZIP/);
    assert.match(source, /admin-source-exports/);
    assert.match(source, /prepareSourceCredentials/);
    assert.match(source, /reusePcmClientCertificateForServerTrust/);
    assert.match(source, /\/admin\/config\/identity-mapping\/remove/);
    assert.match(source, /\/admin\/config\/data-sources\/:id\/cert\/generate/);
    assert.match(source, /\/admin\/config\/data-sources\/:id\/client-bundle/);
    assert.match(source, /\/admin\/config\/data-sources\/:id\/client-bundle\.zip/);
    assert.match(source, /client-bundle\.zip/);
    assert.match(source, /\/admin\/config\/data-sources\/:id\/server-trust\/ca/);
    assert.match(source, /\/admin\/config\/data-sources\/:id\/server-trust\/thumbprint/);
});

test('admin UI renders admin errors inline with expandable details', () => {
    const router = require('../src/routes/ui');
    const html = router._test.renderAdminHtml(null, {
        adminError: {
            statusCode: 400,
            message: 'FHIR base URL must be an absolute HTTP or HTTPS URL.',
            details: {
                field: 'endpoint',
                received: '(empty)',
                help: 'Use the data source FHIR base URL, including the scheme, for example https://team-source.example.org/fhir.'
            }
        }
    });

    assert.match(html, /Could not complete admin action/);
    assert.match(html, /FHIR base URL must be an absolute HTTP or HTTPS URL\./);
    assert.match(html, /<span class="badge bg-danger">400<\/span>/);
    assert.match(html, /<details class="mt-2">/);
    assert.match(html, /&quot;field&quot;: &quot;endpoint&quot;/);
    assert.match(html, /https:\/\/team-source\.example\.org\/fhir/);
});

test('admin error helper serves HTML to browsers and JSON to API clients', () => {
    const router = require('../src/routes/ui');

    const browserRes = {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        send(body) {
            this.body = body;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
    router._test.sendAdminError({ get: name => (name === 'accept' ? 'text/html,application/xhtml+xml' : '') }, browserRes, 400, 'Bad admin input.', { field: 'endpoint', help: 'Fix the endpoint URL and retry.' });
    assert.equal(browserRes.statusCode, 400);
    assert.match(browserRes.body, /Could not complete admin action/);
    assert.match(browserRes.body, /Bad admin input\./);
    assert.match(browserRes.body, /Fix the endpoint URL and retry\./);

    const apiRes = {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        send(body) {
            this.body = body;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
    router._test.sendAdminError({ get: () => 'application/json' }, apiRes, 400, 'Bad admin input.', { field: 'endpoint', help: 'Fix the endpoint URL and retry.' });
    assert.equal(apiRes.statusCode, 400);
    assert.deepEqual(apiRes.body, { error: 'Bad admin input.', field: 'endpoint', help: 'Fix the endpoint URL and retry.' });
});

test('PCM client certificate reuse pins Doctor Portal server trust to the same thumbprint', () => {
    const router = require('../src/routes/ui');
    const source = {
        certThumbprint: null,
        pcmClientAuth: { certThumbprint: 'abcDEFghiJKLmnopQRSTuvwxYZ0123456789' },
        serverTrust: { mode: 'custom-ca', caCert: 'custom/source-ca.crt', certThumbprint: 'old' }
    };

    assert.equal(router._test.reusePcmClientCertificateForServerTrust(source), true);
    assert.equal(source.serverTrust.mode, 'pinned-thumbprint');
    assert.equal(source.serverTrust.certThumbprint, source.pcmClientAuth.certThumbprint);
    assert.equal(source.certThumbprint, source.pcmClientAuth.certThumbprint);
});

test('PCM client certificate reuse requires a PCM client thumbprint', () => {
    const router = require('../src/routes/ui');
    const source = { pcmClientAuth: {}, serverTrust: { mode: 'team-root-ca' } };

    assert.equal(router._test.reusePcmClientCertificateForServerTrust(source), false);
    assert.equal(source.serverTrust.mode, 'team-root-ca');
});

test('admin route messages include actionable recovery guidance', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ui.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'src', 'source-registration-command.js'), 'utf8');

    assert.match(source, /Admin authentication is required/);
    assert.match(source, /x-admin-password header/);
    assert.match(source, /received: endpoint \|\| '\(empty\)'/);
    assert.match(source, /Unsupported source HTTPS trust mode/);
    assert.match(source, /Bundles are available only for custom consent approval data sources/);
    assert.match(source, /Custom source was not found; refresh Sources/);
    assert.match(source, /Disable this source before removing its registration/);
    assert.match(source, /Choose a custom CA certificate file before uploading/);
    assert.match(source, /Choose Generate sandbox credentials or Upload existing credentials/);
    assert.match(source, /Credential material is missing/);
    assert.match(source, /No backup contents are echoed/);
});

test('admin UI renders sanity check result inline with collapsible details', () => {
    const router = require('../src/routes/ui');
    const html = router._test.renderAdminHtml({query:{section:'logs'}}, {
        sanityResult: {
            ok: false,
            exitCode: 1,
            result: { status: 'fail', checks: [{ name: 'sp-health', status: 'fail' }] },
            targets: {
                spBaseUrl: 'http://localhost:3002',
                pcmUiBaseUrl: 'http://localhost:3001',
                referenceDsBaseUrl: 'https://localhost:8080/fhir',
                referenceDsHealthUrl: 'http://localhost:8081/healthz'
            }
        }
    });

    assert.match(html, /Failed — review the checks below/);
    assert.match(html, /<summary[^>]*>Technical details<\/summary>/);
    assert.match(html, /sp-health/);
    assert.match(html, /http:\/\/localhost:3002/);
});

test('sanity targets use ECS localhost ports when running in AWS', () => {
    const router = require('../src/routes/ui');
    const previousAwsExecutionEnv = process.env.AWS_EXECUTION_ENV;
    const previousSp = process.env.SANITY_SP_BASE_URL;
    const previousPcm = process.env.SANITY_PCM_UI_BASE_URL;
    const previousDs = process.env.SANITY_REFERENCE_DS_BASE_URL;
    const previousDsHealth = process.env.SANITY_REFERENCE_DS_HEALTH_URL;

    process.env.AWS_EXECUTION_ENV = 'AWS_ECS_FARGATE';
    delete process.env.SANITY_SP_BASE_URL;
    delete process.env.SANITY_PCM_UI_BASE_URL;
    delete process.env.SANITY_REFERENCE_DS_BASE_URL;
    delete process.env.SANITY_REFERENCE_DS_HEALTH_URL;

    const targets = router._test.getSanityTargets({ internalBaseUrls: { referenceDataSource: 'https://ds-gateway:8080/fhir' } });
    assert.deepEqual(targets, {
        spBaseUrl: 'http://localhost:3002',
        pcmUiBaseUrl: 'http://localhost:3001',
        referenceDsBaseUrl: 'https://localhost:8080/fhir',
        referenceDsHealthUrl: 'http://localhost:8081/healthz'
    });

    if (previousAwsExecutionEnv === undefined) delete process.env.AWS_EXECUTION_ENV;
    else process.env.AWS_EXECUTION_ENV = previousAwsExecutionEnv;
    if (previousSp === undefined) delete process.env.SANITY_SP_BASE_URL;
    else process.env.SANITY_SP_BASE_URL = previousSp;
    if (previousPcm === undefined) delete process.env.SANITY_PCM_UI_BASE_URL;
    else process.env.SANITY_PCM_UI_BASE_URL = previousPcm;
    if (previousDs === undefined) delete process.env.SANITY_REFERENCE_DS_BASE_URL;
    else process.env.SANITY_REFERENCE_DS_BASE_URL = previousDs;
    if (previousDsHealth === undefined) delete process.env.SANITY_REFERENCE_DS_HEALTH_URL;
    else process.env.SANITY_REFERENCE_DS_HEALTH_URL = previousDsHealth;
});

test('admin sanity check uses post-redirect-get for browser requests', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ui.js'), 'utf8');

    assert.match(source, /lastSanityResult = output/);
    assert.match(source, /res\.redirect\(303, uiUrl\('\/admin\?section=logs'\)\)/);
    assert.match(source, /renderAdminHtml\(req, \{ sanityResult: lastSanityResult \}\)/);
});

test('admin sanity check logs runner failures when target services are down', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'ui.js'), 'utf8');

    assert.match(source, /Sanity Check Started/);
    assert.match(source, /SANITY_CHECK_STARTED/);
    assert.match(source, /Sanity Check \$\{output\.ok \? 'Completed' : 'Failed'\}/);
    assert.match(source, /SANITY_CHECK_FAILED/);
    const summary = source.slice(source.indexOf("type: output.ok ? 'SANITY_CHECK_COMPLETED'"), source.indexOf('resolve(output);', source.indexOf("type: output.ok ? 'SANITY_CHECK_COMPLETED'")));
    assert.match(summary, /visibility: 'diagnostic'/);
    assert.match(source, /failedChecks/);
});

test('deployment endpoint inventory preserves configured URLs and separate reachable navigation', t => {
    const previous = process.env.TEAM_CONFIG_PATH;
    process.env.TEAM_CONFIG_PATH = path.resolve(__dirname, '../../../pcm-connectathon/example-team-config.json');
    t.after(() => {
        if (previous === undefined) delete process.env.TEAM_CONFIG_PATH; else process.env.TEAM_CONFIG_PATH = previous;
    });
    const router = require('../src/routes/ui');
    const req = {
        protocol: 'http',
        get(name) {
            return {
                host: 'team-a.example.org:8081',
                'x-forwarded-proto': 'https',
                'x-forwarded-host': 'team-a.example.org'
            }[String(name).toLowerCase()];
        }
    };

    const endpoints = router._test.buildDeploymentEndpoints(req);
    const pcmUi = endpoints.find(endpoint => endpoint.key === 'pcmUi' && endpoint.audience === 'public');
    const pcmApi = endpoints.find(endpoint => endpoint.key === 'pcmApi' && endpoint.audience === 'public');
    const dsMetadata = endpoints.find(endpoint => endpoint.key === 'dataSourceMetadata');

    assert.equal(pcmUi.url, 'http://localhost:4100');
    assert.equal(pcmUi.diagnosticUrl, 'http://team-a.example.org:4100/ui');
    assert.equal(pcmUi.port, '4100');
    assert.equal(pcmUi.source, 'team-config');
    assert.equal(pcmApi.port, '4101');
    assert.equal(dsMetadata.url, 'http://localhost:8184');
});

test('multipart parser reads text fields and uploaded certificate files', () => {
    const router = require('../src/routes/ui');
    const boundary = 'pcm-test-boundary';
    const body = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="name"',
        '',
        'Team Source',
        `--${boundary}`,
        'Content-Disposition: form-data; name="serverTrustCaFile"; filename="ca.crt"',
        'Content-Type: application/x-x509-ca-cert',
        '',
        '-----BEGIN CERTIFICATE-----',
        'abc',
        '-----END CERTIFICATE-----',
        `--${boundary}--`,
        ''
    ].join('\r\n');
    const req = {
        rawBody: Buffer.from(body, 'utf8'),
        get(name) {
            return String(name).toLowerCase() === 'content-type'
                ? `multipart/form-data; boundary=${boundary}`
                : '';
        }
    };

    const parsed = router._test.parseMultipartForm(req);

    assert.equal(parsed.fields.name, 'Team Source');
    assert.equal(parsed.files.serverTrustCaFile.fileName, 'ca.crt');
    assert.match(parsed.files.serverTrustCaFile.content, /BEGIN CERTIFICATE/);
});

test('custom data-source client bundle can be represented as JSON metadata plus ZIP files', () => {
    const router = require('../src/routes/ui');
    const source = {
        id: 'org-custom',
        name: 'Custom',
        pcmClientAuth: { cert: 'missing-client.crt', key: 'missing-client.key' },
        serverTrust: { caCert: 'missing-ca.crt' }
    };
    const bundle = router._test.buildDataSourceClientBundle({
        contract: { operational: { oauthBase: 'https://pcm2mtest.health.gov.il/api/fhir-service/r4', fhirBase: 'https://pcm2mtest.health.gov.il/api/fhir-service/r4' } },
        publicBaseUrls: {
            pcmApi: 'https://pcm.example.org:4101',
            pcmMetadata: 'https://pcm.example.org:4102'
        }
    }, source);
    const zip = router._test.buildZip({
        'bundle.json': JSON.stringify({ ...bundle, certificates: undefined }, null, 2)
    });

    assert.equal(bundle.pcm.tokenEndpoint, 'https://pcm.example.org:4101/token');
    assert.equal(bundle.pcm.metadataEndpoint, 'https://pcm.example.org:4102/.well-known/oauth-authorization-server');
    assert.deepEqual(bundle.certificates, {});
    assert.throws(()=>router._test.buildDataSourceClientBundle({}, {...source,serverTrust:{mode:'system-ca',caCert:'rootCA.key'}}),/managed CA/);
    assert.ok(zip.includes(Buffer.from('bundle.json')));
});

test('approveConsent stores only selected source actors and selected token scope', () => {
    const router = require('../src/routes/ui');
    const store = require('../src/fhir/store');
    const { loadTeamConfig } = require('../src/team-config');
    const config = loadTeamConfig();
    const sourceId = config.organizations.referenceDataSource.id;
    const consent = seedPendingConsent(store, config, 'consent-approval-test');
    const { URL, readApprovalSnapshot } = require('../../shared/consent-scope-snapshot');
    const { SANDBOX_EXTENSIONS } = require('../../shared/pcm-contract');
    const exclusion = `_security:not=${require('../../shared/service-confidentiality-policy').SYSTEM}|V`;
    const scope = `patient/Patient.rs?${exclusion} patient/Observation.s?status=final&${exclusion}`;
    assert.equal(consent.status, 'proposed');
    const approved = router._test.approveConsent(consent, {
        sourceIds: [sourceId], scopeChoice: 'custom', customScope: scope,
        expectedVersion: consent.meta.versionId
    });

    const actorRefs = approved.provision.actor.map(actor => actor.reference.reference);
    assert.deepEqual(actorRefs, ['Organization/org-sp', `Organization/${sourceId}`]);
    assert.equal(approved.status, 'active');
    const snapshot = store.privateRecords.approvals.getDecision(approved.id).snapshot;
    assert.equal(snapshot.scope, scope);
    assert.equal(snapshot.choice, 'custom');
    assert.equal(snapshot.origin, 'manual');
    assert.equal(snapshot.usable, true);
    assert.equal(snapshot.approvedAt, approved.provision.period.start);
    assert.equal(approved.extension.find(ext => ext.url === SANDBOX_EXTENSIONS.approvedTokenScope), undefined);
    assert.equal(approved.extension.find(ext => ext.url === SANDBOX_EXTENSIONS.approvedTokenScopeOrigin), undefined);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized, JSON.stringify(snapshot));
    assert.throws(() => router._test.approveConsent(approved, {
        sourceIds: [sourceId], scopeChoice: 'custom', customScope: scope.replace('status=final', 'status=preliminary'),
        expectedVersion: approved.meta.versionId
    }), error => error.status === 409);
    assert.deepEqual(store.get('Consent', approved.id), approved);
    assert.equal(JSON.stringify(store.privateRecords.approvals.getDecision(approved.id).snapshot), serialized);

    store.clear();
});

test('approveConsent preserves zero selected source actors when explicitly requested', () => {
    const router = require('../src/routes/ui');
    const store = require('../src/fhir/store');
    const { loadTeamConfig } = require('../src/team-config');
    const { URL, readApprovalSnapshot } = require('../../shared/consent-scope-snapshot');
    const { SANDBOX_EXTENSIONS } = require('../../shared/pcm-contract');
    const exclusion = `_security:not=${require('../../shared/service-confidentiality-policy').SYSTEM}|V`;
    const scope = `patient/Patient.rs?${exclusion} patient/Observation.rs?${exclusion}`;
    const consent = seedPendingConsent(store, loadTeamConfig(), 'consent-zero-source-test');
    assert.equal(consent.status, 'proposed');
    const approved = router._test.approveConsent(consent, {
        sourceIds: [], scopeChoice: 'custom', customScope: scope,
        expectedVersion: consent.meta.versionId
    });

    assert.equal(approved.status, 'active');
    const sourceActors = approved.provision.actor.filter(actor => actor.role?.coding?.some(code => code.code === 'CST'));
    assert.deepEqual(sourceActors, []);
    const snapshot = store.privateRecords.approvals.getDecision(approved.id).snapshot;
    assert.equal(snapshot.scope, scope);
    assert.equal(snapshot.choice, 'custom');
    assert.equal(snapshot.origin, 'manual');
    assert.equal(snapshot.usable, true);
    assert.equal(snapshot.approvedAt, approved.provision.period.start);
    assert.equal(approved.extension.find(ext => ext.url === SANDBOX_EXTENSIONS.approvedTokenScopeOrigin), undefined);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized, JSON.stringify(snapshot));
    assert.throws(() => router._test.approveConsent(approved, {
        sourceIds: [], scopeChoice: 'custom', customScope: scope,
        expectedVersion: approved.meta.versionId
    }), error => error.status === 409);
    assert.deepEqual(store.get('Consent', approved.id), approved);
    assert.equal(JSON.stringify(store.privateRecords.approvals.getDecision(approved.id).snapshot), serialized);

    store.clear();
});

test('approveConsent defaults to all configured sources only when sourceIds is omitted', () => {
    const router = require('../src/routes/ui');
    const store = require('../src/fhir/store');
    const { loadTeamConfig } = require('../src/team-config');
    const { getConfiguredDataSources } = require('../src/data-sources');
    const configuredSourceIds = getConfiguredDataSources(loadTeamConfig()).map(source => source.id);
    const consent = seedPendingConsent(store, loadTeamConfig(), 'consent-default-source-test');
    const approved = router._test.approveConsent(consent);

    const sourceRefs = approved.provision.actor
        .filter(actor => actor.role?.coding?.some(code => code.code === 'CST'))
        .map(actor => actor.reference.reference);
    assert.deepEqual(sourceRefs, configuredSourceIds.map(id => `Organization/${id}`));

    store.clear();
});
