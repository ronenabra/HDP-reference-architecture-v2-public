'use strict';
/** External catalog graph, normal grants, restart and explicit reconciliation regressions. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { FHIRStore } = require('../src/fhir/store');
const { buildSeedDrafts } = require('../src/bootstrap');
const { buildSystemPolicyDrafts, validatePolicy } = require('../src/fhir/system-policy');
const { loadServiceCatalog } = require('../../shared/service-catalog');
const { compileConsentScope, defaultServiceScope } = require('../src/grant-compiler');
const { publishCatalog, previewCatalog, reconcileCatalog } = require('../src/catalog-bootstrap');
const definitions = require('../../../config/demo-services.json');
const { dataGrantFixture } = require('../../../test-support/data-grants');
const NOW = new Date('2026-10-06T12:00:00Z');

/** Supply explicit application bindings without modifying the legacy fixture. */
function fixture() {
    const config = buildTeamConfig();
    config.serviceCatalog = { file: 'config/demo-services.json', bindings: definitions.clinicalServices.flatMap(definition => ['serviceProvider', 'hospitalBServiceProvider'].map(providerRole => ({ application: providerRole, providerRole, serviceKey: definition.key, instanceId: `${providerRole}-${definition.key}`, instanceIdentifier: `DEMO-${providerRole}-${definition.key}` }))) };
    const resources = [...buildSeedDrafts(config, {}, () => NOW), ...buildSystemPolicyDrafts(config, NOW.getTime() / 1000)];
    const store = new FHIRStore();
    require('../src/data-sources').syncDataSourcesToStore(store, config, 'A'.repeat(43));
    for (const resource of resources) require('../src/public-fhir').publishNewResource(store, resource);
    return { config, resources, store };
}

test('all definitions use explicit separate identities and provider ownership; three system profiles are complete', () => {
    const { config, resources, store } = fixture();
    assert.equal(resources.filter(item => item.resourceType === 'HealthcareService').length, 15);
    for (const binding of config.serviceCatalog.bindings) assert.equal(store.get('HealthcareService', binding.instanceId).providedBy.reference, `Organization/${config.organizations[binding.providerRole].id}`);
    for (const policy of store.getAll('Contract')) {
        const { service } = validatePolicy(store, policy, config.organizations.pcm.id);
        assert.equal(service, undefined);
        assert.ok(policy.term[0].text); assert.ok(policy.extension.length); assert.ok(policy.meta.lastUpdated);
    }
});

test('fresh catalog definitions retain exact generated or explicit broad grants independently of presets and reload clocks', () => {
    const { config, store } = fixture();
    const { readServiceGrant } = require('../../shared/service-grant');
    for (const binding of config.serviceCatalog.bindings) {
        const grant = store.privateRecords.services.getDefinition(binding.instanceId).grant;
        assert.equal(grant.model, 'pcm-service-grant/1');
        assert.deepEqual(grant, definitions.clinicalServices.find(item => item.key === binding.serviceKey).serviceGrant);
        assert.equal(grant.diagnostics.capability, 'supported');
        assert.doesNotMatch(grant.scope, /identifier=/);
        if (binding.serviceKey !== 'sandbox-full-access') for (const token of grant.scope.split(' ')) assert.match(token, /_security:not=.*\|V/);
        else assert.equal(grant.scope, 'patient/*.rs');
        if (binding.serviceKey === 'sandbox-full-access') { assert.equal(grant.origin, 'custom'); assert.doesNotMatch(grant.scope, /date=ge/); }
        else assert.match(grant.scope, /ge20/);
    }
});

test('wrong providers, dangling keys, duplicate identities and missing selected files fail before seeding', () => {
    const { config } = fixture();
    for (const mutate of [c => c.serviceCatalog.file = 'missing.json', c => c.serviceCatalog.file = '../config/demo-services.json', c => c.serviceCatalog.bindings[0].providerRole = 'pcm', c => c.serviceCatalog.bindings[0].serviceKey = 'missing', c => c.serviceCatalog.bindings[1].instanceIdentifier = c.serviceCatalog.bindings[0].instanceIdentifier]) {
        const broken = structuredClone(config); mutate(broken); assert.throws(() => buildSeedDrafts(broken));
    }
    assert.equal(loadServiceCatalog(config).schemaVersion, 1);
});

