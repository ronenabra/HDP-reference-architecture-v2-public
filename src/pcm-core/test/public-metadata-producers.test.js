'use strict';
/** Producer/private-owner and public DTO contracts. Fixtures are owned in-memory state only. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { FHIRStore } = require('../src/fhir/store');
const { buildSeedDrafts, buildSeedResources } = require('../src/bootstrap');
const { publishNewResource, publicDto, assertPublic } = require('../src/public-fhir');
const { snapshot, hydrate } = require('../src/migration-checkpoint');
const { EXTENSIONS, IDENTIFIER_SYSTEMS, PROFILES } = require('../../shared/pcm-contract');
const lifecycle = require('../src/fhir/consent-lifecycle');
const serviceLifecycle = require('../src/fhir/healthcare-service-lifecycle');
const { serviceDefinitionCommand, serviceDefinitionDraft } = require('../src/service-definition-form');
const { resolveDataSourceGrant } = require('../src/token-authorization');
const clock = () => new Date('2026-11-08T12:00:00.000Z');
const V = '_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V';
const EXACT = `patient/Patient.rs?${V} patient/Observation.s?status=final&${V}`;
const example = name => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/FHIR-examples', name)));

/** Publish a complete ordinary graph through the actual new producer command. */
function fixture() {
    const config = buildTeamConfig({ serviceCatalog: { file: 'config/demo-services.json', bindings: [{ serviceKey: 'lab-follow-up', application: 'serviceProvider', providerRole: 'serviceProvider', instanceId: 'approval-lab-follow-up', instanceIdentifier: 'APPROVAL-LAB' }] } });
    const store = new FHIRStore({ clock });
    for (const resource of buildSeedDrafts(config, {}, clock)) publishNewResource(store, resource);
    require('../src/data-sources').syncDataSourcesToStore(store, config, 'A'.repeat(43));
    const sp = store.get('Organization', config.organizations.serviceProvider.id);
    const request = example('Consent-consent-request-hosp-a-cross-org-summary.json');
    request.patient.identifier = { system: IDENTIFIER_SYSTEMS.israelNationalId, value: '000000018' };
    request.extension.find(item => item.url === EXTENSIONS.pcmService).valueReference.reference = 'HealthcareService/approval-lab-follow-up';
    const create = patient => lifecycle.createConsent({ store, config, callerOrganization: sp, request: { ...request, ...(patient ? { patient: { identifier: patient } } : {}) }, clock });
    return { store, config, sp, create, consent: create(), service: store.get('HealthcareService', 'approval-lab-follow-up') };
}

/** Build one exact explicit private authoring command. */
function authored(name = 'Private exact laboratory definition') {
    return serviceDefinitionCommand({ name, purpose: 'Scope retained privately', category: '35', accessMode: 'continuous', duration: 1, durationUnit: 'a', allowChanges: false,
        buckets: [{ code: 'laboratoryTests', history: 2, historyUnit: 'a', sensitivity: [] }],
        permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 's' }], scopeOrigin: 'custom', approvalScope: EXACT }, { now: clock().getTime() / 1000 });
}

test('fresh seeds/catalog/templates publish clean public facts and separate immutable authority', () => {
    const f = fixture();
    for (const type of Object.keys(f.store.data)) for (const resource of f.store.getAll(type)) assertPublic(resource);
    assertPublic(buildSeedResources(f.config, {}, clock));
    const privateDefinition = f.store.privateRecords.services.getDefinition(f.service.id);
    assert.equal(privateDefinition.status, 'ok');
    assert.match(privateDefinition.grant.scope, /date=ge/);
    assert.equal(f.service.meta.profile[0], PROFILES.healthcareServiceInstance);
    assert.ok(f.service.extension.some(item => item.url === EXTENSIONS.informationBucket));
    assert.ok(f.store.privateRecords.provisioning.get('HealthcareService', f.service.id).seedTags.length);
    for (const template of require('../src/service-templates').loadTemplates()) {
        assertPublic(template.request); assert.ok(template.privateDefinition.grant.scope);
    }
});

