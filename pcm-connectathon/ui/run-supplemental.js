#!/usr/bin/env node
'use strict';

/** Explicit fixture-owning browser gate. Requires an existing disposable team. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { parseArgs, repoRoot } = require('../scripts/lib');
const manifest = require('./supplemental-manifest.json');
const approvalModules = require('./approval-modules.json');
const { stageBrowserCertificates } = require('../scripts/browser-certificates');
const { readEnvironmentValue } = require('../scripts/team-credentials');
const REQUIRED_FIXTURE_FILES = Object.freeze([
    'pcm-connectathon/scripts/sanity-data-state.js',
    ...approvalModules.map(file => `src/shared/${file}`),
    'node_modules/ejs/package.json', 'test-support/approval-scope-fixture.js', 'test-support/services-fixture.js', 'test-support/certificates.js',
    'src/shared/browser-navigation.js', 'src/shared/consent-status.js',
    ...['dashboard', 'consent', 'logs', 'services'].map(view => `src/pcm-core/src/views/${view}.ejs`),
    ...['index', 'patients', 'manage', 'logs'].map(view => `src/sp-client/src/views/${view}.ejs`),
    ...['help-copy.js', 'help.js', 'doctor-selection.js', 'doctor-tools.js', 'patient-library.js', 'connectathon.js', 'connectathon.css',
        'admin-feedback.js', 'approval-scopes.js', 'consent-cancellation.js', 'source-change.js', 'services.js'].map(file => `src/shared/ui/${file}`),
    ...['ops-fixture-server.js', 'admin-reload-fixture-server.js', 'render-admin-fixture.js'].map(file => `pcm-connectathon/ui/${file}`),
    ...['ho-a', 'ho-b', 'ho-c'].map(id => `clinical-data/ci/${id}.source.transaction.json`)
]);

/** Run a bounded command and preserve nonzero status as a gate failure. */
function execute(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: 'inherit', ...options });
    if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error?.message || args.join(' ')}`);
}
/** Fail before starting jobs when any named input is missing. */
function preflight(root, configFile, selected = manifest.suites) {
    const required = [...REQUIRED_FIXTURE_FILES];
    for (const suite of selected) for (const file of suite.files) required.push(`pcm-connectathon/ui/tests/${file}`);
    for (const file of required) if (!fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing required supplemental fixture: ${file}`);
    if (!configFile || !fs.existsSync(configFile)) throw new Error('--team-config must name an existing disposable team');
    const config = JSON.parse(fs.readFileSync(configFile));
    for (const file of ['rootCA.crt', 'sp-client.key', 'sp-client.crt', 'sp-client-assertion.key']) if (!fs.existsSync(path.join(path.dirname(configFile), 'certs', file))) throw new Error(`Missing required team certificate: ${file}`);
    return config;
}
/** Start only an owned fixture and wait for its listening receipt, failing on a collision. */
async function startFixture(root, file, receipt) {
    const child = spawn(process.execPath, [file], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
        child.stdout.on('data', bytes => { if (bytes.toString().includes(receipt)) resolve(); });
        child.stderr.on('data', bytes => process.stderr.write(bytes));
        child.once('error', reject); child.once('exit', code => reject(new Error(`${file} exited before readiness (${code})`)));
    });
    return child;
}
/** Only native Chromium CDP input has an expected cross-engine exclusion. */
function expectedPlatformSkip(skip) {
    return skip.title === 'Logs horizontal Event splitter accepts native Chromium touch drag and cancellation @smoke'
        && ['firefox-smoke', 'webkit-smoke'].includes(skip.project);
}
/** Execute every declared suite with all four pinned projects and retain separate results. */
async function main(argv = process.argv) {
    const args = parseArgs(argv), root = repoRoot();
    const start = args.from ? manifest.suites.findIndex(suite => suite.name === args.from) : 0;
    if (start < 0) throw new Error(`Unknown supplemental start: ${args.from}`);
    const selected = args.suite ? manifest.suites.filter(suite => suite.name === args.suite) : manifest.suites.slice(start);
    if (!selected.length) throw new Error(`Unknown supplemental suite: ${args.suite}`);
    const configFile = args['team-config'] && path.resolve(args['team-config']);
    const config = preflight(root, configFile, selected);
    const teamEnv = path.join(path.dirname(configFile), '.env');
    const adminPassword = process.env.PCM_UI_ADMIN_PASSWORD || (fs.existsSync(teamEnv) ? readEnvironmentValue(fs.readFileSync(teamEnv, 'utf8'), 'TEAM_ADMIN_PASSWORD') : '');
    if ((config.conformance.preset === 'strict' || selected.some(suite => ['help-runtime', 'browser-navigation'].includes(suite.name))) && !adminPassword) throw new Error('Missing required selected-team Admin authentication fixture');
    const artifacts = path.resolve(args.artifacts || 'tmp/ui-supplemental');
    fs.mkdirSync(artifacts, { recursive: true }); fs.chmodSync(artifacts, 0o777);
    const fixtures = [], certificates = stageBrowserCertificates(path.join(path.dirname(configFile), 'certs'));
    try {
        execute(process.execPath, ['pcm-connectathon/ui/render-admin-fixture.js', path.join(artifacts, 'empty.html')], { cwd: root });
        execute(process.execPath, ['pcm-connectathon/ui/render-admin-fixture.js', path.join(artifacts, 'recovery.html'), 'recovery'], { cwd: root });
        for (const file of ['empty.html', 'recovery.html']) fs.chmodSync(path.join(artifacts, file), 0o444);
        if (selected.some(suite => suite.fixtures.includes('ops-server'))) fixtures.push(await startFixture(root, 'pcm-connectathon/ui/ops-fixture-server.js', '43180'));
        if (selected.some(suite => suite.fixtures.includes('reload-server'))) fixtures.push(await startFixture(root, 'pcm-connectathon/ui/admin-reload-fixture-server.js', '43182'));
        const image = args.image || 'pcm-connectathon-playwright:p0-ui-01';
        execute('docker', ['build', '--pull=false', '-t', image, 'pcm-connectathon/ui'], { cwd: root });
        const imageId = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' }).stdout.trim();
        for (const suite of selected) {
            const output = path.join(artifacts, suite.name); fs.mkdirSync(output, { recursive: true }); fs.chmodSync(output, 0o777);
            const env = {
                PCM_NAV_REPO: '/repo', PCM_UI_ASSET_ROOT: '/ui-assets', PCM_HELP_ASSETS: '/ui-assets',
                PCM_ADMIN_PLAIN_FIXTURE: '/fixtures/recovery.html', PCM_ADMIN_REFRESH_FIXTURE: '/fixtures/empty.html', PCM_HELP_ADMIN_FIXTURE: '/fixtures/empty.html',
                PCM_OPS_FIXTURE_URL: 'http://127.0.0.1:43180', PCM_ADMIN_RELOAD_URL: 'http://127.0.0.1:43182',
                PCM_UI_SP_URL: config.publicBaseUrls.spClient, PCM_UI_PCM_URL: config.publicBaseUrls.pcmUi,
                PCM_UI_PRESET: config.conformance.preset, PCM_UI_CERTS_DIR: '/certs', PCM_UI_TEAM_ID: config.teamId
            };
            const mounts = [...approvalModules.map(file => `${root}/src/shared/${file}:/src/shared/${file}:ro`), `${root}:/repo:ro`, `${root}/src/shared/ui:/ui-assets:ro`, `${root}/src/shared/assertion-keys.js:/src/shared/assertion-keys.js:ro`, `${root}/pcm-connectathon/scripts/sanity-data-state.js:/scripts/sanity-data-state.js:ro`, `${root}/clinical-data/ci:/ci:ro`, `${artifacts}:/fixtures:ro`, `${output}:/artifacts`, `${certificates.directory}:/certs:ro`];
            execute('docker', ['run', '--rm', '--init', '--network', 'host', '-e', 'PCM_UI_ADMIN_PASSWORD', ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), ...mounts.flatMap(mount => ['-v', mount]), image, '--config', 'playwright.config.js', '--max-failures=1', ...suite.files, ...(args.project ? ['--project', args.project] : [])], { cwd: root, env: { ...process.env, PCM_UI_ADMIN_PASSWORD: adminPassword } });
            const report = JSON.parse(fs.readFileSync(path.join(output, 'results.json')));
            const skips = [];
            /** Inspect actual skipped test identities, allowing only documented input/browser exclusions. */
            function inspect(groups) { for (const group of groups || []) { for (const spec of group.specs || []) for (const test of spec.tests || []) if (test.status === 'skipped') skips.push({ title: spec.title, project: test.projectName }); inspect(group.suites); } }
            inspect(report.suites);
            if (skips.some(skip => !expectedPlatformSkip(skip))) throw new Error(`Unexpected required test skip: ${JSON.stringify(skips)}`);
            const bindings = ['docs/ui-explanation-catalog.md', 'src/pcm-core/src/routes/ui.js', 'src/pcm-core/src/views/services.ejs', 'src/pcm-core/src/routes/services.js', 'src/pcm-core/src/provider-management-client.js', 'src/pcm-core/src/service-definition-form.js', 'src/pcm-core/src/sandbox-service-command.js', 'src/pcm-core/src/views/dashboard.ejs', 'src/pcm-core/src/views/consent.ejs', 'src/pcm-core/src/views/logs.ejs', 'src/sp-client/src/views/index.ejs', 'src/sp-client/src/views/patients.ejs', ...fs.readdirSync(path.join(root, 'src/shared/ui')).map(file => `src/shared/ui/${file}`)].map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
            const fixtureInputs = ['pcm-connectathon/ui/approval-modules.json', ...approvalModules.map(file => `src/shared/${file}`), 'pcm-connectathon/scripts/sanity-data-state.js', 'pcm-connectathon/ui/ops-fixture-server.js', 'pcm-connectathon/ui/admin-reload-fixture-server.js', 'pcm-connectathon/ui/render-admin-fixture.js', 'pcm-connectathon/ui/package-lock.json', 'pcm-connectathon/ui/Dockerfile', 'test-support/approval-scope-fixture.js', 'test-support/services-fixture.js', ...['ho-a', 'ho-b', 'ho-c'].map(id => `clinical-data/ci/${id}.source.transaction.json`)].map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
            const receipt = { suite, image, imageId, bindings, fixtureInputs, adminAuthenticationSupplied: Boolean(adminPassword), configSha256: crypto.createHash('sha256').update(fs.readFileSync(configFile)).digest('hex'), markup: ['empty.html', 'recovery.html'].map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(artifacts, file))).digest('hex') })), projects: args.project ? [args.project] : manifest.projects, environment: env, mounts: mounts.map(mount => mount.replace(root, '<repo>').replace(artifacts, '<artifacts>').replace(certificates.directory, '<private-team-certificates>')), tests: suite.files.map(file => ({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'tests', file))).digest('hex') })), stats: report.stats, skips };
            fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
        }
    } finally {
        for (const child of fixtures) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
        certificates.cleanup();
    }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { preflight, manifest, REQUIRED_FIXTURE_FILES, expectedPlatformSkip };