test('restart preserves operator fields, versions, approval windows and terminal policies', () => {
    const { config, store } = fixture();
    const service = store.get('HealthcareService', config.serviceCatalog.bindings[0].instanceId);
    store.update({ ...service, active: false });
    const policy = store.get('Contract', 'policy-presence'); store.update({ ...policy, status: 'revoked' });
    const before = JSON.stringify(store.getAll('HealthcareService'));
    publishCatalog(store, [...buildSeedDrafts(config, {}, () => new Date(NOW.getTime() + 60000)).filter(item => item.resourceType === 'HealthcareService'), ...buildSystemPolicyDrafts(config, NOW.getTime()/1000 + 60)]);
    assert.equal(JSON.stringify(store.getAll('HealthcareService')), before);
    assert.equal(store.get('Contract', policy.id).status, 'revoked');
    assert.equal(store.get('Contract', policy.id).applies.end, policy.applies.end);
});

test('changed definitions require preview, version match and backup; reconciliation preserves Consents and lifecycle', () => {
    const { config, store } = fixture();
    const changed = buildSeedDrafts(config, {}, () => NOW).filter(item => item.resourceType === 'HealthcareService');
    changed[0].meta.tag.find(tag => tag.system === 'urn:pcm:sandbox:seed-definition').code = 'changed';
    assert.throws(() => publishCatalog(store, changed), /reconciliation/);
    const preview = previewCatalog(store, changed); assert.equal(preview.conflicts.length, 1);
    const before = store.getAll('HealthcareService');
    assert.throws(() => reconcileCatalog(store, changed, {}, () => {}), /conflict/);
    assert.throws(() => reconcileCatalog(store, changed, preview.versions, () => { throw new Error('disk failure'); }), /disk failure/);
    assert.deepEqual(store.getAll('HealthcareService'), before);
    let backup; reconcileCatalog(store, changed, preview.versions, value => { backup = value; });
    assert.deepEqual(backup.HealthcareService, before);
});


test('compatibility migration preserves retained default identity and windows until reviewed reconciliation', () => {
    const { planCatalogMigration } = require('../../../pcm-connectathon/scripts/migrate-service-catalog');
    const current = buildTeamConfig();
    const plan = planCatalogMigration(current);
    assert.deepEqual(plan.config.service, current.service);
    assert.equal(plan.config.serviceCatalog.bindings[0].instanceId, current.service.id);
    assert.equal(plan.requiresRuntimeReconciliation, true);
    assert.equal(current.serviceCatalog, undefined);
});

test('DiagnosticReport fixtures use the maintained import/probe allowlist', () => {
    const fs = require('fs');
    const { inspectTransactionBundle, MANAGED_CLINICAL_RESOURCE_TYPES } = require('../../../clinical-data/transaction-bundle');
    const inspected = inspectTransactionBundle(fs.readFileSync(require('path').resolve(__dirname, '../../../clinical-data/demo/ho-a.source.transaction.json')));
    assert.equal(inspected.counts.DiagnosticReport, 1);
    assert.ok(MANAGED_CLINICAL_RESOURCE_TYPES.includes('DiagnosticReport'));
});

test('explicit reconciliation retains operator-edited name and history rather than erasing them', () => {
    const { config, store } = fixture();
    const binding = config.serviceCatalog.bindings[0];
    const current = store.get('HealthcareService', binding.instanceId);
    current.name = 'Operator label';
    current.extension.find(item => item.url.endsWith('/ext-information-bucket')).extension.find(item => item.url === 'historyDepth').valueDuration.value = 1;
    store.update(current);
    const proposed = buildSeedDrafts(config, {}, () => NOW).filter(item => item.resourceType === 'HealthcareService');
    const changed = proposed.find(item => item.id === binding.instanceId);
    changed.meta.tag.find(tag => tag.system === 'urn:pcm:sandbox:seed-definition').code = 'new-definition';
    changed.name = 'New authored label';
    const preview = previewCatalog(store, proposed);
    assert.throws(() => reconcileCatalog(store, proposed, preview.versions, () => {}), /new service definition/);
    const retained = store.get('HealthcareService', binding.instanceId);
    assert.equal(retained.name, 'Operator label');
    assert.equal(retained.extension.find(item => item.url.endsWith('/ext-information-bucket')).extension.find(item => item.url === 'historyDepth').valueDuration.value, 1);
});


