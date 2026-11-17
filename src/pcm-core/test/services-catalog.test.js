'use strict';
/** Catalog presentation tests use current owner projections and real EJS, not copied markup. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ejs = require('ejs');
const { FHIRStore } = require('../src/fhir/store');
const { buildTeamConfig } = require('../../../test-support/team-config');
const model = require('../src/services-admin-model'), { catalogRow } = require('../src/services-catalog-presentation');
const lifecycle = require('../src/fhir/healthcare-service-lifecycle'), command = require('../src/sandbox-service-command');
const { EXTENSIONS } = require('../../shared/pcm-contract');
const definition = name => ({ name, purpose: 'Catalog lifecycle qualification', category: '35', accessMode: 'continuous', duration: 6, durationUnit: 'mo',
    allowChanges: false, buckets: [{ code: 'laboratoryTests', history: 2, historyUnit: 'a', sensitivity: [] }], permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 's' }] });

/** Render a complete owner snapshot while retaining all actual template fields and help bindings. */
function fixture() {
    const store = new FHIRStore(), config = buildTeamConfig();
    for (const resource of require('../src/bootstrap').buildSeedDrafts(config)) require('../src/public-fhir').publishNewResource(store, resource);
    const create = name => model.createCatalog({ store, config, definition: definition(name), expectedRevision: store.privateState.revision, operator: 'unit', audit() {} });
    const render = (overrides = {}) => {
        const catalog = model.catalogInventory({ store, config }); catalog.items = catalog.items.map(catalogRow);
        return ejs.render(fs.readFileSync(path.resolve(__dirname, '../src/views/services.ejs'), 'utf8'), {
            teamId: config.teamId, role: 'serviceProvider', providers: [{ role: 'serviceProvider', ...config.organizations.serviceProvider }],
            selectedView: 'catalog', catalog, catalogError: '', templates: [], list: { owned: [], available: [], others: [] }, targets: [], context: null,
            error: '', warnings: [], nextPage: '', privateActionsUnavailable: config.conformance.preset === 'strict', formCsrf: 'test', ownerCsrf: command.csrf,
            units: require('../src/service-definition-form').UNITS, bucketResources: {}, categoryLabels: {}, sensitivityLabels: [], ...overrides });
    };
    return { store, config, create, render };
}

test('catalog renders every state and zero-provider rows with exact versions and contextual state actions', () => {
    const f = fixture();
    for (const state of ['pending', 'active', 'frozen', 'suspended', 'rejected', 'cancelled', 'unknown']) {
        const created = f.create(`State ${state}`), resource = f.store.get('HealthcareService', created.id);
        f.store.update({ ...resource, active: state === 'active', extension: [lifecycle.statusExtension(state), ...resource.extension.filter(item => item.url !== EXTENSIONS.serviceBusinessStatus)] });
    }
    const html = f.render();
    for (const label of ['Pending approval', 'Active', 'Disabled / frozen', 'Suspended', 'Rejected', 'Ended', 'Unknown']) assert.ok(html.includes(label), label);
    assert.match(html, /0 provider registrations, including history/);
    assert.match(html, /data-catalog-version="2"/);
    assert.match(html, /Global actions affect all providers/);
    assert.match(html, /value="activate"[^>]*>Approve/);
    assert.match(html, /value="disable"[^>]*>Disable/);
    assert.match(html, /value="enable"[^>]*disabled>Enable/);
    assert.doesNotMatch(html, /id="service-admin"|Simulate PCM approval\/Admin/);
    assert.match(html, /Public FHIR facts: persisted HealthcareService/);
    assert.match(html, /Private authoring source: private-services/);
    assert.match(html, /Exact private authoring facts · Admin/);
    assert.match(html, /Saved creation\/history anchor:/);
    assert.ok(html.indexOf('data-service-template-pick') === -1, 'no external template picker');
});

test('catalog exposes missing metadata, builtin and retained deletion blockers without inventing authority', () => {
    const f = fixture(), created = f.create('Missing authority');
    const authored = require('../src/service-definition-form').serviceDefinitionCommand(definition('Builtin fixture'));
    lifecycle.createCatalogDefinition({ store: f.store, request: authored.resource, privateDefinition: authored.definition, idGenerator: () => model.BUILTIN_CATALOG_ID });
    delete f.store.privateState.services[`HealthcareService/${created.id}`];
    let html = f.render(); assert.match(html, /Saved scope unavailable/); assert.match(html, /private-services · missing/);
    assert.match(html, /This built-in service is protected and cannot be deleted/);
    assert.match(html, />Built-in<\/small>/);
    const pending = f.create('Retained dependency');
    f.store.add({ resourceType: 'Contract', id: 'retained-contract', status: 'terminated', subject: [{ reference: `HealthcareService/${pending.id}` }] });
    html = f.render(); assert.match(html, /Contract history references this service/); assert.match(html, /contracts: retained-contract/);
    f.config.conformance.preset = 'strict'; html = f.render();
    assert.match(html, /Private sandbox actions are unavailable in strict mode/);
    assert.doesNotMatch(html, /name="action"[^>]*class="[^"]*"[^>]*data-help-context="" >Approve/);
    const unavailable = f.render({ catalog: undefined, catalogError: 'Private owner unavailable' });
    assert.match(unavailable, /Private owner unavailable.*Refresh from the first page/);
    assert.doesNotMatch(unavailable, /data-catalog-id=/);
});

test('effective summaries use exact saved scope beyond authoring buckets and diagnose experimental text', () => {
    const f = fixture(), created = f.create('Effective scope');
    const row = model.catalogInventory(f).items.find(item => item.id === created.id);
    assert.match(catalogRow(row).access, /Read and search: Patient, Observation/);
    const grant = row.definition.grant;
    const summary = catalogRow({ ...row, definition: { status: 'ok', grant: { ...grant, scope: grant.scope + ' patient/Encounter.rs?_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V' } } }).access;
    assert.match(summary, /Encounter/); assert.doesNotMatch(summary, /Laboratory/);
    assert.match(catalogRow({ ...row, definition: { status: 'ok', grant: { ...grant, scope: ' malformed experimental text ' } } }).access, /runtime authority unavailable/);
    const full = require('../../../config/demo-services.json').clinicalServices.find(item => item.key === 'sandbox-full-access').serviceGrant;
    const fullSummary = catalogRow({ ...row, definition: { status: 'ok', grant: full } }).access;
    assert.equal(fullSummary, 'All supported patient data · read/search'); assert.doesNotMatch(fullSummary, /Laboratory/);
    assert.equal(f.store.privateRecords.services.getDefinition(created.id).grant.scope, grant.scope, 'presentation never rewrites authority');
});
