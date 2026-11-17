'use strict';
/** Domain and real OAuth/FHIR coverage for the consent Services screen. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { serviceDefinition, existingRegistration } = require('../src/service-definition-form');
const { applyServiceCommand, serviceActions, csrf } = require('../src/sandbox-service-command');
const lifecycle = require('../src/fhir/healthcare-service-lifecycle');
const { FHIRStore } = require('../src/fhir/store');
const { buildTeamConfig } = require('../../../test-support/team-config');

/** A minimal supported definition, with selected resource/actions retained through ordinary extension metadata. */
function definition(overrides = {}) {
    return { name: 'Owned service', purpose: 'Review laboratory results', category: '35', accessMode: 'continuous', duration: 6, durationUnit: 'mo', allowChanges: false,
        buckets: [{ code: 'laboratoryTests', history: 2, historyUnit: 'a', sensitivity: [] }], permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 's' }], ...overrides };
}
/** Build a detached complete service graph without any runtime or retained-team mutation. */
function graph() {
    const config = buildTeamConfig(), store = new FHIRStore();
    for (const resource of require('../src/bootstrap').buildSeedDrafts(config)) require('../src/public-fhir').publishNewResource(store, resource);
    const provider = store.get('Organization', config.organizations.serviceProvider.id);
    let count = 0;
    const created = lifecycle.registerHealthcareService({ store, callerOrganization: provider, request: serviceDefinition(definition()), idGenerator: () => `owned-service-${++count}` });
    const events = [];
    const apply = (service, action, extra = {}) => applyServiceCommand({ store, config, id: service.id, expectedVersion: store.get('HealthcareService', service.id)?.meta.versionId,
        action, operator: 'unit-admin', audit: event => events.push(event), ...extra });
    return { config, store, provider, ...created, events, apply };
}

test('minimal and invalid definitions reuse supported scope mapping and closed registration profiles', () => {
    const request = serviceDefinition(definition());
    assert.equal(lifecycle.classifyRegistrationRequest(request), 'new-service');
    assert.equal(request.providedBy, undefined); assert.equal(request.active, undefined); assert.equal(request.identifier, undefined);
    assert.match(require('../src/service-definition-form').serviceDefinitionCommand(definition()).definition.grant.scope, /patient\/Observation.s/);
    require('../src/public-fhir').assertPublic(request);
    assert.equal(lifecycle.classifyRegistrationRequest(existingRegistration('definition-1')), 'existing-catalog');
    for (const overrides of [{ name: '' }, { purpose: ' ' }, { duration: 0 }, { buckets: [] }, { category: 'invalid' }, { permissions: [{ type: 'Condition', actions: 'rs' }] },
        { permissions: [{ type: 'Observation', actions: 'w' }] }, { buckets: [{ code: 'laboratoryTests', history: -1, historyUnit: 'a', sensitivity: [] }] },
        { buckets: [{ code: 'laboratoryTests', history: 1, historyUnit: 'a', sensitivity: ['urn:unknown|secret'] }] }, { providedBy: 'forged' }]) assert.throws(() => serviceDefinition(definition(overrides)));
});

test('private activation orders prerequisites, catalog toggles are reversible, terminal/frozen/strict actions deny', () => {
    const f = graph();
    assert.throws(() => f.apply(f.instance, 'activate'), /definition first/);
    f.apply(f.canonical, 'activate'); f.apply(f.instance, 'activate');
    assert.equal(lifecycle.serviceIsOperational(f.store, f.store.get('HealthcareService', f.instance.id)), true);
    f.apply(f.canonical, 'disable');
    assert.equal(lifecycle.businessStatus(f.store.get('HealthcareService', f.canonical.id)), 'frozen');
    assert.equal(lifecycle.businessStatus(f.store.get('HealthcareService', f.instance.id)), 'active');
    assert.equal(lifecycle.serviceIsOperational(f.store, f.store.get('HealthcareService', f.instance.id)), false);
    f.apply(f.canonical, 'enable'); f.apply(f.instance, 'disable'); f.apply(f.instance, 'enable');
    let active = f.store.get('HealthcareService', f.instance.id);
    assert.throws(() => f.apply(active, 'disable', { expectedVersion: '1' }), /changed/);
    const generations = new Map(f.store.authorityState.generations);
    f.apply(active, 'disable', { audit() { throw Error('audit failed'); } });
    assert.equal(lifecycle.businessStatus(f.store.get('HealthcareService', active.id)), 'suspended');
    assert.notDeepEqual(f.store.authorityState.generations, generations);
    assert.match(f.store.lastDiagnosticError.message, /audit failed/);
    assert.equal(f.store.privateRecords.lifecycle.getEvents('HealthcareService', active.id).at(-1).action, 'disable');
    active = f.store.get('HealthcareService', active.id);
    assert.throws(() => f.apply(active, 'disable', { config: buildTeamConfig({}, 'strict') }), error => error.status === 403);
    f.store.update({ ...active, active: false, extension: [lifecycle.statusExtension('cancelled'), ...active.extension.filter(item => item.url !== require('../../shared/pcm-contract').EXTENSIONS.serviceBusinessStatus)] });
    assert.throws(() => f.apply(active, 'enable'), /Terminal/);
    const catalog = f.store.get('HealthcareService', f.canonical.id);
    f.store.update({ ...catalog, active: false, extension: [lifecycle.statusExtension('frozen'), ...catalog.extension.filter(item => item.url !== require('../../shared/pcm-contract').EXTENSIONS.serviceBusinessStatus)] });
    assert.throws(() => f.apply(catalog, 'enable'), /unavailable/);
});

