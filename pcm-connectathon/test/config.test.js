const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const { composeHostPath, sharedModuleRoot } = require('../scripts/lib');

test('operator shared module root resolves in the checkout', () => {
    assert.strictEqual(sharedModuleRoot(), path.join(repoRoot, 'src', 'shared'));
    assert.strictEqual(require(path.join(sharedModuleRoot(), 'conformance-policy')).POLICY_VERSION, 'pcm-sandbox-policy/4');
});

test('generated Compose host paths are explicit binds inside and outside the repository', () => {
    assert.strictEqual(
        composeHostPath(repoRoot, path.join(repoRoot, 'tmp', 'release-work', 'run', 'teams', 'team-a')),
        './tmp/release-work/run/teams/team-a'
    );
    assert.strictEqual(composeHostPath(repoRoot, repoRoot), '.');
    const external = path.resolve('/tmp/pcm-team-a');
    assert.strictEqual(composeHostPath(repoRoot, external), external);
});

test('example team config uses explicit pcm-connectathon security settings', () => {
    const configPath = path.join(repoRoot, 'pcm-connectathon', 'example-team-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    assert.match(config.teamId, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(['tls', 'mtls'].includes(config.security.pcmApi.clientAuth));
    assert.ok(['tls', 'mtls'].includes(config.security.dataSourceGateway.clientAuth));
    assert.ok(['http', 'https'].includes(config.security.dsGatewayToFhirServer.protocol));
    assert.strictEqual(config.configVersion, 'pcm-team-config/5');
    assert.strictEqual(config.conformance.preset, 'connectathon-easy');
    assert.strictEqual(config.security.dsFhirServer.enforceMappedPatients, true);
    assert.strictEqual(config.securitySimulation.awsCredentialIsolation, true);
    assert.ok(config.healthOrganizations.every(ho => ho.clinicalData.managed));
    assert.ok(config.runtime.certsDir);
    assert.ok(config.publicBaseUrls.spClient);
});

test('team config contains required top-level sections', () => {
    const configPath = path.join(repoRoot, 'pcm-connectathon', 'example-team-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    for (const key of ['contract', 'security', 'runtime', 'publicBaseUrls', 'internalBaseUrls', 'certificates', 'certificateRoles', 'organizations']) {
        assert.strictEqual(typeof config[key], 'object', key);
    }
});

test('required pcm-connectathon operator scripts exist', () => {
    const scripts = [
        'create-team.js',
        'generate-team-certs.js',
        'reset-team.js',
        'backup-team.js',
        'restore-team.js',
        'validate-team-config.js',
        'run-sanity-check.js',
        'run-clinical-import.js',
        'reset-health-organization.js',
        'export-team-bundle.js',
        'start-local-team.js',
        'stop-local-team.js'
        , 'bootstrap-local-team.js'
    ];

    for (const script of scripts) {
        assert.ok(fs.existsSync(path.join(repoRoot, 'pcm-connectathon', 'scripts', script)), script);
    }
});

test('AWS team refresh preserves existing tfvars ports unless ports are explicit', t => {
    const teamId = `test-refresh-${process.pid}`;
    const fixture = path.join(repoRoot, 'pcm-connectathon/aws/terraform/team', `${teamId}.tfvars`);
    fs.writeFileSync(fixture, `team_id = "${teamId}"\nregion = "il-central-1"\nsp_ui_public_port = 9310\npcm_ui_public_port = 9410\n`, { flag: 'wx' });
    t.after(() => fs.rmSync(fixture, { force: true }));
    const result = spawnSync('node', [
        'pcm-connectathon/aws/scripts/manage-team.js',
        'update',
        '--team-id',
        teamId,
        '--refresh-tfvars',
        '--skip-terraform',
        '--dry-run'
    ], {
        cwd: repoRoot,
        encoding: 'utf8'
    });

    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.includes(`create-team-tfvars.js --team-id ${teamId}`));
    assert.doesNotMatch(result.stdout, /--sp-ui-public-port 3100/);
    assert.doesNotMatch(result.stdout, /--pcm-ui-public-port 4100/);
    assert.doesNotMatch(result.stdout, /--ds-gateway-public-port 8180/);
});

