'use strict';
/** Source directory capabilities, exact target rendering and protected legacy mapping commands. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { installTestRuntime, buildTeamConfig } = require('../../../test-support/team-config');
const initial = installTestRuntime({ publicBaseUrls: { pcmUi: 'http://localhost:14100/pcm' } });
const { sourceDirectory, sourceWorkspace } = require('../src/routes/admin-source-model');
const { getConfiguredDataSources } = require('../src/data-sources');
const { managedFhirServers } = require('../src/data-operations');
const router = require('../src/routes/ui');
const render = query => router._test.renderAdminHtml({ query: { section: 'sources', ...query } });
const configFile = process.env.TEAM_CONFIG_PATH;
const saved = () => JSON.parse(fs.readFileSync(configFile));
const store = { ...require('../src/store'), store: require('../src/fhir/store') };

/** Restore the owned baseline between tests so revisions and other-source bytes stay explicit. */
test.afterEach(() => fs.writeFileSync(configFile, JSON.stringify(initial)));

test('zero/one/many and fourth IDs preserve hosting, institution, role and unavailable states independently', () => {
    assert.deepEqual(sourceDirectory([], []), []);
    for (const count of [1, 4]) {
        const sources = Array.from({ length: count }, (_, i) => ({ id: `fourth-independent-${i}`, healthOrganizationId: `owner-${i}`, builtIn: true, institutionType: i ? 'hospital' : 'hmo', name: 'Long name '.repeat(30), endpoint: 'https://source.test/fhir' }));
        const rows = sourceDirectory(sources, sources.map(source => ({ id: source.id + '-private', healthOrganizationId: source.healthOrganizationId })));
        assert.equal(rows.length, count); assert.equal(rows.at(-1).hosting, 'managed');
        assert.ok(rows.every(row => row.tabs.includes('data') && row.role === 'Data source'));
        assert.deepEqual(rows.map(row => row.institutionType), sources.map(source => source.institutionType));
        assert.equal(sourceWorkspace({ query: { source: sources.at(-1).id } }, rows).selected.id, sources.at(-1).id);
    }
    const shell = require('../src/routes/admin-shell');
    for (const count of [0, 1, 4]) {
        const config = buildTeamConfig();
        config.healthOrganizations = Array.from({length: count}, (_, i) => ({ ...config.healthOrganizations[i % 3], id: `owner-${i}`, institutionType: i ? 'hospital' : 'hmo', name: `Managed fourth ${i}`, dataSourceOrganization: { id: `managed-fourth-${i}` } }));
        config.legacyDataSource.enabled = false;
        config.organizations.dataSources = Array.from({length: count}, (_, i) => ({id:`custom-fourth-${i}`,name:`Custom <${i}>`,institutionType:'other',endpoint:'https://external.example.test/fhir'}));
        const renderedRows = sourceDirectory(getConfiguredDataSources(config, { includeDisabled: true }), []);
        const html = shell.partial('source-workspace', { workspace: {}, sourceDirectory: renderedRows, req: {query:{}}, options: {}, basePath: '/pcm', shell, partial: () => '' });
        assert.ok(html.includes(`Managed HAPI (${count})`)); assert.ok(html.includes(`Custom sources (${count})`));
        assert.equal((html.match(/data-source-address=/g)||[]).length, count * 2);
        if (count === 4) { assert.match(html, /managed-fourth-3/); assert.match(html, /Custom &lt;3&gt;/); }

        const rows = sourceDirectory(Array.from({ length: count }, (_, i) => ({ id: `custom-${i}`, institutionType: 'hmo', enabled: i !== 0, endpoint: i === 2 ? '' : 'https://custom.test/fhir' })), []);
        assert.equal(rows.length, count);
        assert.ok(rows.every(row => row.hosting === 'custom' && !row.tabs.includes('data')));
        if (count) assert.match(rows[0].status, /Disabled/);
        if (count > 2) assert.equal(rows[2].available, false);
    }
});