test('delete requires inactive target, protects dependencies/configuration, increments authority and rejects repeats', () => {
    const f = graph();
    assert.throws(() => f.apply(f.canonical, 'delete'), /assigned to providers|history references/);
    const seeded = f.store.getAll('HealthcareService').find(service => lifecycle.serviceKind(service) === 'catalog' && service.id !== f.canonical.id);
    assert.match(serviceActions({ ...f, service: seeded }).deleteReason, /installation configuration/);
    f.store.add({ resourceType: 'Consent', id: 'retained-reference', extension: [{ url: require('../../shared/pcm-contract').EXTENSIONS.pcmService, valueReference: { reference: `HealthcareService/${f.instance.id}` } }] });
    assert.throws(() => f.apply(f.instance, 'delete'), /assigned to providers|history references/);
    f.store.remove('Consent', 'retained-reference'); // Owned malformed dependency fixture only.
    const generation = f.store.authorityState.generations.get(`HealthcareService/${f.instance.id}`);
    assert.equal(f.apply(f.instance, 'delete').reviewTarget, f.canonical.id); assert.equal(f.store.get('HealthcareService', f.instance.id), null);
    assert.equal(f.store.authorityState.generations.get(`HealthcareService/${f.instance.id}`), generation + 1);
    assert.throws(() => f.apply(f.instance, 'delete', { expectedVersion: '1' }), error => error.status === 404);
    f.apply(f.canonical, 'delete'); assert.equal(f.store.get('HealthcareService', f.canonical.id), null);
    assert.equal(f.events.filter(event => event.action === 'delete').length, 2);
});


test('service toggles reconcile consents and never revive terminal/expired approvals or old grants', () => {
    const { fixture } = require('../../../test-support/demo-sources');
    const { NOW } = require('../../../test-support/data-grants');
    const { resolveGrant } = require('../src/data-grant');
    const { evaluateSubjectToken } = require('../src/introspection-service');
    const { businessStatusExtension, consentBusinessStatus } = require('../src/fhir/consent-lifecycle');
    const { EXTENSIONS } = require('../../shared/pcm-contract');
    const f = fixture(), service = f.store.get('HealthcareService', f.service.id), definitionId = lifecycle.basedOnId(service);
    const grant = resolveGrant(f.request);
    const source = f.config.healthOrganizations[0], ds = { clientId: source.clientId, organizationId: source.dataSourceOrganization.id, role: 'data-source' };
    const token = { kind: 'data_source_access', sub: f.client.clientId, client_id: f.client.clientId, aud: source.endpoint, iat: NOW, exp: NOW + 1000,
        scope: grant.scope, authorization: grant, authorization_details: grant.authorization_details,
        pcm_authentication_context: { token_endpoint_mtls: { 'x5t#S256': 'A'.repeat(43) }, client_assertion_signing: { 'x5t#S256': 'B'.repeat(43) }, correlation_verified: true } };
    const inspect = () => evaluateSubjectToken({ token, caller: ds, store: f.store, config: f.config, firstUseStore: f.firstUseStore, now: NOW,
        findClient: id => id === f.client.clientId ? f.client : id === ds.clientId ? ds : null, controls: { consentState: true, serviceState: true } });
    assert.ok(inspect());
    const apply = (id, action) => applyServiceCommand({ store: f.store, config: f.config, id, action, expectedVersion: f.store.get('HealthcareService', id).meta.versionId, operator: 'test', audit() {}, now: new Date(NOW * 1000) });
    apply(definitionId, 'disable'); assert.equal(consentBusinessStatus(f.store.get('Consent', f.consent.id)), 'temporarily-inactive'); assert.equal(inspect(), null);
    apply(definitionId, 'enable'); assert.equal(consentBusinessStatus(f.store.get('Consent', f.consent.id)), 'active'); assert.equal(inspect(), null);
    // The irreversible authority stamp requires a fresh token after restoration.
    assert.ok(resolveGrant(f.request));
    const terminal = f.store.get('Consent', f.consent.id);
    terminal.status = 'inactive'; terminal.extension = terminal.extension.map(item => item.url === EXTENSIONS.consentBusinessStatus ? businessStatusExtension('service-provider-cancelled') : item);
    f.store.update(terminal); apply(service.id, 'disable'); apply(service.id, 'enable');
    assert.equal(consentBusinessStatus(f.store.get('Consent', f.consent.id)), 'service-provider-cancelled');
    const expired = fixture();
    const consent = require('../src/fhir/consent-lifecycle').approveConsent({ store: expired.store, consent: expired.createPending(),
        sourceOrganizationIds: [expired.ids[0]], approvedEnd: new Date((NOW + 10) * 1000).toISOString(), clock: () => new Date(NOW * 1000) });
    for (const action of ['disable', 'enable']) applyServiceCommand({ store: expired.store, config: expired.config, id: expired.service.id, action,
        expectedVersion: expired.store.get('HealthcareService', expired.service.id).meta.versionId, operator: 'test', audit() {}, now: new Date((NOW + 11) * 1000) });
    assert.equal(consentBusinessStatus(expired.store.get('Consent', consent.id)), 'permanently-inactive');
});

