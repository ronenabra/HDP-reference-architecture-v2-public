'use strict';
/** Service isolation, complete automatic alternatives, retained publication and strict compilation. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { FHIRStore } = require('../src/fhir/store');
const { buildSeedDrafts } = require('../src/bootstrap');
const { approvalScopeOptions, scopeSelection, scopeWarnings } = require('../src/approval-scopes');
const { loadServiceCatalog } = require('../../shared/service-catalog');
const { BUCKET_RESOURCES } = require('../../shared/clinical-resource-mapping');
const { CODE_SYSTEMS, EXTENSIONS, SANDBOX_EXTENSIONS } = require('../../shared/pcm-contract');
const { compileConsentScope } = require('../src/grant-compiler');
const { publishCatalog, previewCatalog, reconcileCatalog } = require('../src/catalog-bootstrap');
const definitions = require('../../../config/demo-services.json');
const NOW = new Date('2026-10-19T12:00:00Z');

/** Seed all service definitions with explicit bindings and an isolated in-memory store. */
function fixture() {
    const config = buildTeamConfig({ serviceCatalog: { file: 'config/demo-services.json', bindings: definitions.clinicalServices.map(item => ({
        serviceKey: item.key, providerRole: 'serviceProvider', application: 'serviceProvider', instanceId: `instance-${item.key}`, instanceIdentifier: `INSTANCE-${item.key}`
    })) } });
    const resources = buildSeedDrafts(config, {}, () => NOW);
    const store = new FHIRStore(); resources.forEach(item => require('../src/public-fhir').publishNewResource(store, item));
    return { config, store };
}

test('each service owns its presets and exactly two complete automatic options independent of overrides', () => {
    const { config, store } = fixture();
    for (const definition of definitions.clinicalServices) {
        const service = store.get('HealthcareService', `instance-${definition.key}`);
        const options = approvalScopeOptions(store, service);
        assert.equal(options.filter(item => item.kind === 'generated').length, 2);
        assert.deepEqual(options.map(item => item.id), ['service-provided', 'auto-resources', 'auto-buckets']);
        assert.equal(options[0].value, definition.serviceGrant.scope, 'fresh packaged defaults use the exact frozen grant');
        const types = ['Patient', ...new Set(definition.buckets.flatMap(bucket => Object.keys(BUCKET_RESOURCES[bucket.code])))];
        assert.deepEqual(options[1].value.split(' ').map(token => token.split('?')[0]), types.map(type => `patient/${type}.rs`));
        for (const option of options.slice(1)) assert.equal(require('../../shared/service-grant').inspectScope(option.value).diagnostics.applicability, 'valid');
        config.sandbox.grantFullClinicalAccess = true;
        assert.deepEqual(approvalScopeOptions(store, service, { now: Date.parse(options[1].anchor) / 1000 }), options);
        assert.doesNotMatch(options.map(item => item.label).join(' '), /Mismatch|Wrong bucket|conformance matrix/);
    }
});

test('live canonical buckets beat stale instances; a shared type retains both bucket alternatives and every sensitivity category', () => {
    const { store } = fixture();
    const service = store.get('HealthcareService', 'instance-medication-reconciliation');
    const canonical = store.get('HealthcareService', 'demo-catalog-medication-reconciliation');
    const allergy = structuredClone(canonical.extension.find(item => item.url === EXTENSIONS.informationBucket && item.extension[0].valueCodeableConcept.coding[0].code === 'allergiesAndIntolerances'));
    allergy.extension[0].valueCodeableConcept.coding[0].code = 'allergies';
    const tags = require('../../shared/information-buckets').SENSITIVITY_LABELS.slice(0, 2);
    allergy.extension.push(...tags.map(coding => ({ url: 'taggedDetails', valueCodeableConcept: { coding: [coding] } })));
    canonical.extension.push(allergy); store.update(canonical);
    const options = approvalScopeOptions(store, service);
    assert.equal(options[1].value.split(' ').filter(value => value.startsWith('patient/AllergyIntolerance.rs?')).length, 1);
    assert.ok(options[2].value.split(' ').filter(value => value.startsWith('patient/AllergyIntolerance.rs?')).length >= 2);
    for (const option of options.slice(1)) {
        const compiled = compileConsentScope({ store, service, scope: 'patient/AllergyIntolerance.rs', approved: option.value, now: NOW.getTime()/1000, patient: { system: 'urn:test', value: '1' } });
        for (const bucket of ['allergiesAndIntolerances', 'allergies']) assert.ok(compiled.includes(`${CODE_SYSTEMS.informationBucket}|${bucket}`));
        assert.ok(compiled.includes(`_security=${tags.map(tag => `${tag.system}|${tag.code}`).join(',')}`));
    }
});

