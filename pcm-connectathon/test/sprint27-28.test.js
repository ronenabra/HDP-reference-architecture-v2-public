'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const root = path.resolve(__dirname, '..', '..');
const { validateTeamConfig } = require('../../src/shared/team-config-validator');
const { REQUIRED_AUTHORIZATION_CONTROLS, SIMULATION_CONTROLS } = require('../../src/shared/conformance-policy');
const { classifyDiagnosticError, diagnoseDataSource } = require('../../src/pcm-core/src/data-source-readiness');
const { composeUpArgs } = require('../scripts/lifecycle');
const { REQUIRED_GATES } = require('../scripts/verify-local');
const { COMPOSE_SERVICE_BY_IMAGE, LEGACY_IMAGE_SERVICES, configuredImages, descriptorFromTeam, firstImageIdentity, validateDescriptor } = require('../scripts/export-sut-descriptor');
const { secretScan } = require('../ui/run-playwright');

const example = () => JSON.parse(fs.readFileSync(path.join(root, 'pcm-connectathon/example-team-config.json'), 'utf8'));

test('canonical team validator accepts all presets and rejects structural, path, port, and ceiling defects', () => {
    const easy = example();
    assert.strictEqual(validateTeamConfig(easy).valid, true);
    for (const [preset, values] of Object.entries({
        'connectathon-balanced': ['connectathon', 'tls', 'tls', 300, 'https'],
        'connectathon-mtls': ['connectathon', 'mtls', 'mtls', 300, 'https'],
        strict: ['strict', 'mtls', 'mtls', 30, 'https']
    })) {
        const config = example();
        config.conformance.preset = preset;
        if (preset === 'strict') { config.securitySimulation.perSource = {}; config.legacyDataSource.enabled = false; }
        config.conformance.mode = values[0];
        config.security.pcmApi.clientAuth = values[1];
        config.security.dataSourceGateway.clientAuth = values[2];
        config.security.pcmApi.accessTokenExpiresInSeconds = values[3];
        config.security.dsGatewayToFhirServer.protocol = values[4];
        config.security.serviceProviderToDataSource.verifyServerCertificate = preset !== 'connectathon-easy';
        config.security.dsGatewayToFhirServer.verifyServerCertificate = preset !== 'connectathon-easy';
        config.security.dsFhirServer.enforceMappedPatients = true;
        config.securitySimulation.global = Object.fromEntries(
            require('../../src/shared/conformance-policy').SIMULATION_CONTROLS.map(name => [name, true])
        );
        if (preset === 'connectathon-balanced') config.securitySimulation.global.publicClientMtls = false;
        config.conformance.compatibilityAdapters = preset === 'strict' ? [] : config.conformance.compatibilityAdapters;
        assert.strictEqual(validateTeamConfig(config).valid, true, preset);
    }
    const bad = example();
    bad.unknown = true;
    bad.runtime.stateDir = '../escape';
    bad.security.dsFhirServer.enforceMappedPatients = false;
    bad.publicBaseUrls.pcmUi = bad.publicBaseUrls.spClient;
    const errors = validateTeamConfig(bad, { requireRelativeRuntimePaths: true }).errors.join('; ');
    assert.match(errors, /unknown is not allowed/);
    assert.match(errors, /runtime\.stateDir must be a safe relative path/);
    assert.match(errors, /enforceMappedPatients must be true/);
    assert.match(errors, /ports must be unique/);
});

