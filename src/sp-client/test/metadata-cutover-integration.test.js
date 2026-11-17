'use strict';

/** Ordinary public Doctor and protected PCM consumers after a measured metadata checkpoint restart. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('../../shared/migration-hash');

test('all presets: migrated Doctor/public APIs, Consents, Services, Admin and optional status keep exact authority', async () => {
    const previousPassword = process.env.TEAM_ADMIN_PASSWORD; process.env.TEAM_ADMIN_PASSWORD = 'owned-metadata07-test';
    const f = await require('../../../test-support/consent-snapshot-fixture').startSnapshotFixture();
    const client = require('../src/client');
    try {
        const consent = require('../../pcm-core/src/fhir/consent-lifecycle').approveConsent({ store: f.store, consent: f.create(), scopeChoice: 'service-provided',
            sourceOrganizationIds: f.config.healthOrganizations.map(source => source.dataSourceOrganization.id) });
        const cutover = require('../../../test-support/public-metadata-cutover').cutoverFixture({ store: f.store });
        assert.equal(cutover.status, 'applied');
        const decision = f.store.privateRecords.approvals.getDecision(consent.id), reports = [];
        const usage = () => require('../../shared/public-metadata-compatibility').inventory(path.join(process.env.STATE_DIR, 'first-use-windows'));
        for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
            const selected = require('../../../test-support/team-config').buildTeamConfig({}, preset);
            for (const key of ['conformance', 'security', 'securitySimulation', 'legacyDataSource']) f.config[key] = selected[key];
            fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(f.config));
            require('../../pcm-core/src/migration-checkpoint').recordConfig(process.env.STATE_DIR, process.env.TEAM_CONFIG_PATH);
            client.resetCache();
            const audience = f.config.healthOrganizations[0].endpoint;
            const acquired = await client._test.getToken(audience, 'hospital-a', consent.id, 'patient/Condition.s', undefined, {});
            assert.equal(acquired.grant.scope, decision.snapshot.scope);
            const beforeUsage = usage(), count = f.requests.length;
            const status = await client.checkTokenStatus(consent.id, audience, 'hospital-a', acquired.grant.generation);
            assert.equal(status.state, preset === 'strict' ? 'disabled' : 'active');
            assert.deepEqual(usage(), beforeUsage);
            assert.deepEqual(f.requests.slice(count).map(item => item.path), preset === 'strict' ? [] : ['/api/fhir-service/r4/introspect']);
            const views = [];
            for (const route of ['/ui', '/admin/services', '/admin?section=maintenance']) {
                const response = await fetch(f.base + route, { headers: { 'x-admin-password': 'owned-metadata07-test', Accept: 'text/html' } }); const html = await response.text();
                assert.equal(response.status, 200, route + html.slice(0, 100));
                if (route === '/admin?section=maintenance') assert.match(html, /Observed migration: applied/);
                views.push({ route, status: response.status });
            }
            const observedConsent = await client.checkConsentStatus(consent.id, 'hospital-a');
            assert.ok(observedConsent);
            const { discoveredEndpoint, discoveredEndpoints, ...publicConsent } = observedConsent;
            require('../../pcm-core/src/public-fhir').assertPublic(publicConsent);
            assert.deepEqual(f.store.privateRecords.approvals.getDecision(consent.id), decision);
            const beforeCapabilityConfig = fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8');
            const configured = await fetch(f.base + '/admin/config/own-token-introspection', { method: 'POST',
                headers: { 'x-admin-password': 'owned-metadata07-test', 'content-type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ allowServiceProviderOwnTokenIntrospection: preset === 'strict' }) });
            assert.equal(configured.status, preset === 'strict' ? 400 : 200);
            if (preset === 'strict') assert.equal(fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8'), beforeCapabilityConfig);
            const afterConfigCount = f.requests.length;
            assert.equal((await client.checkTokenStatus(consent.id, audience, 'hospital-a', acquired.grant.generation)).state, 'disabled');
            assert.equal(f.requests.length, afterConfigCount); assert.equal(acquired.isInvalidated(), false);
            assert.deepEqual(usage(), beforeUsage);
            reports.push({ preset, scope: acquired.grant.scope, status: status.state, views, capabilityOperationStatus: configured.status,
                disabledStatus: 'disabled-with-valid-grant-and-no-probe', firstUseHash: hash(usage()), authority: hash(decision) });
        }
        if (process.env.PCM_METADATA_MATRIX_OUTPUT) fs.writeFileSync(process.env.PCM_METADATA_MATRIX_OUTPUT, JSON.stringify({ schema: 'pcm-metadata-consumer-matrix/1', cutover, reports, requests: f.requests }, null, 2));
    } finally { client.resetCache(); await f.close(); if (previousPassword === undefined) delete process.env.TEAM_ADMIN_PASSWORD; else process.env.TEAM_ADMIN_PASSWORD = previousPassword; }
});