test('all four exact approval choices freeze privately; no public decision copy survives', () => {
    const f = fixture();
    for (const choice of ['service-provided', 'auto-resources', 'auto-buckets', 'custom']) {
        const consent = f.create();
        const saved = lifecycle.approveConsent({ ...f, consent, scopeChoice: choice, customScope: EXACT, sourceOrganizationIds: [], clock });
        const decision = f.store.privateRecords.approvals.getDecision(saved.id);
        assert.equal(decision.status, 'ok'); assert.equal(decision.snapshot.choice, choice);
        assert.equal(decision.snapshot.validity.start, saved.provision.period.start);
        assert.equal(decision.publicVersionAtDecision, saved.meta.versionId);
        assertPublic(saved); assert.equal(require('../../shared/consent-scope-snapshot').readApprovalSnapshot(saved), null);
        if (choice === 'custom') assert.equal(decision.snapshot.scope, EXACT);
        if (choice === 'auto-buckets') assert.match(decision.snapshot.scope, /ge2024-11-08T12:00:00.000Z/);
        assert.throws(() => lifecycle.approveConsent({ ...f, consent: saved, clock }), /Only a requested/);
    }
    for (const text of ['', ' suspect scope ']) {
        const saved = lifecycle.approveConsent({ ...f, consent: f.create(), scopeChoice: 'custom', customScope: text, clock });
        const decision = f.store.privateRecords.approvals.getDecision(saved.id);
        assert.equal(decision.status, 'invalid'); assert.equal(decision.snapshot.scope, text); assertPublic(saved);
        require('../src/public-fhir').assertRetainedCompatibility(f.store); // Unusable choices are valid records, never clinical authority.
    }
});

test('private authored registration keeps manual grants/options/master policy while public API generates safe defaults', () => {
    const f = fixture(), command = authored();
    const created = serviceLifecycle.registerHealthcareService({ store: f.store, callerOrganization: f.sp, request: command.resource, privateDefinition: command.definition, clock });
    const definition = f.store.privateRecords.services.getDefinition(created.instance.id);
    assert.equal(definition.grant.scope, EXACT); assert.equal(definition.options[0].extension.find(item => item.url === 'origin').valueString, 'custom');
    assertPublic(created.canonical); assertPublic(created.instance);
    assert.throws(() => serviceLifecycle.registerHealthcareService({ store: f.store, callerOrganization: f.sp, request: serviceDefinitionDraft(command.definition.grant.authoring), clock }), /Private PCM metadata/);
    const ordinary = serviceLifecycle.registerHealthcareService({ store: f.store, callerOrganization: f.sp, request: authored('Ordinary public definition').resource, clock });
    const ordinaryDefinition = f.store.privateRecords.services.getDefinition(ordinary.canonical.id);
    assert.equal(ordinaryDefinition.status, 'ok'); assert.equal(ordinaryDefinition.grant.historyMode, 'creation-fixed');
    assert.equal(ordinaryDefinition.confidentialityPolicy.allowRestricted, false);
    assert.match(ordinaryDefinition.grant.scope, /ge2024-11-08/);
    const master = serviceDefinitionCommand({ ...command.definition.grant.authoring, name: 'Explicit private master policy',
        confidentialityPolicy: { allowRestricted: true }, includeMasterData: true,
        approvalScope: `${EXACT} patient/Organization.r?${V} patient/Practitioner.r?${V}` }, { now: clock().getTime() / 1000 });
    const explicit = serviceLifecycle.registerHealthcareService({ store: f.store, callerOrganization: f.sp, request: master.resource, privateDefinition: master.definition, clock });
    const policy = f.store.privateRecords.services.getDefinition(explicit.instance.id);
    assert.equal(policy.includeMasterData, true); assert.equal(policy.confidentialityPolicy.allowRestricted, true);
    const menu = require('../src/approval-scopes').approvalScopeOptions(f.store, explicit.instance, { now: clock().getTime() / 1000 });
    assert.equal(menu[0].value, master.definition.grant.scope); assert.match(menu[1].value, /patient\/Organization.r/);
    assert.doesNotMatch(menu[1].value, /Confidentiality\|R/);
});