test('config5 requires Patient context in every preset and rejects retired global/source controls', () => {
    const { buildTeamConfig } = require('../../test-support/team-config');
    for (const preset of ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']) {
        const config = buildTeamConfig({}, preset);
        assert.strictEqual(config.configVersion, 'pcm-team-config/5');
        assert.strictEqual(config.security.dsFhirServer.enforceMappedPatients, true);
        assert.strictEqual(validateTeamConfig(config).valid, true, preset);
        const missingContext = structuredClone(config);
        missingContext.security.dsFhirServer.enforceMappedPatients = false;
        assert.match(validateTeamConfig(missingContext).errors.join('; '), /enforceMappedPatients must be true/);
        assert.strictEqual(config.security.dsFhirServer.enforceMappedPatients, true, 'the accepted fixture stays unchanged');
        for (const name of REQUIRED_AUTHORIZATION_CONTROLS) for (const value of [false, true]) {
            for (const perSource of [false, true]) {
                const retired = structuredClone(config);
                if (perSource) retired.securitySimulation.perSource['ho-a'] = { [name]: value };
                else retired.securitySimulation.global[name] = value;
                const result = validateTeamConfig(retired);
                assert.strictEqual(result.valid, false, `${preset}: ${name}=${value}, perSource=${perSource}`);
                assert.match(result.errors.join('; '), perSource
                    ? /invalid per-source security simulation control/
                    : /unknown security simulation control/);
            }
        }
        if (preset !== 'strict') {
            // Turning off the six remaining simulations never changes mandatory Patient context.
            const simulated = structuredClone(config);
            simulated.securitySimulation.global = Object.fromEntries(SIMULATION_CONTROLS.map(name => [name, false]));
            simulated.security.serviceProviderToDataSource.verifyServerCertificate = false;
            simulated.security.dsGatewayToFhirServer.verifyServerCertificate = false;
            assert.strictEqual(validateTeamConfig(simulated).valid, true, preset);
            assert.strictEqual(simulated.security.dsFhirServer.enforceMappedPatients, true);
        }
    }
});

test('no-build compose construction is no-pull and explicit pull is separate', () => {
    const noBuild = composeUpArgs('/tmp/team.env', { noBuild: true });
    assert.deepStrictEqual(noBuild.slice(-7), ['--no-build', '--pull', 'never', '-d', '--wait', '--wait-timeout', '600']);
    const pull = composeUpArgs('/tmp/team.env', { pull: true, foreground: true });
    assert.ok(pull.includes('--build'));
    assert.deepStrictEqual(pull.slice(-2), ['--pull', 'always']);
    assert.throws(() => composeUpArgs('/tmp/team.env', { pull: true, noBuild: true }), /cannot be combined/);
});

test('SUT descriptor separates sandbox/app/HAPI versions and release-grade identities', () => {
    const images = configuredImages('9.8.7');
    assert.match(images['pcm-core'], /:9\.8\.7$/);
    assert.strictEqual(images['ho-a-hapi'], `pcm-ho-fhir:${process.env.PCM_HAPI_VERSION || require('../../src/shared/pcm-contract').PCM_IG.version}`);
    assert.strictEqual(COMPOSE_SERVICE_BY_IMAGE['legacy-ds-adapter'], 'ds-auth-adapter');
    assert.strictEqual(COMPOSE_SERVICE_BY_IMAGE['legacy-ds-fhir'], 'ds-fhir-server');
    assert.strictEqual(COMPOSE_SERVICE_BY_IMAGE['legacy-ds-gateway'], 'ds-gateway');
    assert.strictEqual(firstImageIdentity(`warning\nsha256:${'c'.repeat(64)}\n`), `sha256:${'c'.repeat(64)}`);
    assert.strictEqual(firstImageIdentity(`${'d'.repeat(64)}\n`), `sha256:${'d'.repeat(64)}`);
    const descriptor = descriptorFromTeam(example(), 'a'.repeat(40), { version: '9.8.7' });
    assert.throws(() => validateDescriptor(descriptor, { releaseGrade: true }), /immutable is required/);
    for (const value of Object.values(descriptor.runtime.images)) value.immutable = `sha256:${'b'.repeat(64)}`;
    assert.doesNotThrow(() => validateDescriptor(descriptor, { releaseGrade: true }));
    descriptor.runtime.images[LEGACY_IMAGE_SERVICES[0]].immutable = null;
    assert.throws(
        () => validateDescriptor(descriptor, { releaseGrade: true }),
        new RegExp(`runtime\\.images\\.${LEGACY_IMAGE_SERVICES[0]}\\.immutable is required`)
    );
});

