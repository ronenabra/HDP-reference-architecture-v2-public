'use strict';

/** Doctor assertions and source TLS select the same configured roles for both providers. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { installTestRuntime } = require('../../../test-support/team-config');
const config = installTestRuntime();
fs.cpSync(require('../../../test-support/certificates').certificates(), process.env.CERTS_DIR, { recursive: true });
const client = require('../src/client');
const jwt = require('jsonwebtoken');
const { certificateConfirmation, jwkThumbprint } = require('../../shared/assertion-keys');

for (const [identity, role, algorithm] of [['hospital-a', 'serviceProvider', 'ES256'], ['hospital-b', 'hospitalBServiceProvider', 'ES384']]) {
    test(`${identity} correlates management, data and SMART assertions with actual source TLS roles`, () => {
        const expected = fs.readFileSync(path.join(process.env.CERTS_DIR, config.certificateRoles[role].mtls.cert));
        const transport = client._test.dataSourceTransportOptions(identity, config.healthOrganizations[0].endpoint).httpsAgent;
        assert.deepEqual(transport.options.cert, expected); transport.destroy();
        const assertions = [];
        for (let i = 0; i < 3; i++) {
            const token = client._test.generateClientAssertion(identity, null, `${config.contract.operational.oauthBase}/token`);
            const decoded = jwt.decode(token, { complete: true }); assertions.push(decoded.payload);
            assert.equal(decoded.header.alg, algorithm);
            assert.equal(decoded.header.kid, jwkThumbprint(fs.readFileSync(path.join(process.env.CERTS_DIR, config.certificateRoles[role].assertion.cert))));
            assert.deepEqual(decoded.payload.cnf, certificateConfirmation(expected));
            assert.equal(decoded.payload.iss, config.organizations[role].clientId);
            assert.equal(decoded.payload.sub, decoded.payload.iss);
            assert.equal(decoded.payload.exp - decoded.payload.iat, 300);
        }
        assert.equal(new Set(assertions.map(a => a.jti)).size, 3);
    });
}
