'use strict';
/** Retired approval exceptions cannot promise bypass through the Consent dashboard. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { relaxedConsentSources } = require('../../shared/consent-presentation');
const { buildTeamConfig } = require('../../../test-support/team-config');
const { PRESETS, REQUIRED_AUTHORIZATION_CONTROLS, buildEffectivePolicy } = require('../../shared/conformance-policy');

test('every preset requires clinical authority and reports no approval-check exception', () => {
    for (const preset of PRESETS) {
        const config = buildTeamConfig({}, preset);
        const policy = buildEffectivePolicy(config, {});
        assert.deepEqual(relaxedConsentSources(policy), []);
        for (const name of REQUIRED_AUTHORIZATION_CONTROLS) assert.equal(policy.simulation.controls[name], true, `${preset}: ${name}`);
    }
});

test('retired global/source exceptions reject and cannot manufacture a dashboard bypass notice', async () => {
    for (const preset of PRESETS) for (const value of [false, true]) {
        for (const perSource of [false, true]) {
            const config = buildTeamConfig({}, preset);
            if (perSource) config.securitySimulation.perSource['ho-a'] = { consentState: value };
            else config.securitySimulation.global.consentState = value;
            const before = structuredClone(config);
            assert.throws(() => buildEffectivePolicy(config, {}), perSource
                ? /invalid per-source security simulation control/ : /unknown security simulation control/);
            assert.deepEqual(config, before);
        }
    }
    // Old view models are inert diagnostics, never effective configuration or permission.
    for (const [global, perSource] of [
        [false, {}],
        [true, { 'ho-a': { consentState: false }, 'ho-b': { consentState: true } }],
        [false, { 'ho-a': { consentState: false }, 'ho-b': { consentState: true } }],
        [true, { 'ho-b': { consentState: true } }],
        [true, { '<source>': { consentState: false } }]
    ]) {
        const policy = { simulation: { controls: { consentState: global }, perSource } };
        const before = structuredClone(policy);
        const relaxedSources = relaxedConsentSources(policy);
        assert.deepEqual(relaxedSources, []);
        assert.deepEqual(policy, before);
        const html = await ejs.renderFile(path.join(__dirname, '../src/views/dashboard.ejs'), {
            workflowUrl: 'https://pcm.test/sandbox/authentication', teamId: 'banner-test', publicBaseUrls: { pcmUi: '', spClient: '' }, consents: [], relaxedSources
        });
        assert.equal(html.includes('Sandbox mode: data access may bypass consent approval'), false);
        assert.ok(!html.includes('global default'));
        assert.ok(!html.includes('for ho-b'));
        assert.doesNotMatch(html, /<source>|&lt;source&gt;/);
    }
    assert.deepEqual(relaxedConsentSources({}), []);
});