test('private version/CSRF bindings and dependencies fail closed without authenticated Admin configuration', async () => {
    const { assertCommand } = require('../src/sandbox-service-command');
    const request = (token, origin) => ({ body: { csrf: token }, protocol: 'http', get: key => ({ host: 'localhost:4100', origin })[key] });
    assert.doesNotThrow(() => assertCommand(request(csrf('serviceProvider')), { providerRole: 'serviceProvider' }));
    assert.throws(() => assertCommand(request(csrf('serviceProvider')), { providerRole: 'hospitalBServiceProvider' }), error => error.status === 403);
    assert.throws(() => assertCommand(request(csrf('', 'id', '1'), 'https://foreign.test'), { id: 'id', version: '1' }), error => error.status === 403);
    assert.throws(() => assertCommand(request(csrf('', 'id', '1')), { id: 'id', version: '2' }), error => error.status === 403);
    const f = graph();
    const owner = f.store.get('Organization', f.provider.id); f.store.update({ ...owner, active: false });
    f.apply(f.canonical, 'activate'); // Catalog approval does not require any operational assignment.
    assert.throws(() => f.apply(f.instance, 'activate'), /operational Service Provider/);
    f.store.add({ resourceType: 'Contract', id: 'policy-ref', topicReference: { reference: `HealthcareService/${f.instance.id}` } });
    assert.match(serviceActions({ ...f, service: f.instance }).deleteReason, /assigned to providers|history references/);
    const express = require('express'), app = express();
    const previous = process.env.TEAM_ADMIN_PASSWORD; delete process.env.TEAM_ADMIN_PASSWORD;
    app.use('/admin/services', require('../src/routes/services').servicesRouter({ store: f.store, getConfig: () => f.config }));
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    try { assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/admin/services`)).status, 503); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (previous !== undefined) process.env.TEAM_ADMIN_PASSWORD = previous; }
});

/** Evaluate the mounted controller's named function with explicitly owned DOM collaborators. */
function controllerFunction(name, next, context) {
    const source = fs.readFileSync(path.resolve(__dirname, '../../shared/ui/services.js'), 'utf8');
    const code = source.slice(source.indexOf(`    ${name === 'refresh' ? 'async ' : ''}function ${name}(`), name === 'bindForms' ? source.lastIndexOf(next) : source.indexOf(next));
    return require('node:vm').runInNewContext(`${code}\n${name}`, context);
}

test('Services local class bindings and native disclosures have compact supported defaults', () => {
    const template = fs.readFileSync(path.resolve(__dirname, '../src/views/services.ejs'), 'utf8');
    const css = fs.readFileSync(path.resolve(__dirname, '../../shared/ui/connectathon.css'), 'utf8');
    assert.equal((template.match(/\bdata-service-owner\b/g) || []).length, 0, 'catalog drafts are provider-independent');
    assert.match(template, /data-provider-pair=/);
    assert.match(template, /<section[^>]*data-service-panel hidden/);
    assert.match(template, /services-starting-points/);
    assert.doesNotMatch(template, /data-service-panel[^>]*\bopen\b/);
    assert.match(template, /data-bucket-settings hidden/);
    for (const binding of ['services-toolbar', 'services-provider', 'services-group', 'data-bucket-settings', 'data-provider-review']) assert.ok(css.includes(`.services-page ${binding.startsWith('data-') ? '[' + binding + ']' : '.' + binding}`));
    assert.match(css, /\.services-page \.row \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.services-page \.row \{ grid-template-columns: minmax\(0, 1fr\)/);
});

test('bucket off/on disables hidden fields and restores explicit actions without mutations', () => {
    const fields = [{ disabled: false, value: '7' }, { disabled: false, value: 'mo' }];
    const settings = { hidden: false }, enabled = { checked: false };
    const category = { dataset: { types: '["Observation"]' }, querySelector: selector => selector === '[name="enabled"]' ? enabled : settings, querySelectorAll: () => fields };
    const types = [], selected = [];
    const context = { categories: [category], templateOrder: [], Set, JSON, remembered: new Map([['Observation', 's']]), scopePreview() {},
        typeHost: { querySelectorAll() { return []; }, replaceChildren() { types.length = 0; selected.length = 0; }, append(row) { types.push(row.dataset.permissionType); } },
        document: { createTextNode: value => value, createElement: tag => ({ dataset: {}, append(...children) { if (tag === 'label') selected.push(children[0]); } }) } };
    const update = controllerFunction('updateTypes', '    for (const category of categories) category.querySelector', context);
    update(); assert.equal(settings.hidden, true); assert.ok(fields.every(field => field.disabled)); assert.deepEqual(types, ['Patient']);
    enabled.checked = true; update(); assert.equal(settings.hidden, false); assert.ok(fields.every(field => !field.disabled));
    assert.equal(fields[0].value, '7'); assert.equal(fields[1].value, 'mo'); assert.deepEqual(types, ['Patient', 'Observation']);
    assert.deepEqual(selected.map(input => input.checked), [false, true]);
    context.remembered.clear(); update(); assert.deepEqual(selected.map(input => input.checked), [true, true], 'newly introduced resource types default to read and search');
    context.remembered.set('Observation', ''); update(); assert.deepEqual(selected.map(input => input.checked), [false, false], 'explicit deselection remains distinct from an unintroduced type');
    context.templateOrder = ['Observation', 'Patient']; update(); assert.deepEqual(types, ['Observation', 'Patient'], 'template authored order survives population without promoting actions');
});

test('controller refresh retains the provider-independent live draft on success and failed loads', async () => {
    const reviewInput = { checked: true, required: false }, review = { hidden: true, querySelector: () => reviewInput };
    const create = { dataset: { providerRole: 'serviceProvider', csrf: 'old' }, querySelector: () => ({ textContent: '' }) };
    const provider = { value: 'serviceProvider' }, owner = { textContent: 'Original owner' }, loading = {}, panel = {};
    const providerChoice = { options: [], append(option) { this.options.push(option); } };
    const fresh = { dataset: { providerRole: 'hospitalBServiceProvider', csrf: 'new' } };
    let accept = true, fail = false, fetches = 0, replacements = 0, binds = 0;
    const fragment = { dataset: { servicesFragment: 'list' }, replaceWith() { replacements++; } };
    const context = { URL, location: { href: 'http://owned.test/admin/services?providerRole=serviceProvider' }, loadingData: false, submitting: false, dirty: true,
        create, provider, review, loading, panel, loadSequence: 0, activeLoad: null, AbortController, filters: { name: '', state: '', provider: 'known-provider', providerLabel: 'Known provider' }, visitedPages: new Set(), filterRows() {}, window: { confirm: () => accept }, history: { pushState() {} },
        document: { createElement: () => ({}), querySelector: selector => selector === '[data-provider-filter]' ? providerChoice : selector === '[data-service-next]' ? null : owner, querySelectorAll: selector => selector === '[data-services-fragment]' ? [fragment] : [] }, bindForms() { binds++; }, releaseCreate() {}, invalidatePreview() {}, schedulePreview() {},
        fetch: async () => { fetches++; if (fail) throw Error('unavailable'); return { ok: true, text: async () => '' }; },
        DOMParser: class { parseFromString() { return { querySelector(selector) { if (selector === '[data-service-create]') return fresh; if (selector.includes('[role="alert"]')) return null; return selector === '[data-service-owner]' ? { textContent: 'New owner' } : {}; } }; } } };
    const refresh = controllerFunction('refresh', '    load.addEventListener', context);
    accept = true; fail = true; await refresh('http://owned.test/admin/services?providerRole=hospitalBServiceProvider');
    assert.equal(create.dataset.providerRole, 'serviceProvider'); assert.equal(replacements, 0); assert.match(loading.textContent, /draft, view and displayed records are unchanged/);
    fail = false; await refresh('http://owned.test/admin/services?providerRole=hospitalBServiceProvider');
    assert.equal(create.dataset.providerRole, 'hospitalBServiceProvider'); assert.equal(create.dataset.csrf, 'new');
    assert.equal(providerChoice.value, 'known-provider'); assert.match(providerChoice.options[0].textContent, /Known provider.*not on loaded pages/);
    assert.equal(review.hidden, true); assert.equal(reviewInput.checked, true); assert.equal(reviewInput.required, false); assert.equal(binds, 1);
    await refresh('http://owned.test/admin/services?providerRole=hospitalBServiceProvider');
    assert.equal(create.dataset.providerRole, 'hospitalBServiceProvider'); assert.equal(binds, 2);
});

test('draft validation associates existing required rules with the exact editable control', () => {
    const input = value => ({ value, message: '', setCustomValidity(message) { this.message = message; } });
    const name = input('   '), purpose = input('Review lab results'), enabled = { ...input(''), checked: false }, action = input('');
    let choices = [];
    const validate = controllerFunction('validateDraft', '    /** Read only the supported form fields;', {
        create: { elements: { name, purpose } }, categories: [{ querySelector: () => enabled }], typeHost: { querySelector: () => action }, permissions: () => choices
    });
    validate(); assert.match(name.message, /Service name is required/); assert.equal(purpose.message, ''); assert.match(enabled.message, /data category/); assert.match(action.message, /read\/search/);
    name.value = 'Lab review'; enabled.checked = true; choices = [{ type: 'Patient', actions: 'r' }]; validate();
    for (const field of [name, purpose, enabled, action]) assert.equal(field.message, '');
});

test('loaded-page filters keep duplicate names distinct, label partial counts and expose no-match state', () => {
    const rows = [{ dataset: { serviceName: 'Same name', serviceState: 'active' }, querySelectorAll: () => [], querySelector: () => null }, { dataset: { serviceName: 'Same name', serviceState: 'pending' }, querySelectorAll: () => [], querySelector: () => null }];
    const count = {}, empty = {};
    const view = { querySelectorAll: () => rows, querySelector: selector => selector === '[data-service-count]' ? count : empty };
    const context = { document: { querySelectorAll: () => [view] }, filters: { name: 'same', state: 'pending' } };
    const filter = controllerFunction('filterRows', "    document.addEventListener('input'", context);
    filter(); assert.deepEqual(rows.map(row => row.hidden), [true, false]); assert.equal(count.textContent, '1 of 2 loaded service groups; 0 of 0 loaded assignment rows. Unloaded providers and services are not searched.'); assert.equal(empty.hidden, true);
    context.filters.name = 'absent'; filter(); assert.equal(count.textContent, '0 of 2 loaded service groups; 0 of 0 loaded assignment rows. Unloaded providers and services are not searched.'); assert.equal(empty.hidden, false);
});

test('a late old-provider response cannot replace the latest rows, ownership or CSRF binding', async () => {
    const create = { dataset: { providerRole: 'hospitalBServiceProvider', csrf: 'B-old' }, querySelector: () => ({ textContent: '' }) };
    let resolveOld, replacements = 0;
    const old = new Promise(resolve => { resolveOld = resolve; });
    const owner = {}, controls = {}, fragment = { dataset: { servicesFragment: 'list' }, replaceWith() { replacements++; } };
    const context = { URL, AbortController, location: { href: 'http://owned.test/admin/services?providerRole=hospitalBServiceProvider' },
        loadingData: false, submitting: false, dirty: false, loadSequence: 0, activeLoad: null, visitedPages: new Set(), filters: { name: '', state: '' },
        create, provider: {}, review: { querySelector: () => ({}) }, panel: {}, loading: {}, window: {}, history: { pushState() {} },
        document: { querySelector: selector => selector === '[data-service-next]' ? null : selector === '[data-service-owner]' ? owner : controls,
            querySelectorAll: selector => selector === '[data-services-fragment]' ? [fragment] : [] },
        filterRows() {}, bindForms() {}, releaseCreate() {}, invalidatePreview() {}, schedulePreview() {},
        fetch: async url => url.includes('=serviceProvider') ? old : { ok: true, text: async () => 'hospitalBServiceProvider' },
        DOMParser: class { parseFromString(role) { return { querySelector(selector) {
            if (selector === '[data-service-create]') return { dataset: { providerRole: role, csrf: `${role}-fresh` } };
            if (selector.includes('[role="alert"]')) return null;
            return {};
        } }; } } };
    const refresh = controllerFunction('refresh', '    load.addEventListener', context);
    const oldRequest = refresh('http://owned.test/admin/services?providerRole=serviceProvider');
    await refresh('http://owned.test/admin/services?providerRole=hospitalBServiceProvider');
    resolveOld({ ok: true, text: async () => 'serviceProvider' }); await oldRequest;
    assert.equal(replacements, 1); assert.equal(create.dataset.providerRole, 'hospitalBServiceProvider'); assert.equal(create.dataset.csrf, 'hospitalBServiceProvider-fresh');
    assert.equal(context.loadingData, false);
});

// Ordinary discovery cursor traversal remains in service-list-projection's API tests.
// The grouped UI uses exact-revision service/provider pages; services-directory-api.test.js
// exercises later targets, missing owners, stale snapshots and unavailable reads.

test('ordinary owner transitions reconcile Consent history and invalidate old grants after reversible restoration', () => {
    const { fixture } = require('../../../test-support/demo-sources');
    const { NOW } = require('../../../test-support/data-grants');
    const { resolveGrant } = require('../src/data-grant');
    const { evaluateSubjectToken } = require('../src/introspection-service');
    const { businessStatusExtension, consentBusinessStatus, reconcileConsentsForService } = require('../src/fhir/consent-lifecycle');
    const { EXTENSIONS } = require('../../shared/pcm-contract');
    const f = fixture(), original = structuredClone(f.service), definition = structuredClone(f.store.get('HealthcareService', lifecycle.basedOnId(f.service)));
    const grant = resolveGrant(f.request), source = f.config.healthOrganizations[0];
    const ds = { clientId: source.clientId, organizationId: source.dataSourceOrganization.id, role: 'data-source' };
    const token = { kind: 'data_source_access', sub: f.client.clientId, client_id: f.client.clientId, aud: source.endpoint, iat: NOW, exp: NOW + 1000,
        scope: grant.scope, authorization: grant, authorization_details: grant.authorization_details,
        pcm_authentication_context: { token_endpoint_mtls: { 'x5t#S256': 'A'.repeat(43) }, client_assertion_signing: { 'x5t#S256': 'B'.repeat(43) }, correlation_verified: true } };
    const inspect = () => evaluateSubjectToken({ token, caller: ds, store: f.store, config: f.config, firstUseStore: f.firstUseStore, now: NOW,
        findClient: id => id === f.client.clientId ? f.client : id === ds.clientId ? ds : null, controls: { consentState: true, serviceState: true } });
    let transitionNow = NOW;
    const transition = state => {
        require('../src/fhir/consent-lifecycle').reconcileExpiredConsents({ store: f.store, now: new Date(transitionNow * 1000) });
        return lifecycle.transitionHealthcareService({ store: f.store, callerOrganization: f.store.get('Organization', lifecycle.ownerId(f.service)),
        existing: f.store.get('HealthcareService', f.service.id), request: { resourceType: 'HealthcareService', id: f.service.id, extension: [lifecycle.statusExtension(state)] },
        afterTransition: ({ service, nextStatus }) => reconcileConsentsForService({ store: f.store, serviceId: service.id, serviceState: nextStatus, now: new Date(transitionNow * 1000) }) });
    };
    assert.ok(inspect()); transition('suspended');
    assert.equal(consentBusinessStatus(f.store.get('Consent', f.consent.id)), 'temporarily-inactive'); assert.equal(inspect(), null);
    transition('active'); assert.equal(consentBusinessStatus(f.store.get('Consent', f.consent.id)), 'active'); assert.equal(inspect(), null);
    assert.ok(resolveGrant(f.request), 'fresh grant available after restoration');
    const consent = f.store.get('Consent', f.consent.id);
    const approveHistory = approvedEnd => require('../src/fhir/consent-lifecycle').approveConsent({ store: f.store, consent: f.createPending(),
        sourceOrganizationIds: [f.ids[0]], ...(approvedEnd ? { approvedEnd } : {}), clock: () => new Date(NOW * 1000) });
    const terminalHistory = approveHistory();
    f.store.update({ ...terminalHistory, status: 'inactive', extension: terminalHistory.extension.map(item => item.url === EXTENSIONS.consentBusinessStatus ? businessStatusExtension('service-provider-cancelled') : item) });
    const expiredHistory = approveHistory(new Date((NOW + 10) * 1000).toISOString());
    transitionNow = NOW + 11;
    transition('suspended'); transition('active');
    assert.equal(consentBusinessStatus(f.store.get('Consent', terminalHistory.id)), 'service-provider-cancelled');
    assert.equal(consentBusinessStatus(f.store.get('Consent', expiredHistory.id)), 'permanently-inactive');
    transition('suspended'); transition('cancelled');
    assert.equal(consentBusinessStatus(f.store.get('Consent', f.consent.id)), 'permanently-inactive');
    assert.throws(() => transition('active'), /not permitted/);
    assert.deepEqual(f.store.get('HealthcareService', definition.id), definition);
    assert.deepEqual(f.store.get('HealthcareService', f.service.id).identifier, original.identifier);
    assert.ok(f.store.get('Consent', f.consent.id), 'historical Consent retained');
});


test('owner client never replays uncertain PUT and route preserves concurrent API refusal', async () => {
    const f = graph(), express = require('express'), app = express();
    const originalPassword = process.env.TEAM_ADMIN_PASSWORD; process.env.TEAM_ADMIN_PASSWORD = 'owned-route-only';
    const role = 'serviceProvider', instance = { ...f.instance, active: true, meta: { ...f.instance.meta, versionId: '2' }, extension: f.instance.extension.map(item => item.url === require('../../shared/pcm-contract').EXTENSIONS.serviceBusinessStatus ? lifecycle.statusExtension('active') : item) };
    let calls = 0, transportError = false;
    app.use(express.json());
    app.use('/admin/services', require('../src/routes/services').servicesRouter({ store: f.store, getConfig: () => f.config, audit() {}, clientFactory: async () => ({
        read: async () => instance,
        status: async () => { calls++; throw Object.assign(new Error(transportError ? 'Uncertain upstream result; inspect before retry' : 'Owner transition frozen -> suspended is not permitted'), { status: transportError ? 503 : 409 }); }
    }) }));
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    try {
        const body = { providerRole: role, csrf: csrf(role, instance.id, '2'), expectedVersion: '2', expectedState: 'active', state: 'suspended' };
        const send = () => fetch(`http://127.0.0.1:${server.address().port}/admin/services/${instance.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        let response = await send(); assert.equal(response.status, 409); assert.match((await response.json()).error, /frozen/); assert.equal(calls, 1);
        transportError = true; response = await send(); assert.equal(response.status, 503); assert.match((await response.json()).error, /inspect before retry/); assert.equal(calls, 2, 'one PUT per explicit request, never automatic replay');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (originalPassword === undefined) delete process.env.TEAM_ADMIN_PASSWORD; else process.env.TEAM_ADMIN_PASSWORD = originalPassword; }
});


test('one private context projects hidden definition prerequisites, foreign labels, missing and orphan targets', () => {
    const f = graph();
    const project = id => require('../src/sandbox-service-command').projectServiceContext({ ...f, selectedId: id, providerId: f.provider.id });
    let preview = project(f.instance.id);
    assert.deepEqual(preview.targets.map(target => target.id), [f.canonical.id, f.instance.id]);
    assert.equal(preview.targets[0].label, 'Approve definition');
    assert.equal(preview.targets[1].label, 'Activate provider registration');
    assert.match(preview.targets[1].actionReasons.activate, /definition first/);
    assert.equal(preview.foreign, false);
    assert.equal(require('../src/sandbox-service-command').projectServiceContext({ ...f, selectedId: f.instance.id, providerId: 'other-provider' }).foreign, true);
    assert.deepEqual(project('absent').targets, []);
    f.store.data.HealthcareService.delete(f.canonical.id); // Deliberately corrupted persisted graph for unavailable-state projection.
    preview = project(f.instance.id);
    assert.equal(preview.missingDefinition, true);
    assert.equal(preview.targets.length, 1);
    assert.match(preview.targets[0].actionReasons.activate, /unavailable/);
    const orphan = graph(); orphan.apply(orphan.instance, 'delete');
    const retained = require('../src/sandbox-service-command').projectServiceContext({ ...orphan, selectedId: orphan.canonical.id, providerId: orphan.provider.id });
    assert.equal(retained.targets.length, 1);
    assert.ok(retained.targets[0].actions.includes('delete'));
    assert.ok(retained.targets[0].actions.includes('activate'), 'unassigned catalogs can be approved');
});


test('cleanup retains active, Contract and terminal Consent dependencies; stale deletion preserves unrelated records', () => {
    const f = graph(); const peer = f.store.getAll('HealthcareService').find(item => item.id !== f.canonical.id && item.id !== f.instance.id);
    f.apply(f.canonical, 'activate'); f.apply(f.instance, 'activate');
    assert.throws(() => f.apply(f.instance, 'delete'), /Disable/);
    f.apply(f.instance, 'disable');
    const current = f.store.get('HealthcareService', f.instance.id);
    assert.throws(() => f.apply(current, 'delete', { expectedVersion: '1' }), /changed/);
    f.store.add({ resourceType: 'Consent', id: 'terminal-history', status: 'inactive', extension: [{ url: require('../../shared/pcm-contract').EXTENSIONS.pcmService, valueReference: { reference: `HealthcareService/${current.id}` } }] });
    f.store.add({ resourceType: 'Contract', id: 'retained-contract', name: 'Retained policy', subject: [{ reference: `HealthcareService/${current.id}` }] });
    assert.throws(() => f.apply(current, 'delete'), /assigned to providers|history references/);
    let preview = require('../src/sandbox-service-command').projectServiceContext({ ...f, selectedId: current.id, providerId: f.provider.id });
    assert.ok(preview.targets[1].blockers.includes('Contract: Retained policy'));
    assert.deepEqual(preview.targets[1].dependencies.consents, ['terminal-history']);
    f.store.remove('Consent', 'terminal-history');
    assert.throws(() => f.apply(current, 'delete'), /assigned to providers|history references/);
    f.store.remove('Contract', 'retained-contract');
    f.apply(current, 'delete');
    assert.deepEqual(f.store.get('HealthcareService', peer.id), peer);
    assert.ok(f.store.get('HealthcareService', f.canonical.id));
});

test('protected groups expose every exact provider without invoking injected ordinary discovery', async () => {
    const f = graph(), express = require('express'), app = express();
    const previous = process.env.TEAM_ADMIN_PASSWORD; process.env.TEAM_ADMIN_PASSWORD = 'owned-context-test';
    let ordinaryCalls = 0;
    app.use((req, res, next) => { res.render = (view, data) => res.json({ groups: data.groups.map(group => ({ id: group.service.id, providers: group.providers.items.map(row => row.id) })) }); next(); });
    app.use('/admin/services', require('../src/routes/services').servicesRouter({ store: f.store, getConfig: () => f.config, audit() {}, clientFactory: async () => { ordinaryCalls++; throw Error('Unexpected ordinary discovery'); } }));
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/services?view=assignments&target=${f.instance.id}`);
        const actual = await response.json(), group = actual.groups.find(group => group.id === f.canonical.id);
        assert.deepEqual(group.providers.sort(), [f.config.organizations.serviceProvider.id, f.config.organizations.hospitalBServiceProvider.id].sort());
        assert.equal(ordinaryCalls, 0);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.TEAM_ADMIN_PASSWORD; else process.env.TEAM_ADMIN_PASSWORD = previous; }
});

/** Exercise the actual retained-form submit closure rather than duplicating its lock logic. */
test('explicit inspection restores every original button state and retains the no-replay guard until release', async () => {
    for (const outcome of ['success', 'lost', '503', 'validation']) {
        const buttons = [{ disabled: false }, { disabled: false }, { disabled: true }, { disabled: false, dataset: { helpFor: 'services.create' } }];
        let submit, requests = 0;
        const result = { append() {} };
        const form = { dataset: { providerRole: 'serviceProvider' }, reportValidity: () => true,
            hasAttribute: () => false, getAttribute: () => '/admin/services/create',
            querySelector: () => result, querySelectorAll: selector => selector === 'input,select,textarea' ? [] : buttons,
            addEventListener(_event, handler) { submit = handler; } };
        const context = { create: form, boundForms: new WeakSet(), loadingData: false, submitting: false,
            validateDraft() {}, definition: () => ({}), scopeOrigin: 'generated', previewProof: { anchor: 'reviewed', signature: 'fixture' }, templateKey: undefined, dirty: true,
            location: { href: 'http://owned.test/admin/services' }, URL,
            document: { querySelectorAll: () => [form], createElement: () => ({ dataset: {}, append() {} }) },
            fetch: async () => { requests++; if (outcome === 'lost') throw Error('lost response');
                return { ok: outcome === 'success', status: outcome === '503' ? 503 : outcome === 'validation' ? 400 : 200, json: async () => ({ message: 'Saved', error: 'Invalid' }) }; } };
        const bind = controllerFunction('bindForms', '    bindForms();', context); bind();
        const event = { preventDefault() {} };
        await submit(event);
        if (outcome === 'validation') {
            assert.deepEqual(buttons.map(button => button.disabled), [false, false, true, false]);
            buttons[1].disabled = true;
            context.releaseCreate();
            assert.equal(buttons[1].disabled, true, 'refresh without a completion lock must not restore stale states');
            continue;
        }
        assert.ok(buttons.slice(0, 3).every(button => button.disabled), outcome);
        assert.equal(buttons[3].disabled, false, 'help must remain available during the no-replay lock');
        await submit(event); assert.equal(requests, 1, 'locked submit cannot replay');
        context.releaseCreate();
        assert.deepEqual(buttons.map(button => button.disabled), [false, false, true, false], outcome);
        buttons[1].disabled = true; context.releaseCreate();
        assert.equal(buttons[1].disabled, true, 'repeated inspection must not reuse a consumed snapshot');
        await submit(event); assert.equal(requests, 2, 'a new explicit submit is permitted after inspection');
    }
});

test('referenced terminal cleanup explains the deletion dependency rather than an activation warning', () => {
    const f = graph();
    const terminal = f.store.update({ ...f.instance, active: false,
        extension: f.instance.extension.map(item => item.url === require('../../shared/pcm-contract').EXTENSIONS.serviceBusinessStatus ? lifecycle.statusExtension('cancelled') : item) });
    f.store.add({ resourceType: 'Consent', id: 'cleanup-history-reference', status: 'inactive',
        extension: [{ url: require('../../shared/pcm-contract').EXTENSIONS.pcmService, valueReference: { reference: `HealthcareService/${terminal.id}` } }] });
    const before = f.store.get('HealthcareService', terminal.id);
    assert.throws(() => f.apply(terminal, 'delete'), error => error.status === 409 && /history references/.test(error.message));
    assert.deepEqual(f.store.get('HealthcareService', terminal.id), before);
    assert.ok(f.store.get('Consent', 'cleanup-history-reference'));
    assert.equal(f.events.length, 0);
});

/** Exercise the actual directory success branch, including exact readback and inline focus. */
test('successful exact-provider Connect and missing-owner cleanup read back before publishing exact inline receipts', async () => {
    for (const deleted of [false, true]) {
        let submit, requested, inspected, focused = false;
        const result = {}, receipt = { focus() { focused = true; } }, buttons = [{ disabled: false }];
        const pair = { dataset: { providerPair: 'extra-provider', serviceId: 'old-registration' }, querySelectorAll: () => buttons };
        const group = { dataset: { serviceGroup: 'shared-definition' } };
        const current = { dataset: { providerPair: 'extra-provider', serviceId: 'new-registration' }, querySelector: () => receipt };
        const form = { dataset: { providerRole: 'registered-extra-role', csrf: 'exact-provider-proof', version: '2' }, elements: { catalogId: { value: 'shared-definition' } },
            hasAttribute: name => name === (deleted ? 'data-service-sandbox' : 'data-service-assign'), getAttribute: () => deleted ? '/mount/admin/services/old-registration/sandbox' : '/mount/admin/services/assign',
            closest: selector => selector === '[data-provider-pair]' || selector === '[data-service-id]' ? pair : selector === '[data-service-group]' ? group : null,
            querySelector: () => result, addEventListener(_event, handler) { submit = handler; } };
        const context = { create: {}, boundForms: new WeakSet(), loadingData: false, submitting: false, URL, window: { confirm: () => true },
            load: { action: 'http://owned.test/mount/admin/services' },
            refresh: async url => { inspected = url; return true; },
            document: { querySelectorAll: selector => selector === '[data-service-group]' ? [{ dataset: group.dataset, querySelectorAll: () => deleted ? [] : [current], querySelector: () => receipt }] : [form] },
            fetch: async (url, request) => { requested = { url, body: JSON.parse(request.body) }; return { ok: true, status: 200, json: async () => deleted ? { reviewTarget: 'shared-definition', message: 'Deleted from this runtime' } : { id: 'new-registration', reviewTarget: 'new-registration', message: 'Assigned — waiting for activation' } }; } };
        controllerFunction('bindForms', '    bindForms();', context)();
        await submit({ preventDefault() {}, ...(deleted ? { submitter: { value: 'delete', disabled: false, textContent: 'Delete registration' } } : {}) });
        assert.deepEqual(requested.body, deleted ? { action: 'delete', expectedVersion: '2', csrf: 'exact-provider-proof' } : { providerRole: 'registered-extra-role', csrf: 'exact-provider-proof', catalogId: 'shared-definition' });
        assert.equal(new URL(inspected).searchParams.get('target'), deleted ? 'shared-definition' : 'new-registration');
        assert.equal(new URL(inspected).searchParams.get('view'), 'assignments');
        assert.equal(receipt.textContent, deleted ? 'Organization/extra-provider: Deleted from this runtime' : 'Assigned — waiting for activation'); assert.equal(focused, true);
    }
});

test('provider filtering changes only visible loaded rows and counts, retaining exact row command bindings', () => {
    const pairs = ['one', 'two'].map(id => ({ dataset: { providerPair: id, providerRole: `${id}-credentials`, csrf: `${id}-proof` } }));
    const groups = [{ dataset: { serviceName: 'Laboratory', serviceState: 'active' }, querySelectorAll: () => pairs, querySelector: () => null }];
    const count = {}, empty = {}, before = JSON.stringify(pairs.map(pair => pair.dataset));
    const context = { document: { querySelectorAll: () => [{ querySelectorAll: () => groups, querySelector: selector => selector === '[data-service-count]' ? count : empty }] }, filters: { name: '', state: '', provider: 'two' } };
    const filter = controllerFunction('filterRows', "    document.addEventListener('input'", context);
    filter(); assert.deepEqual(pairs.map(pair => pair.hidden), [true, false]); assert.match(count.textContent, /1 of 2 loaded assignment rows/);
    assert.equal(JSON.stringify(pairs.map(pair => pair.dataset)), before);
    context.filters.provider = 'unloaded'; filter(); assert.equal(groups[0].hidden, false, 'group paging remains reachable for an unloaded provider'); assert.equal(empty.hidden, false);
    context.filters.provider = ''; filter(); assert.ok(pairs.every(pair => pair.hidden === false)); assert.equal(groups[0].hidden, false);
});
