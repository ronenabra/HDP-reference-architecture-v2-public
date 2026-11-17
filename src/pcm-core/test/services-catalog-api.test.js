'use strict';
/** Actual catalog renderer consumes protected versioned pages without ordinary provider discovery. */
const test = require('node:test'), assert = require('node:assert/strict');
const { startServicesFixture } = require('../../../test-support/services-fixture');
const model = require('../src/services-admin-model');

test('catalog default is provider-independent; exact later-page target and stale revision remain honest', { timeout: 60000 }, async () => {
    const f = await startServicesFixture('connectathon-mtls', { browserBase: '/catalog-owned' });
    try {
        const definition = require('../src/service-templates').loadTemplates()[0].definition;
        for (let index = 0; index < 27; index++) model.createCatalog({ store: f.store, config: f.config,
            definition: { ...definition, name: `Catalog page ${index}` }, expectedRevision: f.store.privateState.revision, operator: 'unit', audit() {} });
        const all = model.catalogInventory({ store: f.store, config: f.config, query: { limit: '50' } });
        const target = all.items.at(-1), requests = f.requests.length;
        const get = query => fetch(f.base + '/admin/services' + query, { headers: { 'x-admin-password': f.password } });
        const invalid = await get('?view=unrecognized'); assert.equal(invalid.status, 400); assert.match(await invalid.text(), /Choose Service catalog or Provider assignments/);
        let response = await get(''); assert.equal(response.status, 200);
        let html = await response.text(); assert.match(html, /data-catalog-next/); assert.match(html, /Other pages may contain additional definitions/);
        assert.equal(f.requests.length, requests, 'catalog rendering neither obtains a provider token nor performs ordinary discovery');
        response = await get(`?view=catalog&target=${target.id}`); html = await response.text();
        assert.equal(response.status, 200); assert.ok(html.includes(`data-catalog-id="${target.id}"`));
        assert.equal(f.requests.length, requests);
        const stale = all.revision; model.createCatalog({ store: f.store, config: f.config, definition: { ...definition, name: 'Changes page revision' }, expectedRevision: stale, operator: 'unit', audit() {} });
        response = await get(`?view=catalog&offset=25&revision=${stale}`); assert.equal(response.status, 409); html = await response.text();
        assert.match(html, /Inventory changed/); assert.doesNotMatch(html, /data-catalog-id=/);
        f.config.conformance.preset = 'strict'; response = await get(''); assert.equal(response.status, 200); html = await response.text();
        assert.match(html, /Private sandbox actions are unavailable in strict mode/); assert.equal(f.requests.length, requests);
        assert.ok(f.events.some(event => event.operation === 'read-admin-catalog' && event.visibility === 'diagnostic'));
    } finally { await f.close(); }
});