test('portable legacy option metadata remains input evidence while the frozen grant stays stable through reconciliation', () => {
    const { config, store } = fixture();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-catalog-'));
    const previous = process.env.TEAM_CONFIG_PATH;
    try {
        const authored = structuredClone(definitions);
        authored.clinicalServices[0].approvalScopeOptions[0].label = 'Reviewed lab example';
        fs.writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify(authored));
        process.env.TEAM_CONFIG_PATH = path.join(directory, 'team-config.json');
        config.serviceCatalog.file = 'catalog.json';
        assert.equal(loadServiceCatalog(config).clinicalServices[0].approvalScopeOptions[0].label, 'Reviewed lab example');
        const proposed = buildSeedDrafts(config, {}, () => NOW).filter(item => item.resourceType === 'HealthcareService');
        const before = store.getAll('HealthcareService');
        assert.throws(() => publishCatalog(store, proposed), /reconciliation/);
        assert.deepEqual(store.getAll('HealthcareService'), before);
        let backup;
        reconcileCatalog(store, proposed, previewCatalog(store, proposed).versions, value => { backup = value; });
        assert.deepEqual(backup.HealthcareService, before);
        assert.equal(store.privateRecords.services.getDefinition(config.service.catalogId || 'service-catalog-1').options[0].extension.find(item => item.url === 'label').valueString, 'Selected read/search permissions');
        const after = store.getAll('HealthcareService');
        publishCatalog(store, buildSeedDrafts(config, {}, () => new Date(NOW.getTime() + 10000)).filter(item => item.resourceType === 'HealthcareService'));
        assert.deepEqual(store.getAll('HealthcareService'), after);
        for (const option of [
            { id: 'custom', label: 'Reserved', scope: 'patient/Observation.rs' },
            { id: 'bad-resource', label: 'Bad', scope: 'patient/MedicationRequest.rs' },
            { id: 'bad-bucket', label: 'Bad', scope: `patient/Observation.rs?_security=${CODE_SYSTEMS.informationBucket}|procedures` }
        ]) {
            authored.clinicalServices[0].approvalScopeOptions = [option];
            fs.writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify(authored));
            assert.throws(() => buildSeedDrafts(config), /approval|bucket/);
            assert.deepEqual(store.getAll('HealthcareService'), after);
        }
    } finally {
        if (previous === undefined) delete process.env.TEAM_CONFIG_PATH; else process.env.TEAM_CONFIG_PATH = previous;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('warnings are readable advice and explicit custom selection retains its origin for preset text', () => {
    assert.deepEqual(scopeWarnings('patient/Observation.rs', ['Observation']), []);
    for (const scope of ['', ' patient/Observation.rs ', 'patient/*.cruds', 'patient/Unknown.rs', 'patient/Observation.rs?_filter=x', 'patient/Observation.rs?status=']) {
        assert.ok(scopeWarnings(scope, ['Observation']).length, scope);
    }
    const menu = [{ id: 'auto-resources', kind: 'generated', label: 'Auto-generated', value: 'patient/Observation.rs' }];
    assert.equal(scopeSelection(menu[0].value, menu, 'custom').kind, 'custom');
    assert.equal(scopeSelection(menu[0].value, menu).kind, 'generated');
});

test('unsupported inputs and retired full-access configuration cannot produce compiled authority', () => {
    const { config, store } = fixture();
    const service = store.get('HealthcareService', 'instance-lab-follow-up');
    const input = { store, config, service, scope: 'patient/Observation.rs', now: NOW.getTime()/1000, patient: { system: 'urn:test', value: '1' } };
    for (const approved of ['patient/*.cruds', 'patient/Observation.rs?_filter=x', 'patient/Unknown.rs', '']) {
        assert.throws(() => compileConsentScope({ ...input, approved }), /approval|predicate|mapping|scope/i);
        config.sandbox.grantFullClinicalAccess = true;
        assert.throws(() => compileConsentScope({ ...input, approved }), /retired|approval|predicate|mapping|scope/i);
        delete config.sandbox.grantFullClinicalAccess;
    }
    const origin = { extension: [{ url: SANDBOX_EXTENSIONS.approvedTokenScopeOrigin, valueString: 'custom: Custom scope' }] };
    assert.match(require('../src/approval-scopes').approvedScopeOrigin(origin), /Missing legacy approval snapshot/);
});