test('registry selection renders one owner, exact escaped facts, classified managed fixtures and no fallback', () => {
    const config = saved();
    config.healthOrganizations.forEach((source, i) => { source.institutionType = i ? 'hospital' : 'hmo'; });
    config.healthOrganizations[2].name = '<Fourth & long> ' + 'name'.repeat(80);
    const custom = require('../src/data-sources').toConfigDataSource({ id: 'fourth-rendered-custom', name: 'Fourth custom <exact>', endpoint: 'https://fourth.example.test/fhir', institutionType: 'hmo' });
    custom.pcmClientAuth.certThumbprint = 'A'.repeat(43); config.organizations.dataSources = [custom];
    fs.writeFileSync(configFile, JSON.stringify(config));
    const sources = getConfiguredDataSources(config, { includeDisabled: true });
    const before = fs.readFileSync(configFile), tokenCount = store.tokens.size, consentCount = store.store.getAll('Consent').length, patientCount = store.store.getAll('Patient').length;
    const directory = render({});
    assert.match(directory, /Managed HAPI \(3\)/); assert.match(directory, /Hospital/); assert.match(directory, /&lt;Fourth &amp; long&gt;/);
    assert.doesNotMatch(directory, /data-async-operation|name="institutionType"/);
    for (const source of sources) {
        const rows = sourceDirectory(sources, managedFhirServers(config)), row = rows.find(item => item.id === source.id);
        for (const view of row.tabs) {
            const html = render({ source: source.id, view });
            assert.equal((html.match(/data-source-workspace=/g) || []).length, 1);
            assert.ok(html.includes(`data-source-workspace="${source.id}"`));
            assert.equal(/data-managed-fhir-server=/.test(html), view === 'data');
            if (view === 'data') assert.equal((html.match(/data-managed-fhir-server=/g) || []).length, 1);
            if (row.hosting !== 'legacy') assert.doesNotMatch(html, /name="businessId"|name="dsGatewayToFhirServerCustomUrl"/);
            if (row.hosting === 'custom' && view === 'credentials') { assert.match(html, /client-bundle.zip/); assert.match(html, /cert\/generate/); }
            if (row.hosting === 'custom' && view === 'trust') assert.match(html, /server-trust\/thumbprint/);
        }
    }
    const stale = render({ source: '<missing>' });
    assert.match(stale, /no longer configured/); assert.doesNotMatch(stale, /data-source-workspace=|data-async-operation|name="institutionType"/);
    const failedRemoved = router._test.renderAdminHtml({path:'/admin/config/data-sources/remove',body:{id:'removed-owned-source'},query:{section:'sources',source:sources[0].id}}, {adminError:{message:'Source is gone',statusCode:404}});
    assert.match(failedRemoved,/no longer configured/);assert.doesNotMatch(failedRemoved,/data-source-workspace=/);
    const inherited = Object.assign(Object.create({ path: '/admin/config/identity-mapping/add' }), { body: { businessId: '000000018', internalId: 'exact-draft' }, query: {} });
    const failure = router._test.renderAdminHtml(inherited, { section: 'sources', adminError: { message: 'Owned error', statusCode: 400 } });
    assert.match(failure, /value="exact-draft"/);
    const source = sources[0]; assert.match(render({ source: source.id, view: 'mappings' }), /does not apply/);
    assert.deepEqual(fs.readFileSync(configFile), before); assert.equal(store.tokens.size, tokenCount);
    assert.equal(store.store.getAll('Consent').length, consentCount); assert.equal(store.store.getAll('Patient').length, patientCount);
});

test('mounted source/view returns retain only known local context and malformed addresses stay bounded', () => {
    const shell = require('../src/routes/admin-shell');
    assert.equal(shell.safeReturn('/pcm/admin?section=sources&source=source-fourth&view=mappings&secret=x', '/pcm'), '/pcm/admin?section=sources&source=source-fourth&view=mappings');
    assert.equal(shell.safeReturn('/pcm/admin?section=sources&view=constructor', '/pcm'), '/pcm/admin?section=sources');
});

/** Execute unchanged protected route handlers with explicit response evidence. */
function command(route, body, params = {}, html = false) {
    const handler = router.stack.find(layer => layer.route?.path === route).route.stack[0].handle;
    const response = { code: 200, status(value) { this.code = value; return this; }, json(value) { this.value = value; return this; }, send(value) { this.value = value; return this; }, redirect(value) { this.location = value; }, format(types) { (html ? types.html : types.json)(); } };
    handler({ body, params, path: route, query: {}, get: () => html ? 'text/html' : 'application/json' }, response);
    return response;
}

