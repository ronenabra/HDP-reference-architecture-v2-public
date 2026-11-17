'use strict';

/** Exercise submitted Admin form values through the real persistence handler. */
const { installTestRuntime, buildTeamConfig } = require('../../../test-support/team-config');
installTestRuntime();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { SIMULATION_CONTROLS, presetSourceDefaults, presetSimulationDefaults, buildEffectivePolicy } = require('../../shared/conformance-policy');
const router = require('../src/routes/ui');
const handler = router.stack.find(layer => layer.route?.path === '/admin/config/simulation').route.stack[0].handle;

/** Invoke a form request and capture the handler's status and JSON response. */
function submit(body, route = '/admin/config/simulation') {
    const result = { status: 200 };
    const req = { body, accepts: () => 'json', get: () => 'application/json', headers: { accept: 'application/json' } };
    const res = {
        status(code) { result.status = code; return this; },
        json(value) { result.body = value; return this; },
        format(types) { types.json(); }
    };
    const selected = route === '/admin/config/simulation' ? handler
        : router.stack.find(layer => layer.route?.path === route).route.stack[0].handle;
    selected(req, res);
    return result;
}

/** Seed an independent saved policy for each case. */
function seed(preset = 'connectathon-balanced') {
    fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(buildTeamConfig({}, preset)));
}

for (const preset of ['connectathon-easy', 'connectathon-mtls']) {
    test(`complete form saves ${preset} defaults and clears stale source overrides`, () => {
        seed();
        const body = { preset, completeControls: 'true', perSourceJson: JSON.stringify(presetSourceDefaults(preset)) };
        if (preset === 'connectathon-mtls') for (const name of SIMULATION_CONTROLS) body[`control.${name}`] = 'true';
        assert.equal(submit(body).status, 200);
        const saved = JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));
        assert.ok(Object.values(saved.securitySimulation.global).every(value => value === (preset === 'connectathon-mtls')));
        assert.deepEqual(saved.securitySimulation.perSource, presetSourceDefaults(preset));
    });
}

test('all unchecked is explicit even in a normally enabled balanced preset', () => {
    seed();
    assert.equal(submit({ preset: 'connectathon-balanced', completeControls: 'true', perSourceJson: '{}' }).status, 200);
    const saved = JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));
    assert.ok(Object.values(saved.securitySimulation.global).every(value => value === false));
    assert.equal(saved.security.serviceProviderToDataSource.verifyServerCertificate, false);
});

test('API omitted controls still select complete defaults', () => {
    seed();
    assert.equal(submit({ preset: 'connectathon-mtls' }).status, 200);
    assert.ok(Object.values(JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH)).securitySimulation.global).every(Boolean));
});

for (const body of [
    { completeControls: 'true', 'control.smartScopes': 'true', perSourceJson: '{}' },
    { perSourceJson: '{broken' },
    { 'control.unknown': 'true' },
    { controls: { unknown: true } }
]) {
    test(`invalid form preserves exact saved policy: ${JSON.stringify(body)}`, () => {
        seed();
        const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8');
        assert.equal(submit({ preset: 'connectathon-balanced', ...body }).status, 400);
        assert.equal(fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8'), before);
    });
}

test('strict disabled form controls preserve fixed defaults', () => {
    seed('strict');
    assert.equal(submit({ preset: 'strict', completeControls: 'true', perSourceJson: '{}' }).status, 200);
    assert.ok(Object.values(JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH)).securitySimulation.global).every(Boolean));
});


/** Build the complete browser checkbox payload without emitting unchecked fields. */
function formControls(preset) {
    return Object.fromEntries(Object.entries(presetSimulationDefaults(preset))
        .filter(([, enabled]) => enabled).map(([name]) => [`control.${name}`, 'true']));
}

test('supported source override survives complete form save and leaves other sources unchanged', () => {
    seed();
    const overrides = { ...presetSourceDefaults('connectathon-balanced'), 'ho-a': { serverCertificateVerification: false } };
    assert.equal(submit({ preset: 'connectathon-balanced', completeControls: 'true',
        perSourceJson: JSON.stringify(overrides), ...formControls('connectathon-balanced') }).status, 200);
    const saved = JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH));
    assert.deepEqual(saved.securitySimulation.perSource, overrides);
    const policy = buildEffectivePolicy(saved, {});
    assert.equal(policy.simulation.perSource['ho-a'].serverCertificateVerification, false);
    assert.equal(policy.simulation.controls.serverCertificateVerification, true);
    assert.equal((policy.simulation.perSource['ho-b'] || policy.simulation.controls).serverCertificateVerification, true);
});

