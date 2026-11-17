'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

const {
    AUTHORIZATION_CEILING,
    COMPATIBILITY_ADAPTER_CATALOG,
    PRESETS,
    POLICY_SHAPE,
    POLICY_VERSION,
    REQUIRED_AUTHORIZATION_CONTROLS,
    SIMULATION_CONTROLS,
    applyModeWarningHeaders,
    assertCompletePolicy,
    buildEffectivePolicy,
    effectivePolicyReport,
    logPolicyBanner
} = require('../../src/shared/conformance-policy');
const { buildTeamConfig } = require('../../test-support/team-config');

const repoRoot = path.resolve(__dirname, '..', '..');
const example = () => JSON.parse(fs.readFileSync(path.join(repoRoot, 'pcm-connectathon', 'example-team-config.json'), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));

function strictConfig() {
    const config = example();
    config.contract.environment = 'production';
    config.contract.operational = require('../../src/shared/pcm-contract').buildOperationalEndpoints('https://pcm2m.health.gov.il/api/fhir-service/r4');
    config.conformance.mode = 'strict';
    config.conformance.preset = 'strict';
    config.conformance.compatibilityAdapters = [];
    config.securitySimulation.global = Object.fromEntries(
        require('../../src/shared/conformance-policy').SIMULATION_CONTROLS.map(name => [name, true])
    );
    config.securitySimulation.perSource = {};
    config.legacyDataSource.enabled = false;
    config.security.pcmApi = { clientAuth: 'mtls', allowAnyTokenResource: false, accessTokenExpiresInSeconds: 30 };
    config.security.dataSourceGateway.clientAuth = 'mtls';
    config.security.serviceProviderToDataSource.verifyServerCertificate = true;
    config.security.dsGatewayToFhirServer.protocol = 'https';
    config.security.dsGatewayToFhirServer.verifyServerCertificate = true;
    config.security.dsFhirServer.enforceMappedPatients = true;
    return config;
}

test('all four presets enumerate every versioned policy field and require clinical authority', () => {
    for (const preset of PRESETS) {
        const policy = buildEffectivePolicy(buildTeamConfig({}, preset), {});
        assert.equal(policy.version, POLICY_VERSION);
        assert.equal(assertCompletePolicy(policy), true);
        assert.equal(Object.isFrozen(policy), true);
        for (const [section, fields] of Object.entries(POLICY_SHAPE)) {
            assert.deepEqual(fields.filter(field => !Object.hasOwn(policy[section], field)), []);
        }
        assert.deepEqual(policy.authorizationCeiling, AUTHORIZATION_CEILING, preset);
        for (const name of REQUIRED_AUTHORIZATION_CONTROLS) {
            assert.equal(policy.simulation.controls[name], true, `${preset}: ${name}`);
        }
        assert.equal(policy.deferred.advancedScopeExpressions, 'fail-closed-sprint-25-deferred');
    }
});

test('strict startup rejects every permissive or legacy override', () => {
    const mutations = [
        config => { config.security.pcmApi.clientAuth = 'tls'; },
        config => { config.security.pcmApi.allowAnyTokenResource = true; },
        config => { config.security.pcmApi.accessTokenExpiresInSeconds = 31; },
        config => { config.security.dataSourceGateway.clientAuth = 'tls'; },
        config => { config.security.serviceProviderToDataSource.verifyServerCertificate = false; },
        config => { config.security.dsGatewayToFhirServer.protocol = 'http'; },
        config => { config.security.dsGatewayToFhirServer.verifyServerCertificate = false; },
        config => { config.security.dsFhirServer.enforceMappedPatients = false; },
        config => { config.conformance.compatibilityAdapters = ['legacy-jose-kid']; }
    ];
    for (const mutate of mutations) {
        const config = strictConfig();
        mutate(config);
        assert.throws(() => buildEffectivePolicy(config, {}), /Strict conformance policy rejected|accessTokenExpiresInSeconds/);
    }
    assert.throws(
        () => buildEffectivePolicy(strictConfig(), { PCM_ALLOW_ANY_TOKEN_RESOURCE: 'true' }),
        /prohibited in strict mode/
    );
    assert.throws(
        () => buildEffectivePolicy({}, { PCM_CONFORMANCE_MODE: 'strict' }),
        /certificateRoles|conformance\.mode/
    );
});