test('nested private extension/tag/display/ad-hoc injection denies without banning ordinary extensions or JSON text', () => {
    const f = fixture(), before = snapshot(f.store, { privateState: true });
    const privateUri = 'urn:pcm:sandbox:service-grant';
    const attacks = [
        { extension: [{ url: 'https://third.party/ordinary', extension: [{ url: privateUri, valueString: '{}' }] }] },
        { meta: { tag: [{ system: 'urn:pcm:sandbox:seed-definition', display: '{}' }] } },
        { name: JSON.stringify({ authoring: { approvalScope: EXACT } }) },
        { type: [{ text: JSON.stringify({ extension: [{ url: privateUri, valueString: '{}' }] }) }] },
        { text: { status: 'generated', div: `<div>${privateUri}</div>` } },
        { text: { status: 'generated', div: '<div>{&quot;authoring&quot;:{&quot;scope&quot;:&quot;forged&quot;}}</div>' } },
        { approvalSnapshot: { scope: EXACT } }
    ];
    for (const attack of attacks) {
        const resource = { ...f.service, ...attack };
        assert.throws(() => f.store.update(resource), /Private PCM metadata/);
        assert.throws(() => publicDto({ resourceType: 'Bundle', type: 'searchset', entry: [{ resource }] }), /Private PCM metadata/);
    }
    assert.deepEqual(snapshot(f.store, { privateState: true }), before);
    const ordinary = { ...f.service, extension: [...f.service.extension, { url: 'urn:third-party:ordinary', valueString: '{"message":"clinical test label","count":2}' }],
        text: { status: 'generated', div: '<div>Normal clinical test description</div>' } };
    assert.deepEqual(publicDto(ordinary), ordinary);
    assertPublic(f.store.update(ordinary));
});

test('missing/inconsistent authority denies issuance and source change without public fallback', () => {
    const f = fixture();
    const saved = lifecycle.approveConsent({ ...f, scopeChoice: 'custom', customScope: EXACT, clock });
    const source = require('../src/data-sources').getConfiguredDataSources(f.config).find(item => !item.compatibilityOnly);
    const request = { store: f.store, config: f.config, client: { role: 'service-provider', organizationId: f.sp.id, clientId: f.config.organizations.serviceProvider.clientId },
        requested: { type: 'fhir', basis: { resourceType: 'Consent', identifier: saved.identifier[0] } },
        scope: 'patient/Patient.rs patient/Observation.rs', resource: source.endpoint, now: clock().getTime() / 1000 };
    // Use the maintained RAR builder so this tests real authority selection.
    request.requested = require('../../../test-support/data-grants').rar('Consent', saved.identifier[0].value);
    const allowed = resolveDataSourceGrant(request); assert.equal(allowed.grant?.scope, EXACT, JSON.stringify(allowed));
    const key = `Consent/${saved.id}`, decision = f.store.privateState.approvals[key];
    delete f.store.privateState.approvals[key];
    assert.equal(resolveDataSourceGrant(request).error, 'invalid_scope');
    assert.throws(() => require('../src/fhir/sandbox-source-change').previewSourceChange({ store: f.store, config: f.config, consentId: saved.id, expectedVersion: saved.meta.versionId, sourceOrganizationIds: [], now: clock() }), /Private approval/);
    f.store.privateState.approvals[key] = decision;
    const definitions = f.store.privateState.services; f.store.privateState.services = {};
    assert.equal(resolveDataSourceGrant(request).error, 'invalid_scope'); f.store.privateState.services = definitions;
    assert.equal(resolveDataSourceGrant({ ...request, scope: 'patient/Observation.s' }).grant.scope, EXACT);
});

test('approval and definition publication failures roll back public/private/audit/authority together', () => {
    const f = fixture(), before = snapshot(f.store, { privateState: true });
    const createDecision = f.store.privateRecords.approvals.createDecision;
    f.store.privateRecords.approvals.createDecision = () => { throw new Error('injected private publication failure'); };
    assert.throws(() => lifecycle.approveConsent({ ...f, clock }), /injected/);
    assert.deepEqual(snapshot(f.store, { privateState: true }), before);
    f.store.privateRecords.approvals.createDecision = createDecision;
    const createDefinition = f.store.privateRecords.services.createDefinition;
    f.store.privateRecords.services.createDefinition = () => { throw new Error('injected definition failure'); };
    const command = authored();
    assert.throws(() => serviceLifecycle.registerHealthcareService({ store: f.store, callerOrganization: f.sp, request: command.resource, privateDefinition: command.definition, clock }), /injected/);
    assert.deepEqual(snapshot(f.store, { privateState: true }), before);
    f.store.privateRecords.services.createDefinition = createDefinition;
});

