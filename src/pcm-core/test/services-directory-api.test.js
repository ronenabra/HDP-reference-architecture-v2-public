'use strict';
/** Real mounted group pages and ordinary/private API boundaries on owned listeners. */
const test = require('node:test'), assert = require('node:assert/strict');
const { startServicesFixture } = require('../../../test-support/services-fixture');
const model = require('../src/services-admin-model'), lifecycle = require('../src/fhir/healthcare-service-lifecycle');
const command = require('../src/sandbox-service-command');
const { EXTENSIONS } = require('../../shared/pcm-contract');

/** Add fixture-only provider identities without borrowing any configured credential. */
function provider(f, id) {
    const source = f.store.get('Organization', f.config.organizations.serviceProvider.id);
    return f.store.add({ ...source, id, name: `Extra provider ${id}`, identifier: [{ ...source.identifier[0], value: `PCM-${id}` }] });
}

test('all-provider grouped renderer pages named services/pairs and never uses ordinary discovery', { timeout: 60000 }, async () => {
    const f = await startServicesFixture('connectathon-mtls', { browserBase: '/directory-owned' });
    try {
        const definition = require('../src/service-templates').loadTemplates()[0].definition;
        const created = [];
        for (let index = 0; index < 27; index++) created.push(model.createCatalog({ store: f.store, config: f.config, definition: { ...definition, name: `Directory ${index}` }, expectedRevision: f.store.privateState.revision, operator: 'unit', audit() {} }));
        for (let index = 0; index < 27; index++) provider(f, `extra-${String(index).padStart(2, '0')}`);
        f.config.organizations.extraIdentity = { id: 'extra-00', clientId: 'extra-own-client' };
        const missing = await fetch(f.base + '/admin/services/assign', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': f.password },
            body: JSON.stringify({ providerRole: 'extraIdentity', csrf: command.csrf('extraIdentity'), catalogId: created[0].id }) });
        assert.equal(missing.status, 503); assert.match((await missing.json()).error, /exact credentials are unavailable/);
        assert.equal(f.requests.length, 0, 'missing exact credentials fail before any OAuth/FHIR request');
        const requests = f.requests.length;
        const get = query => fetch(f.base + '/admin/services' + query, { headers: { 'x-admin-password': f.password } });
        let response = await get('?view=assignments'), html = await response.text();
        assert.equal(response.status, 200); assert.match(html, /Partial service snapshot/); assert.match(html, /Partial provider snapshot — unloaded pairs are unknown/);
        assert.match(html, /Next providers for/); assert.match(html, /No providers connected to this service/);
        assert.match(html, /Extra provider extra-00/); assert.match(html, /This provider’s exact certificates or keys are unavailable/); assert.doesNotMatch(html, /id="service-provider"|Load provider assignments/);
        assert.equal(f.requests.length, requests, 'group browsing performs no ordinary OAuth/FHIR calls');
        const target = model.catalogInventory({ ...f, query: { limit: '50' } }).items.at(-1);
        response = await get(`?view=assignments&target=${target.id}`); html = await response.text();
        assert.equal(response.status, 200); assert.match(html, new RegExp(`data-service-group="${target.id}"`));
        response = await get(`?view=assignments&target=${f.config.service.id}`); html = await response.text();
        const exactGroup = html.split(`data-service-group="${lifecycle.basedOnId(f.store.get('HealthcareService', f.config.service.id))}"`)[1].split('</section>')[0];
        assert.match(exactGroup, new RegExp(`data-provider-pair="${f.config.organizations.serviceProvider.id}"`));
        assert.doesNotMatch(exactGroup, /Organization\/extra-00/);
        const rev = f.store.privateState.revision;
        response = await get(`?view=assignments&target=${target.id}&group=${target.id}&providerOffset=25&providerRevision=${rev}`); html = await response.text();
        assert.equal(response.status, 200); assert.match(html, /First providers for/); assert.match(html, /Extra provider extra-26/); assert.doesNotMatch(html.split(`data-service-group="${target.id}"`)[1].split('</section>')[0], /Organization\/extra-00/);
        provider(f, 'extra-later');
        response = await get(`?view=assignments&target=${target.id}&group=${target.id}&providerOffset=25&providerRevision=${rev}`); html = await response.text();
        assert.equal(response.status, 409); assert.match(html, /Provider connections unknown: Inventory changed/); assert.doesNotMatch(html, /data-provider-pair="extra-26"/);
        response = await get('?view=assignments&providerOffset=25'); assert.equal(response.status, 400);
        response = await get('?view=assignments&group=not-on-page'); assert.equal(response.status, 400);
        assert.equal(f.requests.length, requests);
        f.store.remove('Organization', f.config.organizations.serviceProvider.id);
        response = await get(`?view=assignments&target=${f.config.service.id}`); html = await response.text();
        const orphanGroup = html.split(`data-service-group="${lifecycle.basedOnId(f.store.get('HealthcareService', f.config.service.id))}"`)[1].split('</section>')[0];
        assert.match(orphanGroup, /Unavailable provider/); assert.match(orphanGroup, new RegExp(`data-service-id="${f.config.service.id}"`));
        const inventory = model.providerInventory;
        try {
            model.providerInventory = () => { throw Error('Owned provider read failure'); };
            response = await get('?view=assignments'); html = await response.text();
            assert.match(html, /Provider connections unknown: Owned provider read failure/);
            assert.doesNotMatch(html, /data-provider-pair=|>Not connected</);
        } finally { model.providerInventory = inventory; }
    } finally { await f.close(); }
});

