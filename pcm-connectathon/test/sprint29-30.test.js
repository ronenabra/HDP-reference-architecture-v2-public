'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const { activeServices } = require('../scripts/lifecycle');
const { configuredLogComponents } = require('../../src/pcm-core/src/log-ordering');
const { sanitizeLogDetails, sanitizeLogMessage } = require('../../src/shared/log-policy');
const { assertSafeOutboundUrl, guardedFetch, parseOutboundUrl } = require('../../src/shared/outbound-destination');
const { buildEffectivePolicy, PRESETS, SIMULATION_CONTROLS } = require('../../src/shared/conformance-policy');
const { buildBootstrapPlan, configureClinicalBootstrap } = require('../scripts/bootstrap-local-team');

const example = () => JSON.parse(fs.readFileSync(path.join(root, 'pcm-connectathon/example-team-config.json'), 'utf8'));

test('Sprint 30 exposes exactly four truthful presets and an immutable AWS invariant', () => {
    assert.deepEqual(PRESETS, ['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']);
    const policy = buildEffectivePolicy(example(), {});
    assert.equal(policy.simulation.preset, 'connectathon-easy');
    assert.deepEqual(Object.keys(policy.simulation.controls), [...SIMULATION_CONTROLS, ...require('../../src/shared/conformance-policy').REQUIRED_AUTHORIZATION_CONTROLS]);
    for (const control of require('../../src/shared/conformance-policy').REQUIRED_AUTHORIZATION_CONTROLS) assert.equal(policy.simulation.controls[control], true);
    for (const control of require('../../src/shared/conformance-policy').SIMULATION_CONTROLS) assert.equal(policy.simulation.controls[control], false);
    assert.equal(policy.invariants.awsCredentialIsolation, 'always-on');
    assert.match(policy.resultLabel, /NON-CONFORMANT/);
    const invalid = example();
    invalid.securitySimulation.perSource['not-a-source'] = { oauthBearer: false };
    assert.throws(() => buildEffectivePolicy(invalid, {}), /unknown per-source security simulation source/);
});