test('source remove/readd and cancellation retain frozen grant/history and irreversible source generations', () => {
    const f = fixture(), changes = require('../src/fhir/sandbox-source-change');
    let saved = lifecycle.approveConsent({ ...f, scopeChoice: 'custom', customScope: EXACT, clock });
    const original = f.store.privateRecords.approvals.getDecision(saved.id), sources = lifecycle.sourceIds(saved);
    const events = [];
    for (const ids of [[], sources]) {
        const result = changes.simulateSourceChange({ store: f.store, config: f.config, consentId: saved.id, expectedVersion: saved.meta.versionId,
            sourceOrganizationIds: ids, actor: 'owned-operator', sessionId: 'private-session', audit: event => events.push(event), clock });
        saved = result.consent; assertPublic(saved);
        assert.equal(changes.requiresExactSourceMembership(saved, f.store), true);
        assert.deepEqual(f.store.privateRecords.approvals.getDecision(saved.id).snapshot, original.snapshot);
    }
    assert.equal(events.length, 2); assert.ok(events.every(item => item.eventId));
    assert.ok(f.store.authorityState.generations.get(`Consent/${saved.id}/Organization/${sources[0]}`) > 0);
    const cancelled = require('../src/consent-cancellation').applyCancellation({ store: f.store, consentId: saved.id, expectedVersion: saved.meta.versionId,
        provider: { organizationId: f.sp.id, clientId: f.config.organizations.serviceProvider.clientId }, operator: 'owned-operator', audit: event => events.push(event), clock });
    assertPublic(cancelled); assert.equal(lifecycle.consentBusinessStatus(cancelled), 'service-provider-cancelled');
    assert.deepEqual(f.store.privateRecords.approvals.getDecision(saved.id).snapshot, original.snapshot);
    const restored = new FHIRStore({ clock }); hydrate(restored, snapshot(f.store, { privateState: true }));
    assert.equal(restored.privateRecords.approvals.getDecision(saved.id).publicVersionAtDecision, original.publicVersionAtDecision);
    assert.equal(lifecycle.consentBusinessStatus(restored.get('Consent', saved.id)), 'service-provider-cancelled');
});

test('custom sampler retains public client/source authorization declarations with private fixed query bookkeeping', () => {
    const f = fixture(), sampling = require('../src/fhir/sampling-policy');
    f.config.sandboxSampling = { sourceIds: ['ho-a', 'ho-b'] };
    f.config.systemAuthorization.clientEntitlements[f.config.organizations.serviceProvider.clientId] = ['sandbox-patient-sample'];
    for (const resource of sampling.samplingResourceDrafts(f.config, clock().getTime() / 1000)) publishNewResource(f.store, resource);
    const contract = f.store.getAll('Contract').find(sampling.isSamplingPolicy);
    assert.ok(contract, 'fixture enables custom sampler');
    const validated = sampling.validateSamplingPolicy(f.store, contract, f.config.organizations.pcm.id);
    assert.ok(validated.clients.length); assert.ok(validated.sources.length); assertPublic(contract); assertPublic(validated.service);
    const publicContract = structuredClone(contract); delete publicContract.meta.tag;
    assert.equal(sampling.isSamplingPolicy(publicContract), true, 'tag is descriptive, not policy authority');
    const key = `HealthcareService/${validated.service.id}`, owner = f.store.privateState.provisioning[key];
    delete f.store.privateState.provisioning[key];
    assert.throws(() => sampling.validateSamplingPolicy(f.store, contract, f.config.organizations.pcm.id), /Invalid/);
    f.store.privateState.provisioning[key] = owner;
});