test('local team start rejects missing certificate material before Docker execution', t => {
    const directory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pcm certificate preflight '));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const teamDir = path.join(directory, 'missing-certs');
    fs.mkdirSync(teamDir);
    fs.writeFileSync(path.join(teamDir, 'team-config.json'), JSON.stringify(require('../../test-support/team-config').buildTeamConfig()));
    fs.writeFileSync(path.join(teamDir, '.env'), 'PCM_CONFORMANCE_MODE=connectathon\n');
    const result = spawnSync(process.execPath, ['pcm-connectathon/scripts/start-local-team.js',
        '--team-id', 'missing-certs', '--teams-root', directory, '--no-build'], { cwd: repoRoot, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /certificate file is missing/);
    assert.doesNotMatch(result.stdout, /Started local Compose/);
});

test('sanity check clears Doctor Portal runtime state before exercising flows', () => {
    const scriptPath = path.join(repoRoot, 'pcm-connectathon', 'scripts', 'run-sanity-check.js');
    const script = fs.readFileSync(scriptPath, 'utf8');

    const resetIndex = script.indexOf("`${spBase}/reset`");
    const createIndex = script.indexOf("`${spBase}/create-consent`");

    assert.ok(resetIndex > -1, 'sanity script should call Doctor Portal reset');
    assert.ok(createIndex > -1, 'sanity script should create a consent');
    assert.ok(resetIndex < createIndex, 'reset should happen before consent creation');
    assert.match(script, /reference-ds-health-url/);
    assert.match(script, /referenceDsHealthUrl \|\| `\$\{refDsUrl\.origin\}\/healthz`/);
    assert.match(script, /headers: \{ Accept: 'application\/json' \}/);
    assert.match(script, /fetch\.json\?\.status === 'success' && hasPositiveObservation\(fetch\.json\?\.data\)/);
    assert.match(script, /resourceType: fetch\.json\?\.data\?\.resourceType/);
    assert.doesNotMatch(script, /reference-fhir|fhir-health|ds-fhir-server/);
    assert.doesNotMatch(script, /Data Fetched Successfully\|Observation\|Bundle/);
});

test('legacy gateway keeps a non-colliding HTTP metadata port while three-HO metadata stays private', () => {
    const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
    const env = fs.readFileSync(path.join(repoRoot, 'pcm-connectathon', 'example.env'), 'utf8');
    const template = fs.readFileSync(path.join(repoRoot, 'pcm-connectathon', 'nginx', 'nginx.conf.template'), 'utf8');

    assert.match(compose, /\$\{DS_GATEWAY_HTTP_PORT:-8081\}:8081/);
    assert.match(env, /^DS_GATEWAY_HTTP_PORT=8183$/m);
    assert.match(template, /listen \$\{DS_GATEWAY_HTTP_PORT\};/);
    assert.match(template, /\/\.well-known\/oauth-authorization-server/);
    assert.match(template, /\/\.well-known\/jwks\.json/);
    const tlsServer = template.indexOf('listen ${DS_GATEWAY_PORT} ssl;');
    assert.ok(tlsServer > 0);
    assert.doesNotMatch(template.slice(tlsServer), /\/\.well-known\/(?:oauth-authorization-server|jwks\.json)/);
});

test('private adapter relay applies configured upstream verification with the team root CA', () => {
    const template = fs.readFileSync(path.join(repoRoot, 'pcm-connectathon', 'nginx', 'nginx.conf.template'), 'utf8');
    const runtimeReload = fs.readFileSync(path.join(repoRoot, 'src', 'ds-gateway', 'runtime-reload.sh'), 'utf8');
    const adapter = fs.readFileSync(path.join(repoRoot, 'src', 'ds-auth-adapter', 'src', 'index.js'), 'utf8');

    assert.match(template, /X-PCM-Upstream-Verify "\$\{DS_FHIR_PROXY_SSL_VERIFY\}"/);
    assert.match(adapter, /ca: fs\.readFileSync\(fixedBindings\.rootCaPath\)/);
    assert.match(adapter, /rejectUnauthorized: verifyServerCertificate/);
    assert.match(runtimeReload, /envsubst '[^']*\$ROOT_CA_CERT/);
});

test('connectathon Warning header remains valid after nginx template substitution', () => {
    const runtimeReload = fs.readFileSync(path.join(repoRoot, 'src', 'ds-gateway', 'runtime-reload.sh'), 'utf8');

    assert.match(runtimeReload, /PCM_MODE_WARNING_HEADER='299 pcm-sandbox \\\"Connectathon compatibility profile; not strict conformance evidence\\\"'/);
});

