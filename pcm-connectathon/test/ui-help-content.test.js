'use strict';
/** Verify authored help, generated copy and actual static/dynamic bindings together. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { parseCatalog, projection } = require('../../scripts/generate-ui-help');
const { SIMULATION_CONTROLS } = require('../../src/shared/conformance-policy');
const scopeHelpKeys = ['auto-resources', 'auto-buckets', 'authored', 'custom'];
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const catalog = parseCatalog(read('docs/ui-explanation-catalog.md'));
const templates = [
    ...['dashboard', 'consent', 'authorize', 'logs', 'system-authentication', 'services'].map(name => `src/pcm-core/src/views/${name}.ejs`),
    ...['index', 'patients', 'manage', 'logs'].map(name => `src/sp-client/src/views/${name}.ejs`)
];

test('help projection is deterministic and malformed or duplicate authored keys fail', () => {
    assert.equal(projection(), read('src/shared/ui/help-copy.js'));
    const row = '| `common.explain` | Help | Authored body | — |';
    assert.throws(() => parseCatalog(`${row}\n${row}`), /Duplicate/);
    assert.throws(() => parseCatalog(`${row}\n| ` + '`broken` | missing columns |'), /Malformed/);
    assert.throws(() => parseCatalog(''), /empty/);
    assert.equal(parseCatalog(row)['common.explain'].technical, '');
});

test('every catalog key has an explicit static, generated or option binding with no unknown keys', () => {
    const adminSources = [
        ...fs.readdirSync(path.join(root, 'src/pcm-core/src/views/admin')).filter(name => name.endsWith('.ejs')).map(name => `src/pcm-core/src/views/admin/${name}`),
        ...['admin-view','admin-data-view','admin-shell'].map(name => `src/pcm-core/src/routes/${name}.js`)
    ];
    const source = [...templates, ...adminSources, 'src/sp-client/src/views/sandbox-notice.ejs', 'src/shared/ui/log-fhir-exchange.js', 'src/pcm-core/src/routes/ui.js', 'src/pcm-core/src/workflow-presentation.js', 'src/shared/ui/connectathon.js', 'src/shared/ui/help.js', 'src/shared/ui/help-values.js', 'src/shared/ui/source-change.js', 'src/shared/ui/services.js', 'src/shared/ui/log-record-explorer.js', 'src/pcm-core/src/deployment-help.js'].map(read).join('\n');
    const found = new Set([...source.matchAll(/data-help-(?:key|disabled-key)="([\w.-]+)"/g)].map(match => match[1]));
    for (const match of source.matchAll(/helpKey:\s*'([\w.-]+)'/g)) found.add(match[1]);
    for (const match of source.matchAll(/(?:addLine|helpKey\s*=)\(?\s*'([\w.-]+)'/g)) found.add(match[1]);
    for (const match of source.matchAll(/'(logs\.(?:(?:role|level|class)-[\w-]+|explorer|field-search|copy-value)|admin\.endpoint-[\w-]+|doctor\.identity-(?:primary|secondary|registered|untrusted|untrusted-assertion))'/g)) found.add(match[1]);
    for (const key of source.matchAll(/'(workflow\.[\w.-]+)'/g)) found.add(key[1]);
    for (const key of read('src/shared/ui/help-values.js').matchAll(/'(logs\.[\w.-]+)'/g)) found.add(key[1]);
    for (const [area] of require('../../src/pcm-core/src/routes/admin-shell').areas) found.add(`admin.area-${area}`);
    for (const { key } of require('../../src/pcm-core/src/admin-source-limits').FIELDS) found.add(`admin.limit-${key}`);
    for (const group of new Set(require('../../src/pcm-core/src/admin-workflows').FIELDS.map(field => field.group))) found.add(`admin.workflow-${group}`);
    for (const name of SIMULATION_CONTROLS) found.add(`simulation.${name}`);
    for (const key of scopeHelpKeys) found.add(`scope.${key}`);
    for (const key of ['activate', 'enable', 'disable', 'delete']) found.add(`services.${key}`);
    for (const key of read('src/shared/ui/source-change.js').matchAll(/'(pcm\.[\w.-]+)'/g)) found.add(key[1]);
    // These values are explicitly selected by name in authored template branches.
    for (const key of ['doctor.identity-registered', 'doctor.identity-untrusted', 'doctor.identity-untrusted-assertion']) {
        assert.ok(source.includes(key) || source.includes(key.split('.').at(-1)), key);
        found.add(key);
    }
    // The notice builds tab keys in EJS; rendering observes the actual bindings.
    const notice = ejs.render(read('src/sp-client/src/views/sandbox-notice.ejs'), {
        sandboxNotice: { sources: [] },
        conformance: { mode: 'strict', resultLabel: 'STRICT SANDBOX', version: 'test', warnings: [] }
    });
    for (const key of notice.matchAll(/data-help-key="([\w.-]+)"/g)) found.add(key[1]);
    assert.deepEqual([...found].filter(key => !catalog[key]), []);
    assert.deepEqual(Object.keys(catalog).filter(key => !found.has(key)), []);
});

test('page templates render valid authored keys, team scope and local help assets in populated and empty states', () => {
    const base = {
        consentPresentation: require('../../src/shared/consent-presentation'),
        scopePresentation: require('../../src/shared/ui/approval-scopes'),
        context: null, bypasses: [], ownerCsrf: () => 'owned-csrf', list: { owned: [], available: [], others: [] }, templates: require('../../src/pcm-core/src/service-templates').loadTemplates(), views: [], targets: [], providers: [{role:'serviceProvider',id:'provider',name:'Provider'}], role:'serviceProvider', error:'', warnings:[], privateActionsUnavailable:false, formCsrf:'test', nextPage:'', categoryLabels: {}, bucketResources: {}, units: require('../../src/pcm-core/src/service-definition-form').UNITS, sensitivityLabels: [],
        workflowUrl: 'https://pcm.test/sandbox/authentication', assetBase: '', notice: null, input: { homeHmoId: '', identifier: '', system: '', birthDate: '' }, identifierTypes: [], patientChoices: [], hmoChoices: [], canStart: false, consentUrl: 'http://pcm.test/ui', logsUrl: 'http://pcm.test/logs-view', adminUrl: 'http://pcm.test/admin',
        authenticationMethod: 'home-HMO / local OTP', ssoChoices: [], fixtureChoices: [],
        stage: 'start', environment: 'test', base: '/sandbox/authentication', csrfToken: 'test-csrf', error: null, localCode: null, homeHmo: null, verified: null, presence: null, discovery: null, selected: null, doctorUrl: 'http://sp.test',
        teamId: 'help-team', currentIdentity: 'hospital-a', identity: 'hospital-a',
        identities: [{ id: 'hospital-a', label: 'Registered' }, { id: 'untrusted', label: 'Untrusted' }, { id: 'untrusted-assertion', label: 'Bad signature' }],
        patients: [{ subject: 'test', display: 'Synthetic', idSystem: 'urn:test', idValue: '1', sources: [{ serverId: 'ho-a' }] }],
        patientInventory: { state: 'ready' }, selectedPatientId: '1', flash: null,
        conformance: { mode: 'strict', resultLabel: 'Strict', warnings: [], version: 'test' },
        publicBaseUrls: { pcmApi: 'https://pcm.test/api/fhir-service/r4', pcmUi: 'http://pcm.test', spClient: 'http://sp.test' },
        publicUrls: { pcmUi: 'http://pcm.test', spClient: 'http://sp.test' },
        consents: [{ id: 'test', status: 'active', consent: { status: 'active', discoveredEndpoints: [{ url: 'https://source.test', name: 'Source' }] }, patient: { identifier: { value: '1' } } }],
        consent: { id: 'test', status: 'proposed', patient: { identifier: { value: '1' } } }, requesterName: 'Requester', serviceName: 'Service',
        fixed: [{ display: 'Offline test', idSystem: 'urn:test', idValue: '1' }],
        sources: [{ id: 'ho-a', name: 'HO A' }], state: { sourceId: 'ho-a', state: 'unloaded' },
        sourceView: { canEdit: true, notice: 'Sandbox only', current: ['ho-a'], version: '2', choices: [{ id: 'ho-a', name: 'HO A', eligible: true, selected: true, state: 'available' }] }, sourceCsrf: 'csrf',
        dataSources: [{ id: 'ho-a', name: 'HO A', endpoint: 'https://source.test', selected: true }],
        scopeOptions: [{ description: 'Generated complete choice', diagnostics: { syntax: 'valid', applicability: 'valid', capability: 'supported', issues: [] }, id: 'auto-resources', kind: 'generated', label: 'All service resource types — Auto-generated', value: 'patient/Patient.rs patient/Observation.rs' }, { description: 'Authored choice', diagnostics: { syntax: 'valid', applicability: 'valid', capability: 'supported', issues: [] }, id: 'lab-search', kind: 'authored', label: 'Laboratory search', value: 'patient/Observation.s' }], selectedScope: 'patient/Patient.rs patient/Observation.rs',
        clientName: 'Client', transactionId: 'transaction', scopes: ['patient/*.rs'], selfChanged: false, permissions: require('../../src/pcm-core/src/smart-presentation').describeScopes(['patient/*.rs']), technical: { clientId: 'client', callback: 'https://doctor.test/callback', audience: 'https://pcm.test/r4' }, message: 'Restart the test', errorCode: 'invalid_request',
        orgs: [{ id: 'org', name: 'Organization' }], endpoints: [{ id: 'endpoint', name: 'Endpoint' }]
    };
    for (const file of templates) {
        for (const state of ['proposed', 'active']) for (const empty of [false, true]) for (const browserBase of ['', '/mount']) {
            const populated = { ...base, flash: file.endsWith('sp-client/src/views/index.ejs') ? { smart: true, type: 'success', message: 'SMART code exchange completed', explanation: 'No clinical retrieval', scope: 'patient/Observation.rs' } : null, browserBase, assetBase: browserBase, base: `${browserBase}/sandbox/authentication`, consent: { ...base.consent, status: state } };
            const locals = empty ? { ...populated, flash: null, patients: [], sources: [], consents: [], orgs: [], endpoints: [], dataSources: [] } : populated;
            const html = ejs.render(read(file), locals, { filename: file });
            assert.match(html, /data-help-team="help-team"/, file);
            assert.equal(html.split(`src="${browserBase}/assets/help.js"`).length - 1, 1, file);
            assert.equal(html.split(`src="${browserBase}/assets/help-copy.js"`).length - 1, 1, file);
            for (const match of html.matchAll(/data-help-key="([\w.-]+)"/g)) assert.ok(catalog[match[1]], `${file}: ${match[1]}`);
            for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new (require('node:vm').Script)(script[1]);
            if (browserBase) for (const attr of html.matchAll(/(?:href|action|src|formaction)="(\/(?!\/)[^"]*)"/g)) assert.ok(attr[1].startsWith(browserBase + '/'), `${file}: ${attr[1]}`);
            assert.doesNotMatch(html, /<[^>]+data-help-key="[^"]+"[^>]+data-help-key=/, file);
        }
    }
});


test('PCM owns the workflow navigation and Doctor keeps its ordinary clinical tools', () => {
    const template = read('src/sp-client/src/views/index.ejs');
    assert.doesNotMatch(template, /sandbox\/authentication/);
    assert.match(read('src/pcm-core/src/views/dashboard.ejs'), /data-help-key="workflow.start"[^>]+href="<%= workflowUrl %>"/);
    assert.match(catalog['workflow.start'].body, /Consent/);
});

test('requesting-application help does not promise a shared certificate or fixed configurable signing algorithm', () => {
    for (const key of ['doctor.identity-primary', 'doctor.identity-secondary']) {
        assert.match(catalog[key].body, /application/);
        assert.doesNotMatch(catalog[key].body, /shared.*(?:certificate|key)|P-256|P-384|ES256|ES384/);
        assert.match(catalog[key].technical, /registration|registered/);
        assert.match(catalog[key].technical, /transport.*assertion/i);
    }
});