test('catalog reconciliation uses private seeds/backups and cannot rewrite immutable permission definitions', () => {
    const f = fixture(), catalog = require('../src/catalog-bootstrap');
    const proposed = buildSeedDrafts(f.config, {}, clock).filter(item => item.resourceType === 'HealthcareService');
    const baseline = catalog.previewCatalog(f.store, proposed); assert.equal(baseline.conflicts.length, 0);
    const target = proposed.find(item => item.id === 'service-catalog-1'); target.name = 'Updated ordinary catalog label';
    let backup;
    const applied = catalog.reconcileCatalog(f.store, proposed, baseline.versions, value => { backup = value; });
    assert.ok(backup._private); applied.forEach(assertPublic);
    const definition = f.store.privateRecords.services.getDefinition('service-catalog-1');
    assert.equal(definition.status, 'ok');
    const consent = f.create(), saved = lifecycle.approveConsent({ ...f, consent, clock });
    assert.equal(f.store.privateRecords.approvals.getDecision(saved.id).snapshot.service.definitionVersion, definition.definitionVersion);
    const before = snapshot(f.store, { privateState: true });
    target.extension.find(item => item.url === EXTENSIONS.accessDuration).valueDuration.value++;
    const changed = catalog.previewCatalog(f.store, proposed);
    assert.throws(() => catalog.reconcileCatalog(f.store, proposed, changed.versions, () => {}), /new service definition/);
    assert.deepEqual(snapshot(f.store, { privateState: true }), before);
});

test('service pause/restore and workflow revocation keep private events and preserve public profile semantics', () => {
    const f = fixture(), commands = require('../src/sandbox-service-command');
    const service = f.store.get('HealthcareService', 'service-catalog-1');
    const saved = lifecycle.approveConsent({ ...f, clock });
    const before = f.store.privateRecords.approvals.getDecision(saved.id);
    const notifications = [];
    for (const action of ['disable', 'enable']) {
        const current = f.store.get('HealthcareService', service.id);
        commands.applyServiceCommand({ store: f.store, config: f.config, id: service.id, action, expectedVersion: current.meta.versionId, operator: 'owned-operator', audit: event => notifications.push(event), now: clock() });
        assertPublic(f.store.get('HealthcareService', service.id)); assertPublic(f.store.get('Consent', saved.id));
        assert.equal(f.store.privateRecords.lifecycle.getState('HealthcareService', service.id).restoreEligible, action === 'disable');
    }
    assert.deepEqual(f.store.privateRecords.approvals.getDecision(saved.id).snapshot, before.snapshot);
    assert.equal(notifications.length, 2); assert.ok(notifications.every(event => event.eventId));
    const policies = require('../src/fhir/system-policy');
    policies.provisionSystemPolicies(f.store, f.config, clock().getTime() / 1000);
    const policy = f.store.getAll('Contract')[0], changed = policies.transitionPolicy(f.store, policy.id, 'revoked', f.config);
    assert.equal(changed.status, 'revoked'); assertPublic(changed);
    assert.equal(f.store.privateRecords.lifecycle.getEvents('Contract', policy.id).at(-1).kind, 'workflow-policy-change');
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'public-metadata-03-workflow-'));
    const oldState = process.env.STATE_DIR, oldConfig = process.env.TEAM_CONFIG_PATH;
    try {
        process.env.STATE_DIR = directory; process.env.TEAM_CONFIG_PATH = path.join(directory, 'team-config.json');
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(f.config));
        f.config.healthOrganizations[2].institutionType = 'hospital';
        require('../src/workflow-source-configuration').withWorkflowSourceConfiguration(f.store, f.config, () => 'saved');
        const backupDir = path.join(directory, 'workflow-source-backups');
        const backup = JSON.parse(fs.readFileSync(path.join(backupDir, fs.readdirSync(backupDir)[0])));
        assert.equal(backup.resources._private.schema, 'pcm-private-state/1');
        assert.deepEqual(backup.resources._private.approvals[`Consent/${saved.id}`].snapshot, before.snapshot);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
        if (oldState === undefined) delete process.env.STATE_DIR; else process.env.STATE_DIR = oldState;
        if (oldConfig === undefined) delete process.env.TEAM_CONFIG_PATH; else process.env.TEAM_CONFIG_PATH = oldConfig;
    }
});