test('explicit strict form control changes reject without changing saved policy', () => {
    seed('strict');
    const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8');
    assert.equal(submit({ preset: 'strict', completeControls: 'true', perSourceJson: '{}',
        'control.publicClientMtls': 'false' }).status, 400);
    assert.equal(fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8'), before);
});

for (const edit of [
    { pcmApiClientAuth: 'mtls' },
    { accessTokenExpiresInSeconds: '86401' },
    { dsGatewayToFhirServerProtocol: 'http' },
    { dsFhirServerEnforceMappedPatients: 'false' },
    { spDsVerifyServerCertificate: 'false' },
    { dsGatewayToFhirServerVerifyServerCertificate: 'false' },
    { allowAnyTokenResource: 'true' }
]) {
    test(`unsupported security edit preserves exact file and revision: ${JSON.stringify(edit)}`, () => {
        seed();
        const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8');
        const body = { pcmApiClientAuth: 'tls', dataSourceGatewayClientAuth: 'tls',
            dsGatewayToFhirServerProtocol: 'https', accessTokenExpiresInSeconds: '300',
            spDsVerifyServerCertificate: 'true', dsGatewayToFhirServerVerifyServerCertificate: 'true',
            dsFhirServerEnforceMappedPatients: 'true', allowAnyTokenResource: 'false', ...edit };
        assert.equal(submit(body, '/admin/config/security').status, 400);
        assert.equal(fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8'), before);
    });
}

for (const [preset, controls, expected] of [
    ['connectathon-mtls', presetSimulationDefaults('connectathon-easy'), 'tls'],
    ['connectathon-easy', { ...presetSimulationDefaults('connectathon-easy'), publicClientMtls: true }, 'mtls']
]) {
    test(`gateway display follows effective publicClientMtls for customized ${preset}`, () => {
        const config = buildTeamConfig({ securitySimulation: { global: controls, perSource: {} } }, preset);
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH, JSON.stringify(config));
        const html = router._test.renderAdminHtml({ query: { section: 'security' } });
        assert.match(html, new RegExp(`Global source gateway authentication</dt><dd>${expected === 'mtls' ? 'mTLS' : 'TLS'}`));
        assert.match(html, /Derived from Require public client mTLS/);
    });
}

for (const value of [true, false]) {
    test(`retired clinical override rejects ${value} without changing saved state`, () => {
        seed('connectathon-balanced'); const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
        assert.equal(submit({ preset: 'connectathon-balanced', grantFullClinicalAccess: value }).status, 400);
        assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), before);
        const html = router._test.renderAdminHtml({ query: { section: 'security' } });
        assert.doesNotMatch(html, /id="grant-full-clinical-access"/);
        assert.match(html, /Every preset enforces the exact approved scope/);
    });
}
for (const [preset, value] of [['strict', true], ['connectathon-balanced', 'garbage'], ['connectathon-balanced', { enabled: true }]]) {
    test(`forged ${preset} grant control is atomic: ${JSON.stringify(value)}`, () => {
        seed(preset); const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
        assert.equal(submit({ preset, grantFullClinicalAccess: value }).status, 400);
        assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), before);
    });
}

for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
    test(`${preset}: forged retired controls globally and per source preserve saved bytes`, () => {
        const { REQUIRED_AUTHORIZATION_CONTROLS } = require('../../shared/conformance-policy');
        for (const key of REQUIRED_AUTHORIZATION_CONTROLS) for (const value of [true, false]) {
            seed(preset); const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
            for (const forged of [{ controls: { [key]: value } }, { [`control.${key}`]: String(value) }, { perSource: { 'ho-a': { [key]: value } } }]) {
                assert.equal(submit({ preset, ...forged }).status, 400);
                assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), before);
            }
        }
    });
}


