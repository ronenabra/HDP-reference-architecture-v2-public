'use strict';

/** Compare direct-native fixtures to real issuance, rather than a duplicated expected string. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { grantHarness } = require('../../test-support/pcm-042-grants');
const { presenceScope, discoveryScope, authenticationScope } = require('../../clinical-data/test/pcm-042-native-fixture');

for (const preset of ['strict', 'connectathon-mtls', 'connectathon-balanced', 'connectathon-easy']) {
    test(`${preset} native workflow fixtures match issued authority`, () => {
        const fixture = grantHarness(preset);
        try {
            for (const [scenario, expected] of [
                ['presence-check', presenceScope([fixture.patient])],
                ['patient-authentication', authenticationScope],
                ['dependent-discovery', discoveryScope(fixture.strongPatient)]
            ]) {
                const issued = fixture.issue(scenario);
                assert.equal(issued.status, 200, JSON.stringify(issued));
                assert.equal(issued.body.scope, expected);
            }
            const malformed = presenceScope([fixture.patient]).replace('identifier=', 'name=');
            assert.notEqual(malformed, fixture.issue('presence-check').body.scope);
        } finally { fixture.close(); }
    });
}