test('data source gateway emits structured logs, propagates correlation, and bounds upstream waits', () => {
    const template = fs.readFileSync(path.join(repoRoot, 'pcm-connectathon', 'nginx', 'nginx.conf.template'), 'utf8');
    const runtimeReload = fs.readFileSync(path.join(repoRoot, 'src', 'ds-gateway', 'runtime-reload.sh'), 'utf8');

    assert.match(template, /log_format ds_gateway_json escape=json/);
    assert.match(template, /log_subrequest on;/);
    assert.match(template, /access_log \/runtime\/logs\/ds-gateway\/current\.log ds_gateway_json;/);
    assert.match(template, /map \$status \$log_level \{\s+~\^5 ERROR;\s+~\^4 WARN;\s+default INFO;\s+\}/);
    assert.match(template, /"type":"GATEWAY_RESPONSE"/);
    assert.match(template, /"level":"\$log_level"/);
    assert.match(template, /"message":"Gateway Response: \$status \$request_method \$uri\$is_args\$args"/);
    assert.match(template, /"originalUrl":"\$request_uri"/);
    assert.match(template, /"timestampEpoch":"\$msec"/);
    assert.match(template, /location = \/healthz \{\s+access_log off;/);
    assert.match(template, /map \$http_x_correlation_id \$correlation_id/);
    assert.match(template, /map \$http_x_flow_id \$flow_id/);
    assert.match(template, /proxy_set_header X-Correlation-Id \$correlation_id;/);
    assert.match(template, /proxy_set_header X-Flow-Id \$flow_id;/);
    assert.match(template, /"flowId":"\$flow_id"/);
    assert.match(template, /auth_request_set \$auth_resp_status \$upstream_status;/);
    assert.match(template, /proxy_connect_timeout 5s;/);
    assert.match(template, /proxy_read_timeout 30s;/);
    assert.match(runtimeReload, /mkdir -p "\$LOG_DIR"/);
});

test('Node service containers receive shared log policy code in local and AWS deployments', () => {
    const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
    const awsDockerfiles = [
        'pcm-core.Dockerfile',
        'sp-client.Dockerfile',
        'ds-auth-adapter.Dockerfile',
        'ds-fhir-server.Dockerfile'
    ].map(file => fs.readFileSync(path.join(repoRoot, 'pcm-connectathon', 'aws', 'dockerfiles', file), 'utf8'));

    const sharedMounts = compose.match(/\.\/src\/shared:\/shared:ro/g) || [];
    assert.equal(sharedMounts.length, 4);
    for (const dockerfile of awsDockerfiles) {
        assert.match(dockerfile, /COPY src\/shared \/shared/);
    }
});

test('PCM exposes a separate policy-controlled TLS port for public well-known metadata', () => {
    const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
    const env = fs.readFileSync(path.join(repoRoot, 'pcm-connectathon', 'example.env'), 'utf8');
    const index = fs.readFileSync(path.join(repoRoot, 'src', 'pcm-core', 'src', 'index.js'), 'utf8');

    assert.match(compose, /\$\{PCM_METADATA_PORT:-4002\}:3005/);
    assert.match(compose, /METADATA_PORT=3005/);
    assert.match(env, /^PCM_METADATA_PORT=4102$/m);
    assert.match(index, /const METADATA_PORT = process\.env\.METADATA_PORT \|\| 3005/);
    assert.match(index, /createMetadataApp/);
});

test('general migration refuses legacy configurations without runtime fallback or partial writes', t => {
    const directory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pcm-config-migration-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const target = path.join(directory, 'legacy.json');
    const historical = require('../../test-support/team-config').buildTeamConfig();
    historical.configVersion = 'pcm-team-config/2';
    delete historical.conformance.preset;
    delete historical.securitySimulation;
    for (const ho of historical.healthOrganizations) {
        delete ho.clinicalData;
        ho.fixtureSet = ho.id;
    }
    const original = JSON.stringify(historical);
    fs.writeFileSync(target, original);
    const invoke = extra => spawnSync(process.execPath, ['pcm-connectathon/scripts/migrate-team-config.js', '--config', target, ...extra], { cwd: repoRoot, encoding: 'utf8' });
    for (const extra of [[], ['--write']]) {
        const result = invoke(extra); assert.notEqual(result.status, 0); assert.match(result.stderr, /Coordinated scope migration/);
        assert.equal(fs.readFileSync(target, 'utf8'), original); assert.deepEqual(fs.readdirSync(directory), ['legacy.json']);
    }
});