test('global catalog toggles preserve connected/paused/ended choices and frozen/terminal guards', { timeout: 60000 }, async () => {
    const f = await startServicesFixture();
    try {
        const definition = require('../src/service-templates').loadTemplates()[0].definition;
        const created = model.createCatalog({ ...f, definition: { ...definition, name: 'Global provider choice matrix' }, expectedRevision: f.store.privateState.revision, operator: 'unit', audit() {} });
        const apply = (id, action) => command.applyServiceCommand({ ...f, id, action, expectedVersion: f.store.get('HealthcareService', id).meta.versionId, operator: 'unit', audit() {} });
        apply(created.id, 'activate');
        const owners = [f.store.get('Organization', f.config.organizations.serviceProvider.id), f.store.get('Organization', f.config.organizations.hospitalBServiceProvider.id), provider(f, 'registered-third')];
        const records = owners.map(owner => lifecycle.registerHealthcareService({ store: f.store, callerOrganization: owner, request: require('../src/service-definition-form').existingRegistration(created.id) }).instance);
        records.forEach(record => apply(record.id, 'activate')); apply(records[1].id, 'disable'); apply(records[2].id, 'disable');
        const third = f.store.get('HealthcareService', records[2].id);
        lifecycle.transitionHealthcareService({ store: f.store, callerOrganization: owners[2], existing: third, request: { extension: [lifecycle.statusExtension('cancelled')] } });
        const states = () => records.map(item => lifecycle.businessStatus(f.store.get('HealthcareService', item.id)));
        const before = states(); assert.deepEqual(before, ['active', 'suspended', 'cancelled']);
        apply(created.id, 'disable'); assert.deepEqual(states(), before);
        assert.ok(records.every(item => !lifecycle.serviceIsOperational(f.store, f.store.get('HealthcareService', item.id))));
        apply(created.id, 'enable'); assert.deepEqual(states(), before);
        assert.deepEqual(records.map(item => lifecycle.serviceIsOperational(f.store, f.store.get('HealthcareService', item.id))), [true, false, false]);
        const groups = model.providerInventory({ ...f, catalogId: created.id });
        assert.equal(groups.items.find(item => item.id === owners[2].id).standardManagement, false);
        assert.throws(() => apply(third.id, 'enable'), /Terminal/);
        for (const state of ['frozen', 'rejected']) {
            const current = f.store.get('HealthcareService', records[1].id);
            f.store.update({ ...current, active: false, extension: [lifecycle.statusExtension(state), ...current.extension.filter(item => item.url !== EXTENSIONS.serviceBusinessStatus)] });
            const row = model.providerInventory({ ...f, catalogId: created.id }).items.find(item => item.id === owners[1].id).registrations[0];
            assert.deepEqual(row.standard.actions, []); assert.ok(!row.admin.actions.includes('enable')); assert.throws(() => apply(row.id, 'enable'));
        }
    } finally { await f.close(); }
});
