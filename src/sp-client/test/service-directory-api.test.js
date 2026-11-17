'use strict';
/** Actual PCM mTLS/OAuth/read/search wire for Doctor's ordinary service consumer. */
const test = require('node:test'), assert = require('node:assert/strict');
const { startServicesFixture } = require('../../../test-support/services-fixture');
const lifecycle = require('../../pcm-core/src/fhir/healthcare-service-lifecycle');
const { applyServiceCommand } = require('../../pcm-core/src/sandbox-service-command');
const { serviceDefinition, existingRegistration } = require('../../pcm-core/src/service-definition-form');
const input = index => ({ name: `LIST wire ${index}`, purpose: 'Disposable service list verification', category: '35', accessMode: 'continuous', duration: 6, durationUnit: 'mo', allowChanges: false,
    buckets: [{ code: 'laboratoryTests', history: 2, historyUnit: 'a', sensitivity: [] }], permissions: [{ type: 'Patient', actions: 'rs' }, { type: 'Observation', actions: 's' }] });

test('Doctor follows real caller-bound pages, resolves off-page owned instances and detects owner/shared lifecycle', async () => {
    const f = await startServicesFixture();
    const doctor = require('../src/client');
    /** Apply an explicit fixture-owned lifecycle transition without editing approved fields. */
    const command = (id, action) => applyServiceCommand({ store: f.store, config: f.config, id, action, expectedVersion: f.store.get('HealthcareService', id).meta.versionId, operator: 'list-owned', audit() {} });
    try {
        // Ordinary fixture resources/decisions are disposable. Keep seed inputs unchanged.
        for (const item of f.store.getAll('HealthcareService').sort((a, b) => Number(!lifecycle.basedOnId(a)) - Number(!lifecycle.basedOnId(b)))) f.store.remove('HealthcareService', item.id);
        const firstProvider = f.store.get('Organization', f.config.organizations.serviceProvider.id);
        const secondProvider = f.store.get('Organization', f.config.organizations.hospitalBServiceProvider.id);
        for (let i = 0; i < 26; i++) {
            const result = lifecycle.registerHealthcareService({ store: f.store, callerOrganization: secondProvider, request: serviceDefinition(input(i)) });
            command(result.canonical.id, 'activate'); command(result.instance.id, 'activate');
        }
        const result = lifecycle.registerHealthcareService({ store: f.store, callerOrganization: firstProvider, request: serviceDefinition(input('owned-later')) });
        const id = result.instance.id, catalog = lifecycle.basedOnId(result.instance);
        command(catalog, 'activate'); command(id, 'activate');
        const first = await doctor.searchServices('hospital-a');
        assert.equal(first.services.length, 0); assert.ok(first.next); assert.equal(first.complete, false);
        const later = await doctor.searchServices('hospital-a', { page: first.next, pages: first.pages, seen: [first.next], used: first.used });
        assert.equal(later.services.length, 1); assert.equal(later.services[0].id, id); assert.equal(later.services[0].available, true);
        assert.equal((await doctor.readOwnedService(id, 'hospital-a')).definitionId, catalog);
        await assert.rejects(doctor.searchServices('hospital-b', { page: first.next }), error => error.response?.status === 400);
        await assert.rejects(doctor.readOwnedService(catalog, 'hospital-a'), /provider registration/);
        const assigned = lifecycle.registerHealthcareService({ store: f.store, callerOrganization: secondProvider, request: existingRegistration(catalog) }).instance;
        command(assigned.id, 'activate');
        await assert.rejects(doctor.readOwnedService(assigned.id, 'hospital-a'), /owned/);
        assert.equal((await doctor.readOwnedService(assigned.id, 'hospital-b')).available, true);
        command(id, 'disable'); assert.equal((await doctor.readOwnedService(id, 'hospital-a')).available, false);
        assert.equal((await doctor.readOwnedService(assigned.id, 'hospital-b')).available, true);
        command(id, 'enable'); assert.equal((await doctor.readOwnedService(id, 'hospital-a')).available, true);
        command(catalog, 'disable'); assert.equal((await doctor.readOwnedService(id, 'hospital-a')).available, false);
        command(catalog, 'enable'); assert.equal((await doctor.readOwnedService(id, 'hospital-a')).available, true);
        const requests = f.requests.length;
        await assert.rejects(doctor.searchServices('untrusted'), /diagnostic identity/);
        await assert.rejects(doctor.searchServices('untrusted-assertion'), /diagnostic identity/);
        assert.equal(f.requests.length, requests);
        const reads = f.requests.filter(item => item.method === 'GET' && item.path.endsWith('/HealthcareService/' + id));
        assert.ok(reads.length > 3); assert.ok(reads.every(item => item.organization === firstProvider.id && item.certificate));
    } finally { doctor.resetCache(); await f.close(); }
});

test('PCM Services return navigation keeps the exact provider and remote browser listener/prefix', async () => {
    const f = await startServicesFixture();
    try {
        f.config.publicBaseUrls.spClient = 'http://localhost:13100/doctor';
        for (const [role, identity] of [['serviceProvider', 'hospital-a'], ['hospitalBServiceProvider', 'hospital-b']]) {
            const response = await new Promise((resolve, reject) => {
                require('node:http').get(f.base + '/admin/services?providerRole=' + role, { headers: { 'x-admin-password': f.password, Host: 'remote.example:14100' } }, res => {
                    let html = ''; res.on('data', chunk => { html += chunk; }); res.on('end', () => resolve({ status: res.statusCode, html }));
                }).on('error', reject);
            });
            assert.equal(response.status, 200);
            assert.match(response.html, new RegExp('href="http://remote.example:13100/doctor/\\?identity=' + identity + '"[^>]*>Doctor</a>'));
            assert.match(response.html, new RegExp('href="/admin/services\\?view=assignments&amp;providerRole=' + role + '"'));
            assert.match(response.html, new RegExp('name="providerRole" value="' + role + '"'));
            // Navigation context never turns the global inventory into an acting-provider selection.
            assert.match(response.html, /data-service-create[^>]*data-provider-role="serviceProvider"/);

        }
        // Force an actual protected catalog continuation without assigning any new provider.
        const catalog = f.store.getAll('HealthcareService').find(resource => lifecycle.serviceKind(resource) === 'catalog');
        for (let index = 0; index < 26; index++) f.store.add({ ...structuredClone(catalog), id: `return-context-page-${index}` });
        const firstPage = await fetch(f.base + '/admin/services?view=catalog&providerRole=hospitalBServiceProvider', { headers: { 'x-admin-password': f.password } });
        const firstHtml = await firstPage.text(), next = /data-catalog-next[^>]*href="([^"]+)"/.exec(firstHtml)?.[1];
        assert.ok(next); assert.match(next, /providerRole=hospitalBServiceProvider/);
        const nextPage = await fetch(new URL(next.replaceAll('&amp;', '&'), f.base), { headers: { 'x-admin-password': f.password } });
        assert.equal(nextPage.status, 200);
        assert.match(await nextPage.text(), /href="[^"]+\?identity=hospital-b" data-services-fragment="doctor-return"[^>]*>Doctor<\/a>/);
        for (const query of ['providerRole=foreign', 'providerRole=serviceProvider&providerRole=hospitalBServiceProvider']) {
            const result = await fetch(f.base + '/admin/services?' + query, { headers: { 'x-admin-password': f.password } });
            assert.equal(result.status, 400);
        }
    } finally { await f.close(); }
});