test('ordinary catalog approval retains complete service ceilings and advisory custom text', () => {
    const { config, store } = fixture();
    const { setApprovedTokenScope, getApprovedTokenScope } = require('../src/data-sources');
    for (const binding of config.serviceCatalog.bindings.filter(item => item.serviceKey !== 'sandbox-full-access')) {
        const scope = defaultServiceScope(store, store.get('HealthcareService', binding.instanceId));
        const consent = { extension: [] };
        assert.throws(() => setApprovedTokenScope(consent, scope), /private approval command/);
        assert.equal(getApprovedTokenScope(consent), '', 'legacy compiler input is not an exact approval');
        assert.throws(() => setApprovedTokenScope(consent, 'patient/Observation.cruds'), /private approval command/);
        assert.equal(getApprovedTokenScope(consent), '');
    }
});

test('reconciliation rejects existing business identity collisions without backup or partial additions', () => {
    const { store } = fixture();
    const existing = store.getAll('HealthcareService')[0];
    const proposed = [{ ...existing, id: 'colliding-new-service' }];
    const before = store.getAll('HealthcareService');
    const preview = previewCatalog(store, proposed);
    let backups = 0;
    assert.throws(() => reconcileCatalog(store, proposed, preview.versions, () => backups++), /identity collision/);
    assert.equal(backups, 0);
    assert.deepEqual(store.getAll('HealthcareService'), before);
});

test('external system definitions retain eligible flows and deny application entitlement and wrong targets', () => {
    const { resolveGrant } = require('../src/data-grant');
    const { rar, NOW: time } = require('../../../test-support/data-grants');
    const { request, config, store, patient, strongPatient, source } = dataGrantFixture();
    config.serviceCatalog = fixture().config.serviceCatalog;
    for (const resource of require('../src/fhir/system-policy').buildSystemPolicies(config, time)) store.add(resource);
    const presence = { ...request, scope: 'system/Patient.s', client: { clientId: config.oauthClients.presenceOrchestrator.clientId }, requested: rar('Contract', 'PCM-POLICY-PRESENCE-001', [patient]) };
    assert.match(resolveGrant(presence).scope, /identifier=.*\|1&_security=.*patientDemographics$/);
    assert.throws(() => resolveGrant({ ...presence, client: request.client }), /unavailable/);
    const authenticationId = config.oauthClients.authenticationOrchestrator.clientId;
    const invocation = { id: 'flow', clientId: authenticationId, identifier: strongPatient, homeHmoId: source.dataSourceOrganization.id, phase: 'authenticating', expiresAt: time + 10 };
    const authentication = { ...request, client: { clientId: authenticationId }, scope: 'patient/Patient.s', requested: rar('Contract', 'PCM-POLICY-PATIENT-AUTHENTICATION-001', [strongPatient]), invocation };
    assert.match(resolveGrant(authentication).scope, /^patient\/Patient.s\?_security=.*patientDemographics$/);
    assert.throws(() => resolveGrant({ ...authentication, resource: config.healthOrganizations[1].endpoint }), /unavailable/);
    const discoveryId = config.oauthClients.discoveryOrchestrator.clientId;
    const discovery = { ...request, client: { clientId: discoveryId }, scope: 'system/Patient.s system/RelatedPerson.s', requested: rar('Contract', 'PCM-POLICY-DEPENDENT-DISCOVERY-001'), invocation: { ...invocation, clientId: discoveryId, phase: 'authenticated' } };
    assert.match(resolveGrant(discovery).scope, /_has:RelatedPerson:patient:identifier=/);
    assert.throws(() => resolveGrant({ ...discovery, invocation: null }), /unavailable/);
});