test('legacy mappings preserve bare/full/leading-zero/escaped identities and duplicate upsert/remove semantics without Patient or grant writes', () => {
    const before = saved(), patients = store.store.getAll('Patient'), consents = store.store.getAll('Consent'), tokens = store.tokens.size;
    const add = (businessId, internalId) => command('/admin/config/identity-mapping/add', { businessId, internalId });
    assert.equal(add('', 'local').code, 400); assert.equal(add('https://system.test|', 'local').code, 400); assert.equal(add('000000018', '').code, 400);
    assert.equal(add('000000018', 'Local<exact>&000000018').code, 201);
    const key = 'http://fhir.health.gov.il/identifier/il-national-id|000000018';
    assert.equal(saved().identityMapping.businessIdOverrides[key], 'Local<exact>&000000018');
    assert.equal(add(key, 'Local<replacement>&000000018').code, 201);
    assert.equal(add('https://other.test/naming|000000018', '000000018').code, 201);
    const legacy = getConfiguredDataSources(saved()).find(s => s.compatibilityOnly);
    const html = render({ source: legacy.id, view: 'mappings' });
    assert.match(html, /data-label="Naming system"/); assert.match(html, /Local&lt;replacement&gt;&amp;000000018/); assert.doesNotMatch(html, /Local<replacement>/);
    assert.doesNotMatch(html, /name="confirmation"|data-confirm=/);
    const after = saved(); assert.deepEqual(after.healthOrganizations, before.healthOrganizations); assert.deepEqual(after.organizations, before.organizations);
    assert.deepEqual(store.store.getAll('Patient'), patients); assert.deepEqual(store.store.getAll('Consent'), consents); assert.equal(store.tokens.size, tokens);
    const staleBytes = fs.readFileSync(configFile);
    const stale = command('/admin/config/identity-mapping/add', { adminForm: 'legacy-mapping', expectedRevision: -1, businessId: '000001', internalId: 'draft-local' }, {}, true);
    assert.equal(stale.code, 409); assert.match(stale.value, /Identity mappings changed/); assert.match(stale.value, /value="000001"/); assert.match(stale.value, /value="draft-local"/); assert.deepEqual(fs.readFileSync(configFile), staleBytes);
    const revision = saved().runtime.revision;
    assert.equal(command('/admin/config/identity-mapping/remove', { adminForm: 'legacy-mapping', expectedRevision: revision, businessId: key }).code, 200);
    assert.equal(saved().identityMapping.businessIdOverrides[key], undefined);
    assert.equal(saved().identityMapping.businessIdOverrides['https://other.test/naming|000000018'], '000000018');
    assert.equal(command('/admin/config/identity-mapping/remove', { adminForm: 'legacy-mapping', expectedRevision: revision, businessId: key }).code, 409);
});

test('classification stale guards and legacy-only upstream preserve native endpoints and preset validation', () => {
    for (const preset of ['connectathon-easy','connectathon-balanced','connectathon-mtls','strict']) {
        const config = buildTeamConfig({}, preset);
        const verification = require('../../shared/conformance-policy').presetSimulationDefaults(preset).serverCertificateVerification;
        config.security.serviceProviderToDataSource.verifyServerCertificate = verification; config.security.dsGatewayToFhirServer.verifyServerCertificate = verification;
        fs.writeFileSync(configFile, JSON.stringify({ ...config, runtime: initial.runtime }));
        const before = saved(), id = before.healthOrganizations[0].dataSourceOrganization.id;
        assert.equal(command('/admin/config/data-sources/:id/institution', { institutionType: 'hospital', expectedRevision: -1 }, { id }).code, 409);
        assert.equal(command('/admin/config/data-sources/:id/institution', { institutionType: 'hospital', expectedRevision: before.runtime.revision || 0 }, { id }).code, 200);
        const changed = saved(); assert.equal(changed.healthOrganizations[0].institutionType, 'hospital'); assert.deepEqual(changed.healthOrganizations.slice(1), before.healthOrganizations.slice(1));
        const upstream = { adminForm: 'legacy-upstream', expectedRevision: changed.runtime.revision, dsGatewayToFhirServerCustomUrl: 'http://legacy-upstream.test:8088/fhir' };
        assert.equal(command('/admin/config/security', { ...upstream, expectedRevision: -1 }).code, 409);
        const outcome = command('/admin/config/security', upstream);
        // The existing validator permits a saved legacy URL even when Strict disables
        // the legacy listener; that fact never grants clinical support or rewrites HAPI.
        assert.equal(outcome.code, 200, JSON.stringify(outcome.value));
        const next = saved(); assert.equal(next.security.dsGatewayToFhirServer.customUrlScope, 'legacy-ds');
        assert.deepEqual(next.healthOrganizations, changed.healthOrganizations); assert.deepEqual(next.security.pcmApi, changed.security.pcmApi);
        if (preset === 'strict') assert.equal(getConfiguredDataSources(next).some(source => source.compatibilityOnly), false);
        const bytes = fs.readFileSync(configFile);
        assert.equal(command('/admin/config/security', { ...upstream, expectedRevision: next.runtime.revision, dsGatewayToFhirServerCustomUrl: 'broken' }).code, 400);
        assert.deepEqual(fs.readFileSync(configFile), bytes);
    }
});

/** Directory/mapping changes never qualify the legacy source for clinical access. */
test('legacy clinical access stays denied in every preset with mandatory authority intact', () => {
    const { clinicalTokenFixture } = require('../../../test-support/clinical-token-fixture');
    const { resolveGrant } = require('../src/data-grant');
    for (const preset of ['connectathon-easy','connectathon-balanced','connectathon-mtls','strict']) {
        const fixture = clinicalTokenFixture();
        const config = buildTeamConfig({}, preset);
        assert.throws(() => resolveGrant({ ...fixture.request, config, resource: config.legacyDataSource.internalFhirBaseUrl }), /Legacy Node source does not support clinical scope enforcement|unavailable|not configured/);
    }
});
