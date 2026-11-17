'use strict';

/** Real registered Data Source OAuth calls; no credential response double or retained runtime. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), https = require('node:https');

test('real bearer credentials honor test lifetimes across all presets without changing old expiry or first-use state', async t => {
    const fixture = await require('../../../test-support/consent-snapshot-fixture').startSnapshotFixture();
    t.after(fixture.close);
    const { PcmIntrospectionClient } = require('../src/pcm-introspection-client');
    const { PRESETS, presetSimulationDefaults } = require('../../shared/conformance-policy');
    const { environmentEndpoints } = require('../../shared/pcm-environment');
    const source = fixture.config.healthOrganizations[0], logical = environmentEndpoints('test');
    const cert = name => fs.readFileSync(path.join(process.env.CERTS_DIR, name));
    const usageDirectory = path.join(process.env.STATE_DIR, 'first-use-windows');
    const usage = () => fs.existsSync(usageDirectory) ? fs.readdirSync(usageDirectory).sort().map(name => [name, fs.readFileSync(path.join(usageDirectory, name), 'utf8')]) : [];
    const originalUsage = usage();
    for (const preset of PRESETS) {
        const selected = require('../../../test-support/team-config').buildTeamConfig({ contract: { environment: 'test' } }, preset);
        Object.assign(fixture.config, { contract: selected.contract, conformance: selected.conformance,
            security: selected.security, securitySimulation: selected.securitySimulation, legacyDataSource: selected.legacyDataSource });
        let earlier;
        for (const duration of [86400, 17, 1]) {
            fixture.config.security.pcmApi.accessTokenExpiresInSeconds = duration;
            fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(fixture.config));
            const client = new PcmIntrospectionClient({ http: require('axios'),
                httpsAgent: new https.Agent({ ca: cert('rootCA.crt'), cert: cert(source.certificates.gatewayMtlsCert), key: cert(source.certificates.gatewayMtlsKey) }),
                clientId: source.clientId, privateKey: cert(source.certificates.gatewayAssertionKey),
                tokenEndpoint: logical.tokenEndpoint, introspectionEndpoint: logical.introspectionEndpoint,
                tokenRequestEndpoint: `${fixture.config.internalBaseUrls.pcmAuth}/token`, introspectionRequestEndpoint: `${fixture.config.internalBaseUrls.pcmAuth}/introspect`,
                expectedIssuer: logical.oauthBase, expectedAudience: source.endpoint, hoId: source.id,
                authMode: 'bearer', controls: presetSimulationDefaults(preset), timeout: 10000 });
            const start = Date.now(), credential = await client.getIntrospectionToken();
            const stored = require('../../pcm-core/src/store').tokenStore.peek(credential);
            assert.equal(stored.kind, 'introspection'); assert.equal(stored.exp - stored.iat, duration, `${preset}/${duration}`);
            assert.ok(client.credentialCache.entry.expiresAtMs >= start + duration * 1000);
            assert.deepEqual(await client.introspect(`unknown-subject-${preset}-${duration}`), { active: false });
            if (earlier) {
                assert.deepEqual(require('../../pcm-core/src/store').tokenStore.peek(earlier.token), earlier.record, 'shorter future lifetime leaves old credential unchanged');
                assert.equal((await client.requestIntrospection('still-unknown', earlier.token)).data.active, false, 'old valid credential still authenticates');
            } else earlier = { token: credential, record: structuredClone(stored) };
            assert.deepEqual(usage(), originalUsage, 'caller authentication and unknown subjects do not start clinical first-use clocks');
            client.httpsAgent.destroy();
        }
    }
});
