'use strict';

/** Closed institution types, legacy defaults and preservation across source projections. */
const test = require('node:test'), assert = require('node:assert/strict');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { sourceInstitutionType } = require('../../shared/source-institution');
const { getConfiguredDataSources, newDataSourceConfig, toConfigDataSource, syncDataSourcesToStore } = require('../src/data-sources');
const { assertValidTeamConfig } = require('../../shared/team-config-validator');
const { FHIRStore } = require('../src/fhir/store');

test('only known managed legacy IDs default HMO; custom and compatibility sources default Other', () => {
    const config = buildTeamConfig(); for (const ho of config.healthOrganizations) delete ho.institutionType;
    config.organizations.dataSources = [newDataSourceConfig('An HMO in its name', 'https://custom.example.test/fhir', { pcmClientAuthCertThumbprint: 'A'.repeat(43) })];
    assert.equal(assertValidTeamConfig(config, { env: {} }), config);
    const sources = getConfiguredDataSources(config);
    assert.deepEqual(sources.slice(0, 3).map(s => s.institutionType), ['hmo', 'hmo', 'hmo']);
    assert.equal(sources.at(-1).institutionType, 'other');
    assert.equal(sourceInstitutionType({ id: 'ho-a' }), 'other');
    assert.equal(sourceInstitutionType({ id: 'arbitrary' }, { managed: true }), 'other');
    for (const value of ['HMO', '', 'clinic', true, null]) {
        assert.throws(() => sourceInstitutionType({ institutionType: value }));
        const invalid = structuredClone(config); invalid.healthOrganizations[0].institutionType = value;
        assert.throws(() => assertValidTeamConfig(invalid, { env: {} }), /institutionType/);
    }
});

test('all values survive normalized record rebuilding without changing FHIR clinical source choices', () => {
    const config = buildTeamConfig(), store = new FHIRStore();
    for (const [index, value] of ['hmo', 'hospital', 'other'].entries()) config.healthOrganizations[index].institutionType = value;
    const source = newDataSourceConfig('Owned custom HMO', 'https://custom.example.test/fhir', { institutionType: 'hmo' });
    config.organizations.dataSources = [source];
    assert.equal(toConfigDataSource(source).institutionType, 'hmo');
    syncDataSourcesToStore(store, config, 'A'.repeat(43));
    const resources = () => store.getAll('Organization').map(({ meta, ...resource }) => resource);
    const before = resources();
    config.healthOrganizations[0].institutionType = 'hospital'; source.institutionType = 'other';
    syncDataSourcesToStore(store, config, 'A'.repeat(43));
    assert.deepEqual(resources(), before);
    assert.deepEqual(getConfiguredDataSources(config).slice(0, 3).map(s => s.id), config.healthOrganizations.map(ho => ho.dataSourceOrganization.id));
    source.enabled = false;
    assert.equal(getConfiguredDataSources(config).some(s => s.id === source.id), false);
    assert.equal(getConfiguredDataSources(config, { includeDisabled: true }).find(s => s.id === source.id).institutionType, 'other');
});

test('actual authenticated Admin saves built-in/custom types, rejects stale writes and retains credentials through regeneration', async t => {
    const runtime = await require('../../../test-support/pcm-042-runtime').startRuntime();
    t.after(() => runtime.close());
    const ui = runtime.config.publicBaseUrls.pcmUi;
    const headers = { 'x-admin-password': process.env.TEAM_ADMIN_PASSWORD, Accept: 'application/json', 'Content-Type': 'application/json' };
    const post = (route, body, auth = true) => fetch(ui + route, { method: 'POST', headers: auth ? headers : { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const { loadTeamConfig, saveTeamConfig } = require('../src/team-config');
    const builtin = runtime.config.healthOrganizations[0].dataSourceOrganization.id;
    const route = id => `/admin/config/data-sources/${id}/institution`;
    const start = loadTeamConfig(), initialRevision = start.runtime.revision || 0;
    assert.equal((await post(route(builtin), { institutionType: 'hospital', expectedRevision: initialRevision }, false)).status, 401);
    assert.equal((await post(route(builtin), { institutionType: 'invalid', expectedRevision: initialRevision })).status, 400);
    assert.deepEqual(loadTeamConfig(), start);
    assert.equal((await post(route(builtin), { institutionType: 'hospital', expectedRevision: initialRevision })).status, 200);
    const saved = loadTeamConfig(); assert.equal(saved.healthOrganizations[0].institutionType, 'hospital');
    assert.deepEqual(saved.healthOrganizations[0].certificates, start.healthOrganizations[0].certificates);
    assert.equal(saved.healthOrganizations[0].endpoint, start.healthOrganizations[0].endpoint);
    assert.equal((await post(route(builtin), { institutionType: 'hmo', expectedRevision: initialRevision })).status, 409);
    assert.deepEqual(loadTeamConfig(), saved);
    const added = await post('/admin/config/data-sources/add', { expectedRevision: loadTeamConfig().runtime.revision || 0, name: 'Owned type fixture', endpoint: 'https://owned-institution.example.test/fhir', institutionType: 'hmo', generateCertificate: true });
    assert.equal(added.status, 201); const custom = (await added.json()).dataSource;
    for (const institutionType of ['hospital', 'other', 'hmo']) {
        const config = loadTeamConfig();
        assert.equal((await post(route(custom.id), { institutionType, expectedRevision: config.runtime.revision })).status, 200);
        assert.equal(loadTeamConfig().organizations.dataSources.find(s => s.id === custom.id).institutionType, institutionType);
    }
    assert.equal((await post(`/admin/config/data-sources/${custom.id}/cert/generate`, {expectedRevision:loadTeamConfig().runtime.revision || 0})).status, 200);
    assert.equal(loadTeamConfig().organizations.dataSources.find(s => s.id === custom.id).institutionType, 'hmo');
    const disabled = loadTeamConfig(); disabled.organizations.dataSources.find(s => s.id === custom.id).enabled = false; saveTeamConfig(disabled);
    assert.equal((await post(route(custom.id), { institutionType: 'other', expectedRevision: disabled.runtime.revision })).status, 200);
    assert.equal(loadTeamConfig().organizations.dataSources.find(s => s.id === custom.id).enabled, false);
    const admin = await fetch(`${ui}/admin?section=sources&source=${encodeURIComponent(builtin)}`, { headers: { ...headers, Accept: 'text/html' } });
    assert.match(await admin.text(), /Institution type/);
});
