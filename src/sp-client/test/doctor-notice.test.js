'use strict';
/** Notices disclose shared effective controls without reinterpreting clinical approval. */
const test = require('node:test'), assert = require('node:assert/strict');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { buildEffectivePolicy, SIMULATION_CONTROLS, sourceSimulationControls } = require('../../shared/conformance-policy');
const { doctorNotice } = require('../src/doctor-notice');
test('four presets disclose actual defaults and source overrides without approval bypass', () => {
    for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
        const config = buildTeamConfig({}, preset), policy = buildEffectivePolicy(config), before = JSON.stringify(policy);
        const notice = doctorNotice(config, policy);
        for (const source of config.healthOrganizations) {
            const controls = sourceSimulationControls(policy, config, { resource: source.endpoint });
            assert.equal(notice.sources.find(row => row.name === (source.name || source.id)).relaxed.length, SIMULATION_CONTROLS.filter(key => controls[key] === false).length);
        }
        assert.equal(JSON.stringify(policy), before);
        assert.doesNotMatch(JSON.stringify(notice), /approval bypass|all clinical access|consentState/);
    }
    const config = buildTeamConfig({}, 'connectathon-mtls'), policy = structuredClone(buildEffectivePolicy(config));
    policy.simulation.perSource['ho-a'] = { ...policy.simulation.controls, serverCertificateVerification: false };
    config.healthOrganizations[0].name = '<Long source name>';
    const notice = doctorNotice(config, policy); assert.equal(notice.affected[0].name, '<Long source name>');
    assert.deepEqual(notice.affected[0].relaxed, ['server certificate verification']);
    assert.match(doctorNotice({ healthOrganizations: [] }, policy).message, /No enabled/);
});