test('ENFORCE browser form exposes only authentication controls with strict locking', () => {
    for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
        seed(preset);
        const html = router._test.renderAdminHtml({ query: { section: 'security' } });
        const inputs = [...html.matchAll(/<input[^>]*id="simulation-([^" ]+)"[^>]*>/g)];
        assert.deepEqual(inputs.map(row => row[1]).sort(), [...SIMULATION_CONTROLS].sort());
        assert.doesNotMatch(html, /id="simulation-(oauthBearer|smartScopes)"/);
        for (const row of inputs) {
            assert.equal(/\sdisabled(?:\s|>)/.test(row[0]), preset === 'strict');
            assert.equal(/\schecked(?:\s|>)/.test(row[0]), presetSimulationDefaults(preset)[row[1]]);
        }
        assert.match(html, /Only the transport and authentication checks below are configurable/);
        if (preset === 'strict') {
            const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
            assert.equal(submit({ preset, controls: { publicClientMtls: false } }).status, 400);
            assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), before);
        }
    }
});

test('ENFORCE browser retired history/paging and forged scope commands reject atomically', () => {
    for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
        seed(preset); const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH);
        const retired = submit({ preset, controls: { history: false, paging: true } });
        assert.equal(retired.status, 400);
        assert.match(retired.body.error, /securitySimulation\.global\.(?:history|paging).*not allowed|unknown security simulation control/i);
        assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), before);
        const forged = submit({ preset, completeControls: 'true', 'control.smartScopes': 'true', perSourceJson: '{}' });
        assert.equal(forged.status, 400); assert.equal(forged.body.error, 'Unknown security simulation control.');
        assert.deepEqual(fs.readFileSync(process.env.TEAM_CONFIG_PATH), before);
    }
});

test('ENFORCE browser per-source mTLS and all-off authentication preserve required clinical controls', () => {
    const { REQUIRED_AUTHORIZATION_CONTROLS } = require('../../shared/conformance-policy');
    seed();
    const global = { ...presetSimulationDefaults('connectathon-easy'), publicClientMtls: true };
    const perSource = { 'ho-a': { publicClientMtls: false } };
    assert.equal(submit({ preset: 'connectathon-easy', controls: global, perSource }).status, 200);
    const saved = JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH)), policy = buildEffectivePolicy(saved, {});
    assert.deepEqual(saved.securitySimulation, { global, perSource, awsCredentialIsolation: true });
    assert.equal(policy.simulation.perSource['ho-a'].publicClientMtls, false);
    assert.equal((policy.simulation.perSource['ho-b'] || policy.simulation.controls).publicClientMtls, true);
    for (const name of REQUIRED_AUTHORIZATION_CONTROLS) {
        assert.equal(policy.simulation.controls[name], true);
        assert.equal(policy.simulation.perSource['ho-a'][name], true);
    }
    assert.equal(submit({ preset: 'connectathon-balanced', completeControls: 'true', perSourceJson: '{}' }).status, 200);
    const off = JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH)), offPolicy = buildEffectivePolicy(off, {});
    assert.ok(Object.values(off.securitySimulation.global).every(value => value === false));
    assert.deepEqual(off.securitySimulation.perSource, {});
    for (const name of REQUIRED_AUTHORIZATION_CONTROLS) assert.equal(offPolicy.simulation.controls[name], true);
});

for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
    test(`own-token capability is validated with default and override in ${preset}`, () => {
        seed(preset);
        const route = '/admin/config/own-token-introspection';
        const before = fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8');
        assert.equal(submit({ allowServiceProviderOwnTokenIntrospection: 'yes' }, route).status, 400);
        assert.equal(fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8'), before);
        const enabled = submit({ allowServiceProviderOwnTokenIntrospection: 'true' }, route);
        assert.equal(enabled.status, preset === 'strict' ? 400 : 200);
        if (preset === 'strict') assert.equal(fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8'), before);
        const disabled = submit({ allowServiceProviderOwnTokenIntrospection: 'false' }, route);
        assert.equal(disabled.status, 200); assert.equal(disabled.body.capability.enabled, false);
        const defaults = submit({ allowServiceProviderOwnTokenIntrospection: 'default' }, route);
        assert.equal(defaults.status, 200); assert.equal(defaults.body.capability.enabled, preset !== 'strict');
        assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(process.env.TEAM_CONFIG_PATH)).security.pcmApi, 'allowServiceProviderOwnTokenIntrospection'), false);
    });
}