test('custom source diagnostic classifies controlled failures and redacts identities', async () => {
    assert.strictEqual(classifyDiagnosticError(Object.assign(new Error('missing'), { code: 'ENOTFOUND' })), 'dns');
    assert.strictEqual(classifyDiagnosticError(new Error('self signed certificate')), 'tls-trust');
    assert.strictEqual(classifyDiagnosticError(new Error('certificate required')), 'missing-client-certificate');
    const result = await diagnoseDataSource({ id: 'source-a', endpoint: 'https://source.invalid/fhir', clientId: 'client-a' }, {
        lookup: async () => { throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); },
        timeoutMs: 100
    });
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.phases[0].classification, 'dns');
    assert.doesNotMatch(JSON.stringify(result), /patient|tokenValue|privateKey/i);
    const success = await diagnoseDataSource({ id: 'source-b', endpoint: 'https://source.example/fhir', clientId: 'client-b' }, {
        actions: Object.fromEntries(['dns', 'connectivity-tls', 'metadata', 'unauthenticated-access', 'token-acquisition', 'introspection', 'fhir'].map(phase => [phase, async () => ({ endpoint: 'https://source.example/fhir', httpStatus: 200 })]))
    });
    assert.strictEqual(success.status, 'pass');
    assert.strictEqual(success.phases.length, 7);
});

test('custom source diagnostic bounds and classifies every controlled participant failure', async () => {
    const phases = ['dns', 'connectivity-tls', 'metadata', 'unauthenticated-access', 'token-acquisition', 'introspection', 'fhir'];
    const cases = [
        ['dns', Object.assign(new Error('unresolvable'), { code: 'ENOTFOUND' }), 'dns'],
        ['connectivity-tls', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), 'connectivity'],
        ['connectivity-tls', new Error('self signed certificate'), 'tls-trust'],
        ['connectivity-tls', new Error('client certificate required'), 'missing-client-certificate'],
        ['metadata', new Error('malformed metadata JSON'), 'malformed-response'],
        ['token-acquisition', new Error('wrong resource indicator audience'), 'token-resource-audience'],
        ['introspection', new Error('inactive introspection result'), 'introspection-rejected'],
        ['fhir', new Error('FHIR 503'), 'fhir-error']
    ];
    for (const [failedPhase, error, classification] of cases) {
        const actions = Object.fromEntries(phases.map(phase => [phase, async () => {
            if (phase === failedPhase) throw error;
            return { endpoint: 'https://source.example/fhir', httpStatus: 200 };
        }]));
        const diagnostic = await diagnoseDataSource({ id: `source-${classification}`, endpoint: 'https://source.example/fhir', clientId: 'client-a' }, { actions, timeoutMs: 100 });
        assert.strictEqual(diagnostic.status, 'fail', failedPhase);
        assert.strictEqual(diagnostic.phases.at(-1).classification, classification, failedPhase);
    }

    const timeout = await diagnoseDataSource({ id: 'source-timeout', endpoint: 'https://source.example/fhir', clientId: 'client-a' }, {
        actions: { dns: async () => new Promise(() => {}) },
        timeoutMs: 100
    });
    assert.strictEqual(timeout.phases[0].classification, 'timeout');
    assert.ok(timeout.durationMilliseconds < 1000);

    const [first, second] = await Promise.all(['one', 'two'].map(id => diagnoseDataSource({ id, endpoint: `https://${id}.example/fhir`, clientId: `client-${id}` }, {
        actions: Object.fromEntries(phases.map(phase => [phase, async () => ({ endpoint: `https://${id}.example/fhir`, httpStatus: 200 })]))
    })));
    assert.notStrictEqual(first.correlationId, second.correlationId);
    assert.notStrictEqual(first.sourceId, second.sourceId);
});

test('fast gate cannot omit required Maven, schema, OpenAPI, Compose, or documentation checks', () => {
    const ids = REQUIRED_GATES.map(gate => gate.id);
    for (const required of ['javascript', 'hapi-maven', 'pcm-ig-drift', 'team-schema', 'descriptor-schema', 'openapi', 'compose', 'references']) assert.ok(ids.includes(required));
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/connectathon-verification.yml'), 'utf8');
    assert.match(workflow, /npm run verify:fast/);
    assert.match(workflow, /schedule:/);
    assert.match(workflow, /npm run verify:full/);
    assert.match(workflow, /upload-artifact@v4/);
});