test('mode selection is closed and configuration/environment ambiguity fails', () => {
    const config = example();
    assert.throws(() => buildEffectivePolicy(config, { PCM_CONFORMANCE_MODE: 'unknown' }), /contradicts|must be one of/);
    assert.throws(() => buildEffectivePolicy(config, { PCM_CONFORMANCE_MODE: 'strict' }), /contradicts/);
    config.conformance.mode = 'unknown';
    assert.throws(() => buildEffectivePolicy(config, {}), /must be one of/);
});

test('malformed and authorization-bypass configuration fails in both modes', () => {
    for (const base of [strictConfig(), example()]) {
        const malformed = clone(base);
        malformed.security.dataSourceGateway.clientAuth = 'anything';
        assert.throws(() => buildEffectivePolicy(malformed, {}), /must be one of/);

        const bypass = clone(base);
        bypass.security.pcmApi.allowAnyTokenResource = true;
        assert.throws(() => buildEffectivePolicy(bypass, {}), /authorization ceiling/);

        const unbounded = clone(base);
        unbounded.security.pcmApi.accessTokenExpiresInSeconds = 999999;
        assert.throws(() => buildEffectivePolicy(unbounded, {}), /1 through (30|86400)/);
    }
});

test('connectathon accepts only named adapters and reports warnings without sensitive values', () => {
    const config = example();
    const policy = buildEffectivePolicy(config, {});
    assert.deepEqual(policy.compatibility.enabledAdapters, [
        'legacy-jose-kid',
        'legacy-introspection-token-audience'
    ]);
    assert.equal(policy.assertion.forbidKeySelectionHeaders, false);
    assert.equal(policy.assertion.exactAudience, false);
    assert.ok(policy.compatibility.warnings.every(message => !/access_token|patient|assertion=/i.test(message)));
    assert.deepEqual(Object.keys(COMPATIBILITY_ADAPTER_CATALOG).sort(), [
        'legacy-es384-assertion',
        'legacy-introspection-token-audience',
        'legacy-jose-kid',
        'legacy-management-scope-cruds',
        'legacy-organization-url-client-id',
        'legacy-rs256-assertion'
    ]);

    config.conformance.compatibilityAdapters.push('accept-anything');
    assert.throws(() => buildEffectivePolicy(config, {}), /Unknown connectathon compatibility adapter/);
});

test('connectathon warnings are observable while strict responses remain unchanged', () => {
    const capture = policy => {
        const headers = {};
        applyModeWarningHeaders({ setHeader: (name, value) => { headers[name] = value; } }, policy);
        return headers;
    };
    assert.deepEqual(capture(buildEffectivePolicy(strictConfig(), {})), {});
    const connectathonHeaders = capture(buildEffectivePolicy(example(), {}));
    assert.equal(connectathonHeaders['X-PCM-Conformance-Mode'], 'connectathon');
    assert.match(connectathonHeaders.Warning, /not strict conformance evidence/);

    const events = [];
    logPolicyBanner({ info: (message, details) => events.push({ message, details }) }, 'test-service', buildEffectivePolicy(example(), {}));
    assert.equal(events[0].details.type, 'CONFORMANCE_MODE');
    assert.deepEqual(events[0].details.policy, effectivePolicyReport(buildEffectivePolicy(example(), {})));
});

test('scope and context ceiling is invariant across every preset', () => {
    const expected = {
        organizationIsolation: 'required', healthOrganizationAudience: 'exact',
        consentBinding: 'required', patientIsolation: 'required', informationBucket: 'required',
        historyAccess: 'explicit-only', sensitivityLabels: 'required',
        returnedResourceAuthorization: 'required', binaryAttachmentAccess: 'deny-unsupported',
        presenceIsolation: 'required', advancedScopeExpressions: 'deny-unsupported'
    };
    for (const preset of PRESETS) {
        assert.deepEqual(buildEffectivePolicy(buildTeamConfig({}, preset), {}).authorizationCeiling, expected, preset);
    }
});