test('source private-event failure rolls back actor sets/generations and emits no committed diagnostics', () => {
    const f = fixture(), saved = lifecycle.approveConsent({ ...f, clock });
    const before = snapshot(f.store, { privateState: true }), events = [];
    const append = f.store.privateRecords.append;
    f.store.privateRecords.append = () => { throw new Error('injected event failure'); };
    assert.throws(() => require('../src/fhir/sandbox-source-change').simulateSourceChange({ store: f.store, config: f.config, consentId: saved.id,
        expectedVersion: saved.meta.versionId, sourceOrganizationIds: [], actor: 'owned', sessionId: 'owned-session', audit: event => events.push(event), clock }), /injected/);
    assert.deepEqual(snapshot(f.store, { privateState: true }), before); assert.deepEqual(events, []);
    f.store.privateRecords.append = append;
});

test('retained legacy/resource-only authority is fenced without converting or mutating it', () => {
    const f = fixture(), check = require('../src/public-fhir').assertRetainedCompatibility;
    check(new FHIRStore()); check(f.store);
    const resources = snapshot(f.store), loaded = new FHIRStore(); hydrate(loaded, resources);
    const before = snapshot(loaded, { privateState: true });
    assert.throws(() => check(loaded), /coordinated migration/);
    assert.deepEqual(snapshot(loaded, { privateState: true }), before);
    const bundle = publicDto({ resourceType: 'Bundle', type: 'collection', entry: Object.values(resources).flat().map(resource => ({ resource })) });
    assert.ok(bundle.entry.length); assert.equal(JSON.stringify(bundle).includes('_private'), false);
});

test('source-only private commands preserve exact original first-use key/file bytes and unrelated authority generations', () => {
    const f = fixture(), directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'public-metadata-03-first-use-'));
    try {
        const ids = f.config.healthOrganizations.map(source => source.dataSourceOrganization.id);
        let saved = lifecycle.approveConsent({ ...f, sourceOrganizationIds: [ids[0]], approvedAccessMode: 'one-time', clock });
        const windows = new (require('../src/state-store').FileFirstUseWindowStore)(directory);
        const key = require('../src/clinical-first-use').firstUseKey(f.service.id, saved.id, f.config.organizations.serviceProvider.clientId, ids[0]);
        const started = windows.getOrStart(key, 3600, clock().getTime() / 1000);
        const files = fs.readdirSync(directory), bytes = files.map(file => fs.readFileSync(path.join(directory, file), 'utf8'));
        const generation = f.store.authorityState.generations.get(`Consent/${saved.id}`);
        for (const sourceOrganizationIds of [[ids[0], ids[1]], [ids[1]], [], [ids[0]]]) {
            saved = require('../src/fhir/sandbox-source-change').simulateSourceChange({ store: f.store, config: f.config, consentId: saved.id, expectedVersion: saved.meta.versionId,
                sourceOrganizationIds, actor: 'owned', sessionId: 'owned-session', audit() {}, clock }).consent;
            assert.deepEqual(files.map(file => fs.readFileSync(path.join(directory, file), 'utf8')), bytes);
            assert.equal(f.store.authorityState.generations.get(`Consent/${saved.id}`), generation);
        }
        assert.equal(windows.getOrStart(key, 3600, started.expiresAt + 60).expiresAt, started.expiresAt);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('source trust publication preserves certificate inventory and rolls back its whole graph on failure', () => {
    const f = fixture(), module = require('../src/data-sources'), before = snapshot(f.store, { privateState: true });
    const update = f.store.update.bind(f.store); let writes = 0;
    f.store.update = value => { const resource = update(value); if (++writes === 2) throw new Error('injected source publication failure'); return resource; };
    assert.throws(() => module.syncDataSourcesToStore(f.store, f.config, 'B'.repeat(43)), /injected/);
    assert.deepEqual(snapshot(f.store, { privateState: true }), before); f.store.update = update;
    module.syncDataSourcesToStore(f.store, f.config, 'B'.repeat(43));
    for (const endpoint of f.store.getAll('Endpoint')) {
        assertPublic(endpoint); assert.ok(endpoint.extension.some(item => item.url === EXTENSIONS.applicableCertificates));
        assert.equal(endpoint.extension.some(item => item.url.endsWith('ext-data-source-server-trust')), false);
    }
});