test('full-fidelity logs preserve non-AWS values and narrowly block AWS credential responses', () => {
    const ordinary = {
        authorization: 'Bearer non-aws-token', cookie: 'session=complete', password: 'local-secret',
        privateKey: '-----BEGIN PRIVATE KEY-----\nnon-aws\n-----END PRIVATE KEY-----',
        query: '?patient=000000018&code=HIV', body: { resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Patient' } }] }
    };
    assert.deepEqual(sanitizeLogDetails(ordinary), ordinary);
    const aws = sanitizeLogDetails({ AccessKeyId: 'AKIAIOSFODNN7EXAMPLE', SecretAccessKey: 'secret', Token: 'session-token', Expiration: 'later' });
    assert.equal(aws.AccessKeyId, '[AWS_CREDENTIAL_BLOCKED]');
    assert.equal(aws.SecretAccessKey, '[AWS_CREDENTIAL_BLOCKED]');
    assert.equal(aws.Token, '[AWS_CREDENTIAL_BLOCKED]');
    assert.doesNotMatch(sanitizeLogMessage('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260901/us-east-1/sts/aws4_request, SignedHeaders=host, Signature=abc123'), /AKIA/);
});

test('shared outbound guard blocks metadata forms, credential environment hosts, redirects, and DNS results', async () => {
    for (const url of [
        'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
        'http://169.254.170.2/v2/credentials',
        'http://[fd00:ec2::254]/latest/meta-data/',
        'http://2852039166/latest/meta-data/',
        'http://user:password@example.org/'
    ]) assert.throws(() => parseOutboundUrl(url), /prohibited/);
    await assert.rejects(assertSafeOutboundUrl('https://participant.example/fhir', {
        lookup: async () => [{ address: '169.254.169.254', family: 4 }]
    }), /credential address/);
    let calls = 0;
    await assert.rejects(guardedFetch('https://participant.example/fhir', {}, {
        lookup: async () => [{ address: '192.0.2.20', family: 4 }],
        fetchImpl: async () => {
            calls += 1;
            return { status: 302, headers: { get: () => 'http://169.254.169.254/latest/meta-data/' } };
        }
    }), /prohibited/);
    assert.equal(calls, 1);
});

test('managed HO log streams and legacy lifecycle are dynamic while strict excludes compatibility services', () => {
    const config = example();
    assert.deepEqual(configuredLogComponents(config).filter(item => item.role === 'gateway').map(item => item.dir), [
        'ho-a-gateway', 'ho-b-gateway', 'ho-c-gateway', 'ds-gateway'
    ]);
    assert.ok(activeServices(config).includes('ds-fhir-server'));
    config.legacyDataSource.enabled = false;
    assert.ok(!activeServices(config).includes('ds-fhir-server'));
    assert.ok(activeServices(config).includes('ho-a-hapi'));
});

test('gateway sends authorized FHIR traffic through the full-fidelity adapter relay', () => {
    const gateway = fs.readFileSync(path.join(root, 'pcm-connectathon/nginx/nginx.conf.template'), 'utf8');
    assert.match(gateway, /proxy_pass http:\/\/ds_auth_adapter\/fhir-proxy/);
    assert.match(gateway, /X-PCM-Upstream-Base/);
});

test('Admin keeps explicit simulation defaults and unified log filters', () => {
    const admin = fs.readFileSync(path.join(root, 'src/pcm-core/src/routes/ui.js'), 'utf8');
    const core = fs.readFileSync(path.join(root, 'src/pcm-core/src/index.js'), 'utf8');
    assert.match(admin, /const controls = !hasExplicitControls/);
    for (const filter of ['healthOrganizationId', 'role', 'level', 'method', 'correlationId', 'path', 'status']) assert.match(core, new RegExp(filter));
});

test('disposable bootstrap requires and records an explicit bundle-to-HAPI mapping', () => {
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pcm-bootstrap-map-'));
    const configPath = path.join(directory, 'team-config.json');
    try {
        fs.copyFileSync(path.join(root, 'pcm-connectathon/example-team-config.json'), configPath);
        assert.throws(() => configureClinicalBootstrap(configPath, {
            'bundle-root': '/producer', 'ho-a-bundle': 'hmo.source.transaction.json', 'ho-a-source': 'hmo'
        }), /ho-b-bundle/);
        const producer = path.join(root, 'clinical-data/ci');
        const mappings = Object.fromEntries(['ho-a', 'ho-b', 'ho-c'].flatMap(id =>
            [[`${id}-bundle`, `${id}.source.transaction.json`], [`${id}-source`, id]]));
        const before = fs.readFileSync(configPath);
        assert.throws(() => configureClinicalBootstrap(configPath, {
            'bundle-root': producer, ...mappings, 'ho-c-source': 'wrong-source'
        }), /source mismatch/);
        assert.deepEqual(fs.readFileSync(configPath), before);
        assert.equal(fs.existsSync(path.join(directory, 'bundles')), false, 'all sources validate before projection writes');
        const configured = configureClinicalBootstrap(configPath, { 'bundle-root': producer, ...mappings });
        assert.deepEqual(configured.healthOrganizations.map(ho => ho.clinicalData.bootstrap),
            ['ho-a', 'ho-b', 'ho-c'].map(id => ({ policy: 'if-empty', bundleReference: `${id}.source.transaction.json`, expectedSource: id })));
        for (const id of ['ho-a', 'ho-b', 'ho-c']) {
            assert.deepEqual(fs.readFileSync(path.join(directory, 'bundles', `${id}.source.transaction.json`)),
                fs.readFileSync(path.join(producer, `${id}.source.transaction.json`)), 'Admin sanity sees exact selected bytes in its mounted runtime directory');
        }
        assert.ok(configured.healthOrganizations.every(ho => ho.clinicalData.bundleRoot === '/runtime/bundles'));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('bootstrap force replaces an existing team while preserving volumes by default', () => {
    const plan = buildBootstrapPlan({
        teamId: 'team-a', teamsRoot: '/tmp/connectathon-teams', portIndex: 0,
        preset: 'connectathon-easy', force: true, existingTeam: true
    });
    assert.deepEqual(plan.stopArgs, [
        'pcm-connectathon/scripts/stop-local-team.js',
        '--team-id', 'team-a', '--teams-root', '/tmp/connectathon-teams'
    ]);
    assert.ok(plan.createArgs.includes('--force'));
    assert.ok(!plan.cleanupCommand.includes('--volumes'));
});

test('bootstrap volume removal is explicit and requires force', () => {
    assert.throws(() => buildBootstrapPlan({
        teamId: 'team-a', teamsRoot: '/tmp/connectathon-teams', portIndex: 0,
        preset: 'connectathon-easy', volumes: true
    }), /requires --force/);
    const plan = buildBootstrapPlan({
        teamId: 'team-a', teamsRoot: '/tmp/connectathon-teams', portIndex: 0,
        preset: 'connectathon-easy', force: true, volumes: true, existingTeam: true
    });
    assert.ok(plan.stopArgs.includes('--volumes'));
    assert.ok(plan.cleanupCommand.includes('--volumes'));
});

test('0.4.0 protocol and browser workflows remain visible with full diagnostic context', () => {
    const { classifyRoute } = require('../../src/shared/log-policy');
    for (const url of ['/api/fhir-service/r4/token', '/api/fhir-service/r4/Contract?_count=1', '/sandbox/authentication/verify', '/RelatedPerson?identifier=example']) {
        const policy = classifyRoute(url);
        assert.equal(policy.category, 'system');
        assert.equal(policy.visibility, 'default');
        assert.equal(policy.emitMiddleware, true);
    }
    const context = { scenario: 'patient-authentication', authorization_details: [{ fhirContext: [{ identifier: { system: 'test', value: '000000018' } }] }], otp: '123456', contact: '+972500000000' };
    assert.deepEqual(sanitizeLogDetails(context), context);
});

test('explicit logical environment reaches disposable team generation independently of preset', () => {
    for (const environment of ['production', 'test']) {
        const plan = buildBootstrapPlan({ teamId: 'qualified', teamsRoot: '/tmp/qualified-teams', portIndex: 7, preset: 'strict', environment });
        assert.equal(plan.createArgs[plan.createArgs.indexOf('--environment') + 1], environment);
        assert.equal(plan.createArgs[plan.createArgs.indexOf('--preset') + 1], 'strict');
    }
});