test('every preset rejects retired permission controls globally and per source without stripping them', () => {
    for (const preset of PRESETS) {
        for (const name of REQUIRED_AUTHORIZATION_CONTROLS) for (const value of [false, true]) {
            for (const perSource of [false, true]) {
                const config = buildTeamConfig({}, preset);
                if (perSource) config.securitySimulation.perSource['ho-a'] = { [name]: value };
                else config.securitySimulation.global[name] = value;
                const before = JSON.stringify(config);
                assert.throws(() => buildEffectivePolicy(config, {}),
                    perSource ? /invalid per-source security simulation control/ : /unknown security simulation control/,
                    `${preset}: ${name}=${value}, perSource=${perSource}`);
                assert.equal(JSON.stringify(config), before, 'rejection must not silently remove a constraint');
            }
        }
        for (const value of [false, true]) {
            const config = buildTeamConfig({ sandbox: { grantFullClinicalAccess: value } }, preset);
            assert.throws(() => buildEffectivePolicy(config, {}), /grantFullClinicalAccess is retired/);
        }
    }
});

test('transport and assertion simulations remain separate from required clinical permissions', () => {
    for (const preset of PRESETS) {
        const defaults = buildEffectivePolicy(buildTeamConfig({}, preset), {});
        assert.equal(defaults.simulation.controls.publicClientMtls, ['connectathon-mtls', 'strict'].includes(preset));
        assert.equal(defaults.simulation.controls.serverCertificateVerification, preset !== 'connectathon-easy');
        for (const name of SIMULATION_CONTROLS) for (const value of [false, true]) {
            const config = buildTeamConfig({}, preset);
            config.securitySimulation.global[name] = value;
            if (preset === 'strict' && !value) {
                assert.throws(() => buildEffectivePolicy(config, {}), /strict mode security simulation controls are fixed/);
                continue;
            }
            const policy = buildEffectivePolicy(config, {});
            assert.equal(policy.simulation.controls[name], value, `${preset}: ${name}`);
            assert.deepEqual(policy.authorizationCeiling, AUTHORIZATION_CEILING);
            for (const required of REQUIRED_AUTHORIZATION_CONTROLS) assert.equal(policy.simulation.controls[required], true);
            assert.equal(policy.transport.dataSourceGateway.clientAuth, policy.simulation.controls.publicClientMtls ? 'mtls' : 'tls');
            assert.equal(policy.transport.dataSourceGatewayToFhir.verifyServerCertificate, policy.simulation.controls.serverCertificateVerification);
        }
    }
});

test('runtime service feature code contains no direct strict/connectathon branch', () => {
    const serviceRoots = ['src/pcm-core/src', 'src/sp-client/src', 'src/ds-auth-adapter/src', 'src/ds-fhir-server/src'];
    const allowedConfigFiles = new Set([
        'src/pcm-core/src/team-config.js',
        'src/sp-client/src/team-config.js'
    ]);
    const violations = [];
    for (const root of serviceRoots) {
        const pending = [path.join(repoRoot, root)];
        while (pending.length) {
            const current = pending.pop();
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) pending.push(fullPath);
                else if (entry.name.endsWith('.js')) {
                    const relative = path.relative(repoRoot, fullPath);
                    if (allowedConfigFiles.has(relative)) continue;
                    const source = fs.readFileSync(fullPath, 'utf8');
                    if (/PCM_CONFORMANCE_MODE|\.mode\s*===?\s*['"](?:strict|connectathon)['"]/.test(source)) violations.push(relative);
                }
            }
        }
    }
    assert.deepEqual(violations, []);
});