test('reconciliation retains independent operator metadata and additional resource fields', () => {
    const { config, store } = fixture();
    const service = store.getAll('HealthcareService')[0];
    service.comment = 'Operator-reviewed note';
    service.meta.security = [{ system: 'urn:operator', code: 'reviewed' }];
    service.meta.tag.push({ system: 'urn:operator', code: 'reviewed' });
    store.update(service);
    const proposed = buildSeedDrafts(config, {}, () => NOW).filter(item => item.resourceType === 'HealthcareService');
    reconcileCatalog(store, proposed, previewCatalog(store, proposed).versions, () => {});
    const actual = store.get('HealthcareService', service.id);
    assert.equal(actual.comment, service.comment);
    assert.deepEqual(actual.meta.security, service.meta.security);
    assert.ok(actual.meta.tag.some(tag => tag.system === 'urn:operator'));
});

test('portable plural-tag catalog survives source reload, retained publication and grant compilation', () => {
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const { SENSITIVITY_LABELS } = require('../../shared/information-buckets');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm042-tags-'));
    const previous = process.env.TEAM_CONFIG_PATH;
    try {
        for (const count of [0, 1, 2]) {
            const { config } = fixture();
            const authored = structuredClone(definitions);
            authored.clinicalServices[0].buckets[0].taggedDetails = [SENSITIVITY_LABELS[1], SENSITIVITY_LABELS[8]].slice(0, count);
            // This is new owned package authoring, not conversion of a retained definition.
            const entry = authored.clinicalServices[0], input = structuredClone(entry.serviceGrant.authoring);
            input.buckets[0].sensitivity = entry.buckets[0].taggedDetails.map(coding => `${coding.system}|${coding.code}`);
            entry.serviceGrant = require('../../shared/service-grant').readServiceGrant(require('../src/service-definition-form').serviceDefinitionDraft(input,
                { now: Date.parse(entry.serviceGrant.anchor) / 1000 }));
            config.serviceCatalog.file = 'catalog.json';
            fs.writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify(authored));
            process.env.TEAM_CONFIG_PATH = path.join(directory, 'team-config.json');
            const resources = buildSeedDrafts(config, {}, () => NOW);
            const store = new FHIRStore(); for (const resource of resources) require('../src/public-fhir').publishNewResource(store, resource);
            const service = store.get('HealthcareService', config.serviceCatalog.bindings[0].instanceId);
            const { serviceBuckets } = require('../src/grant-compiler');
            const tags = authored.clinicalServices[0].buckets[0].taggedDetails;
            assert.deepEqual(serviceBuckets(store, service)[0].taggedDetails, tags);
            const before = store.getAll('HealthcareService');
            publishCatalog(store, buildSeedDrafts(config, {}, () => new Date(NOW.getTime() + 60000)).filter(item => item.resourceType === 'HealthcareService'));
            assert.deepEqual(store.getAll('HealthcareService'), before);
            assert.deepEqual(loadServiceCatalog(config).clinicalServices[0].buckets[0].taggedDetails, tags);
            const compiled = store.privateRecords.services.getDefinition(service.id).grant.scope;
            if (count) assert.ok(compiled.includes(`_security=${tags.map(tag => `${tag.system}|${tag.code}`).join(',')}`));
            else for (const label of SENSITIVITY_LABELS) assert.ok(compiled.includes(`_security:not=${label.system}|${label.code}`));
            authored.clinicalServices[0].buckets[0].taggedDetails.push({ system: SENSITIVITY_LABELS[0].system, code: 'unapproved' });
            fs.writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify(authored));
            assert.throws(() => buildSeedDrafts(config), /sensitivity/);
            assert.deepEqual(store.getAll('HealthcareService'), before);
        }
    } finally {
        if (previous === undefined) delete process.env.TEAM_CONFIG_PATH; else process.env.TEAM_CONFIG_PATH = previous;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});


test('a changed package history cannot silently replace the frozen authoring or rewrite a retained approval', () => {
    const { config } = fixture(), catalog = structuredClone(definitions);
    catalog.clinicalServices[0].buckets[0].historyYears += 1;
    assert.throws(() => require('../../shared/service-catalog').validateCatalogGraph(catalog, config), /grant authoring differs/);
    const original = require('../../shared/service-grant').readServiceGrant(buildSeedDrafts(config).find(item => item.resourceType === 'HealthcareService'));
    assert.equal(original.model, 'pcm-service-grant/1');
});
