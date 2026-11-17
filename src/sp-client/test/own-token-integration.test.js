'use strict';

/** Actual Doctor credentials and public PCM HTTPS calls exercise the optional backend branch. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');

test('Doctor checks its real PCM token without source calls or usage/token changes; config refusal preserves its grant', async () => {
    const f = await require('../../../test-support/consent-snapshot-fixture').startSnapshotFixture();
    const client = require('../src/client');
    try {
        const consent = require('../../pcm-core/src/fhir/consent-lifecycle').approveConsent({ store: f.store, consent: f.create(), scopeChoice: 'service-provided',
            sourceOrganizationIds: f.config.healthOrganizations.map(source => source.dataSourceOrganization.id) });
        const audience = f.config.healthOrganizations[0].endpoint;
        const acquired = await client._test.getToken(audience, 'hospital-a', consent.id, 'patient/Observation.s', undefined, {});
        const tokenStore = require('../../pcm-core/src/store').tokenStore;
        const retained = JSON.stringify(tokenStore.peek(acquired.token));
        const stateDirectory = process.env.STATE_DIR;
        const usageDirectory = path.join(stateDirectory, 'first-use-windows');
        const usage = () => fs.existsSync(usageDirectory) ? fs.readdirSync(usageDirectory).map(name => [name, fs.readFileSync(path.join(usageDirectory, name), 'utf8')]) : [];
        const before = usage(), count = f.requests.length;
        const active = await client.checkTokenStatus(consent.id, audience, 'hospital-a', acquired.grant.generation);
        assert.equal(active.state, 'active', JSON.stringify(active));
        assert.equal(active.scope, acquired.grant.scope);
        assert.ok(active.checkedAt); assert.deepEqual(usage(), before);
        assert.equal(JSON.stringify(tokenStore.peek(acquired.token)), retained);
        assert.deepEqual(f.requests.slice(count).map(value => value.path), ['/api/fhir-service/r4/introspect']);
        const disabled = await fetch(f.base + '/admin/config/own-token-introspection', { method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ allowServiceProviderOwnTokenIntrospection: false }) });
        assert.equal(disabled.status, 200);
        const disabledCount = f.requests.length;
        assert.equal((await client.checkTokenStatus(consent.id, audience, 'hospital-a', acquired.grant.generation)).state, 'disabled');
        assert.equal(f.requests.length, disabledCount);
        assert.equal(acquired.isInvalidated(), false);
        assert.equal(JSON.stringify(tokenStore.peek(acquired.token)), retained);
        assert.deepEqual(usage(), before);
    } finally { client.resetCache(); await f.close(); }
});