test('normative OpenAPI contains no connectathon compatibility branch', () => {
    for (const fileName of ['openapi.yaml', 'openapi-fhir.yaml', 'openapi-oauth.yaml']) {
        const source = fs.readFileSync(path.join(repoRoot, 'docs', fileName), 'utf8');
        assert.doesNotMatch(source, /connectathon|legacy-jose-kid|legacy-management-scope-cruds/i, fileName);
    }
});

test('clean local profile generation produces complete validated certificate roles', () => {
    const teamsRoot = fs.mkdtempSync(path.join(process.env.TEST_TMPDIR || '/tmp', 'pcm-profile-teams-'));
    try {
        for (const [mode, portIndex] of [['connectathon', '70'], ['strict', '71']]) {
            const teamId = `policy-${mode}`;
            const create = spawnSync('node', [
                'pcm-connectathon/scripts/create-local-team.js',
                '--team-id', teamId,
                '--teams-root', teamsRoot,
                '--port-index', portIndex,
                '--mode', mode
            ], { cwd: repoRoot, encoding: 'utf8' });
            assert.equal(create.status, 0, create.stderr || create.stdout);
            const configPath = path.join(teamsRoot, teamId, 'team-config.json');
            const validate = spawnSync('node', [
                'pcm-connectathon/scripts/validate-team-config.js',
                '--config', configPath
            ], { cwd: repoRoot, encoding: 'utf8' });
            assert.equal(validate.status, 0, validate.stderr || validate.stdout);
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            assert.equal(config.conformance.mode, mode);
            for (const participant of Object.values(config.certificateRoles)) {
                for (const role of Object.values(participant)) {
                    assert.equal(fs.existsSync(path.join(teamsRoot, teamId, 'certs', role.cert)), true, role.cert);
                    assert.equal(fs.existsSync(path.join(teamsRoot, teamId, 'certs', role.key)), true, role.key);
                }
            }
        }
    } finally {
        fs.rmSync(teamsRoot, { recursive: true, force: true });
    }
});


test('private source simulation requires explicit connectathon and cannot override strict environment', () => {
    const { sandboxSourceChangesAllowed } = require('../../src/shared/conformance-policy');
    for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls']) {
        const config = require('../../test-support/team-config').buildTeamConfig({}, preset);
        assert.equal(sandboxSourceChangesAllowed(config, {}), true);
        assert.equal(sandboxSourceChangesAllowed(config, { PCM_CONFORMANCE_MODE: 'strict' }), false);
    }
    assert.equal(sandboxSourceChangesAllowed(require('../../test-support/team-config').buildTeamConfig({}, 'strict'), {}), false);
    assert.equal(sandboxSourceChangesAllowed({}, {}), false);
});

test('own-token capability accepts booleans only, defaults outside Strict and rejects Strict exceptions', () => {
    const capability = require('../../src/shared/conformance-policy').serviceProviderOwnTokenIntrospection;
    const validate = require('../../src/shared/team-config-validator').assertValidTeamConfig;
    for (const preset of PRESETS) {
        const config = buildTeamConfig({}, preset);
        assert.equal(capability(config).enabled, preset !== 'strict');
        assert.equal(capability(config).default, preset !== 'strict');
        for (const value of ['false', 1, null]) {
            config.security.pcmApi.allowServiceProviderOwnTokenIntrospection = value;
            assert.throws(() => buildEffectivePolicy(config, {}), /allowServiceProviderOwnTokenIntrospection.*boolean/);
            assert.throws(() => validate(config, { env: {} }), /allowServiceProviderOwnTokenIntrospection/);
        }
        config.security.pcmApi.allowServiceProviderOwnTokenIntrospection = true;
        if (preset === 'strict') {
            assert.throws(() => buildEffectivePolicy(config, {}), /allowServiceProviderOwnTokenIntrospection.*Strict/);
            assert.throws(() => validate(config, { env: {} }), /allowServiceProviderOwnTokenIntrospection/);
        } else { buildEffectivePolicy(config, {}); validate(config, { env: {} }); }
        config.security.pcmApi.allowServiceProviderOwnTokenIntrospection = false;
        validate(config, { env: {} }); assert.equal(capability(config).enabled, false);
    }
});