test('browser harness is pinned and artifact secret scan fails closed', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'pcm-connectathon/ui/Dockerfile'), 'utf8');
    assert.match(dockerfile, /playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e/);
    assert.match(dockerfile, /COPY playwright\.config\.js/);
    assert.match(dockerfile, /COPY tests \.\/tests/);
    assert.match(dockerfile, /--no-install/);
    const runner = fs.readFileSync(path.join(root, 'pcm-connectathon/ui/run-playwright.js'), 'utf8');
    assert.doesNotMatch(runner, /:\/suite:ro/);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-ui-artifacts-'));
    try {
        fs.writeFileSync(path.join(directory, 'safe.txt'), 'no secrets\n');
        assert.doesNotThrow(() => secretScan(directory));
        fs.writeFileSync(path.join(directory, 'leak.txt'), 'adminPassword=secret\n');
        assert.throws(() => secretScan(directory), /prohibited secret material/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('maintained UI pages use local assets, document language, and responsive metadata', () => {
    for (const file of ['src/pcm-core/src/views/consent.ejs', 'src/pcm-core/src/views/dashboard.ejs', 'src/pcm-core/src/views/logs.ejs', 'src/sp-client/src/views/index.ejs', 'src/sp-client/src/views/logs.ejs', 'src/sp-client/src/views/manage.ejs']) {
        const html = fs.readFileSync(path.join(root, file), 'utf8');
        assert.doesNotMatch(html, /cdn\.jsdelivr\.net/, file);
        assert.match(html, /<html lang="en">/i, file);
        assert.match(html, /name="viewport"/i, file);
        assert.match(html, /\/assets\/connectathon\.css/, file);
    }
    const route = fs.readFileSync(path.join(root, 'src/pcm-core/src/routes/ui.js'), 'utf8');
    assert.doesNotMatch(route, /method="get" action="\/admin"/i);
    assert.match(route, /method="post" action="\$\{escapeHtml\(basePath\)\}\/admin\/login"/i);
    assert.doesNotMatch(route, /req\.query\.adminPassword/);
    const adminViews = fs.readdirSync(path.join(root, 'src/pcm-core/src/views/admin')).filter(name => name.endsWith('.ejs'))
        .map(name => fs.readFileSync(path.join(root, 'src/pcm-core/src/views/admin', name), 'utf8')).join('\n');
    assert.match(adminViews, /data-confirm=/);
    assert.match(adminViews, /table-responsive[^>]*role="region"[^>]*tabindex="0"/);
    const dashboard = fs.readFileSync(path.join(root, 'src/pcm-core/src/views/dashboard.ejs'), 'utf8');
    assert.match(dashboard, /table-responsive[^>]*role="region"[^>]*tabindex="0"/);
    for (const file of ['src/pcm-core/src/views/logs.ejs', 'src/sp-client/src/views/logs.ejs']) {
        const logView = fs.readFileSync(path.join(root, file), 'utf8');
        if (file.includes('pcm-core')) {
            assert.match(logView, /\.command-bar[\s\S]*?flex-wrap: wrap/, file);
            assert.match(logView, /id="workbench"[^>]*hidden/, 'inspector starts collapsed');
            assert.match(logView, /\.workbench \{ position: fixed; inset: var\(--pcm-explain-row-height, 48px\) 0 0 auto/, 'narrow side drawer reserves the persistent Explain row');
            assert.match(logView, /\.log-list table \{ min-width: 780px; table-layout: fixed/, 'configurable columns retain readable widths with horizontal scrolling');
            assert.match(logView, /<td data-column="message" class="message-cell"/, 'required message remains addressable in every column layout');
        } else {
            assert.match(logView, /\.header > \.d-flex[\s\S]*?flex-wrap: wrap/, file);
        }
        assert.match(logView, /\.log-list[\s\S]*?overflow: auto/, file);
        assert.match(logView, /class="[^"]*\blog-details-pane\b[^"]*"[^>]*role="region"[^>]*tabindex="0"/, file);
    }
});
