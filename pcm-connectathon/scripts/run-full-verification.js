#!/usr/bin/env node
'use strict';

/** Full local-only disposable runtime, browser, and evidence gate. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseArgs, repoRoot, run, LOCAL_ONLY_ENV } = require('./lib');
const { scanFiles } = require('../../scripts/scan-release-artifacts');
const { readinessWaitTimeout, readinessEnvironment } = require('./lifecycle');
const { ownedBootstrapEnvironment } = require('../ui/run-playwright');
const { readEnvironmentValue } = require('./team-credentials');

/** Read the actual decoded Admin fixture used by the selected disposable team. */
function readTeamAdminPassword(teamDir) {
    return readEnvironmentValue(fs.readFileSync(path.join(teamDir, '.env'), 'utf8'), 'TEAM_ADMIN_PASSWORD');
}

function checksumFiles(directory) {
    const files = [];
    const walk = target => {
        for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
            const full = path.join(target, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name !== 'SHA256SUMS') files.push(full);
        }
    };
    walk(directory);
    const lines = files.sort().map(file => `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.relative(directory, file)}`);
    fs.writeFileSync(path.join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`);
    return lines.length;
}

/** Execute four disposable presets and retain actual scenario outcomes before declaring success. */
async function verify(argv) {
    const args = parseArgs(argv);
    const waitTimeout = readinessWaitTimeout(args['wait-timeout']);
    if (args['skip-ui']) throw new Error('--skip-ui cannot produce full qualification; use ordinary local smoke instead');
    const { DEMO_BROWSER_GREP, loadCiDataset, browserScenarios, workflowBrowserScenarios, demoBrowserScenarios, validateQualification } = require('./full-coverage');
    const { PRESETS } = require('../../src/shared/conformance-policy');
    const { DataOperationRegistry } = require('../../src/pcm-core/src/data-operations');
    const { snapshotWorkflowLogs, verifyWorkflowLogs } = require('./workflow-log-evidence');
    const { guardedFetch } = require('../../src/shared/outbound-destination');
    const dataset = loadCiDataset(args['dataset-manifest']);
    const root = repoRoot();
    if (args['team-prefix'] && !/^[a-z][a-z0-9-]{0,20}$/.test(args['team-prefix'])) throw new Error('invalid team prefix');
    const runId = args['run-id'] || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
    if (!/^\d{8}T\d{6}Z$/.test(runId)) throw new TypeError('--run-id must use YYYYMMDDTHHMMSSZ');
    assertFreshRun(args);
    const teamsRoot = path.join(root, 'tmp', 'release-work', runId, 'teams');
    const evidenceRoot = path.join(root, 'tmp', 'release-evidence', `pcm-ig-${require('../../src/shared/pcm-contract').PCM_IG.version}`, runId);
    const evidence = path.join(evidenceRoot, 'connectathon');
    if (fs.existsSync(evidenceRoot)) throw new Error(`refusing to overwrite evidence path ${evidenceRoot}`);
    fs.mkdirSync(path.join(evidenceRoot, 'command-results'), { recursive: true });
    fs.mkdirSync(path.join(evidenceRoot, 'hapi-supply-chain'), { recursive: true });
    fs.mkdirSync(evidence, { recursive: true });
    // The inspected, explicitly selected CI inventory is the qualification authority.
    const eligibilityFile = path.join(evidenceRoot, 'presence-eligibility.json');
    const eligible = dataset.bundles.flatMap(item => item.inspected.patients.map(patient => ({ system: patient.idSystem, value: patient.idValue })));
    // Explicit fabricated absent identity used by the count-zero gateway case.
    eligible.push({ system: 'http://fhir.health.gov.il/identifier/il-national-id', value: '000000026' });
    fs.writeFileSync(eligibilityFile, JSON.stringify([...new Map(eligible.map(patient => [`${patient.system}|${patient.value}`, patient])).values()], null, 2));
    const workflowFixtureRoot = path.join(root, 'tmp/release-work', runId, 'workflow-fixtures');
    fs.mkdirSync(workflowFixtureRoot, { recursive: true });
    const workflowFixtures = require('../../clinical-data/pcm-ig-042-workflows').candidateWorkflowFixtures();
    for (const [ho, bundle] of Object.entries(workflowFixtures.bundles)) {
        fs.writeFileSync(path.join(workflowFixtureRoot, `${ho}.transaction.json`), JSON.stringify(bundle));
    }
    fs.writeFileSync(path.join(evidenceRoot, 'workflow-fixture-hashes.json'), JSON.stringify(Object.fromEntries(Object.keys(workflowFixtures.bundles).map(ho => [ho, crypto.createHash('sha256').update(fs.readFileSync(path.join(workflowFixtureRoot, `${ho}.transaction.json`))).digest('hex')])), null, 2));
    const env = { ...readinessEnvironment(process.env, waitTimeout), [LOCAL_ONLY_ENV]: 'true', PCM_HAPI_VERSION: process.env.PCM_HAPI_VERSION || `qualification-${runId.toLowerCase()}`, VERSION: process.env.VERSION || `qualification-${runId.toLowerCase()}`, PCM_PLAYWRIGHT_IMAGE: process.env.PCM_PLAYWRIGHT_IMAGE || `pcm-connectathon-playwright:qualification-${runId.toLowerCase()}` };
    const revision = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const identity = require('./source-identity').sourceIdentity(root);
    fs.writeFileSync(path.join(evidenceRoot, 'source-identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
    const summary = { sourceRevision: revision, sourceTreeSha256: identity.sha256, schemaVersion: 'pcm-full-gate/2', label: 'LOCAL FOUR-PRESET SANDBOX QUALIFICATION — NOT CERTIFICATION',
        runId, datasetManifestSha256: dataset.sha256, status: 'running', phases: [], presets: [] };
    const save = () => fs.writeFileSync(path.join(evidence, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    save(); // Establish the summary before any external phase starts.
    let commandIndex = 0;
    const command = (name, program, commandArgs, commandEnv = env, verifyResult) => {
        console.log(JSON.stringify({ phase: name, status: 'running' }));
        const log = path.join(evidenceRoot, 'command-results', `${String(++commandIndex).padStart(3, '0')}-${name}.log`);
        const descriptor = fs.openSync(log, 'w');
        const started = Date.now();
        try {
            run(program, commandArgs, { cwd: root, env: commandEnv, stdio: ['ignore', descriptor, descriptor] });
            if (verifyResult) verifyResult();
            summary.phases.push({ name, status: 'pass', log: path.relative(evidenceRoot, log), durationMilliseconds: Date.now() - started });
        } catch (error) {
            summary.phases.push({ name, status: 'fail', log: path.relative(evidenceRoot, log), durationMilliseconds: Date.now() - started });
            throw new Error(`${name} failed; see ${log}`);
        } finally { fs.closeSync(descriptor); save(); }
    };
    let browserDiscovery;
    const admitBrowser = (name, report) => {
        return require('./browser-phase-admission').admit(name, report, false, browserDiscovery.phases.find(phase => phase.phase === name).selectedKeys);
    };
    try {
        if (!browserDiscovery) {
            const output = path.join(evidenceRoot, 'required-browser-discovery');
            command('required-browser-discovery', 'node', ['pcm-connectathon/scripts/discover-required-browser.js', '--output', output, '--image', env.PCM_PLAYWRIGHT_IMAGE]);
            browserDiscovery = JSON.parse(fs.readFileSync(path.join(output, 'receipt.json')));
        }
        command('fast-gate', 'node', ['pcm-connectathon/scripts/verify-local.js']);
        // The strict first preset does not start legacy, but later unique-tag presets need its current image.
        if (!args['no-build']) command('legacy-image-build', 'docker', ['build', '--pull=false', '-t', `ghcr.io/ronenabra/hdp-reference-architecture-v2-public-ds-fhir-server:${env.VERSION}`, 'src/ds-fhir-server']);
        // Exercise the strictest runtime first so shared qualification failures surface early.
        for (const [index, preset] of [...PRESETS].reverse().entries()) {
            const teamId = `${args['team-prefix'] || 'full'}-${runId.toLowerCase().replace(/[tz]/g, '')}-${index}`;
            const presetTeamsRoot = teamsRoot;
            const teamDir = path.join(presetTeamsRoot, teamId);
            const presetDir = path.join(evidence, preset);
            fs.mkdirSync(presetDir, { recursive: true });
            fs.chmodSync(presetDir, 0o777);
            const result = { preset, teamId, scenarios: [], status: 'running' };
            summary.presets.push(result);
            const runtimeEnv = ownedBootstrapEnvironment({ ...env, COMPOSE_PROJECT_NAME: teamId });
            const compose = ['compose', '-f', 'docker-compose.yml', '-f', 'pcm-connectathon/compose.ho.yaml', '--env-file', path.join(teamDir, '.env')];
            const matrix = (service, file, output, verifyResult) => command(`${preset}-${output}`, 'docker', [
                    ...compose, 'run', '--rm', '--no-deps', '-e', 'NODE_PATH=/app/node_modules', '-e', 'NODE_EXTRA_CA_CERTS=/runtime/certs/rootCA.crt',
                    '-e', 'TEAM_ADMIN_PASSWORD', '-e', `PCM_MATRIX_OUTPUT=/artifacts/${output}.json`, '-v', `${path.join(root, 'clinical-data')}:/clinical-data:ro`,
                    '-v', `${presetDir}:/artifacts`, service, 'node', `/clinical-data/test/${file}`
                ], { ...runtimeEnv, TEAM_ADMIN_PASSWORD: password }, verifyResult);
            let config, password, headers, observedLogs, sanity;
            let phaseFailed = false;
            try {
                command(`${preset}-bootstrap`, 'node', [
                    'pcm-connectathon/scripts/bootstrap-local-team.js', '--team-id', teamId, '--teams-root', presetTeamsRoot,
                    '--port-index', String(args['port-index'] || 50), '--preset', preset, '--environment', 'production', '--require-clinical',
                    '--wait-timeout', String(waitTimeout),
                    '--empty-sanity-output', path.join(presetDir, 'fresh-empty-sanity.json'), '--presence-eligibility-file', eligibilityFile, '--sanity-output', path.join(presetDir, 'sanity.json'), '--bundle-root', dataset.root, '--bootstrap-policy', 'if-empty',
                    ...dataset.bundles.flatMap(item => [`--${item.serverId}-bundle`, item.file, `--${item.serverId}-source`, item.source]),
                    ...(args['no-build'] || index > 0 ? ['--no-build'] : [])
                ], runtimeEnv);
                const emptySanity = JSON.parse(fs.readFileSync(path.join(presetDir, 'fresh-empty-sanity.json')));
                if (emptySanity.status !== 'pass' || !emptySanity.checks.some(check => check.name === 'doctor-flow-not-applicable-without-verified-fixture')
                    || ['ho-a', 'ho-b', 'ho-c'].some(id => !emptySanity.checks.some(check => check.name === `${id}-online-presence-count-only` && check.total === 0 && check.status === 'pass'))) {
                    throw new Error('Fresh empty team did not pass its separate startup/absence smoke');
                }
                result.scenarios.push({ id: 'fresh-empty-bootstrap', status: 'pass', executed: true });
                config = JSON.parse(fs.readFileSync(path.join(teamDir, 'team-config.json'), 'utf8'));
                password = readTeamAdminPassword(teamDir);
                headers = { Accept: 'application/json', ...(password ? { 'x-admin-password': password } : {}) };
                for (const item of dataset.bundles) {
                    const response = await guardedFetch(`${config.publicBaseUrls.pcmUi}/admin/api/fhir-servers/${item.serverId}/data`, { headers, signal: AbortSignal.timeout(180000) });
                    const state = await response.json();
                    fs.writeFileSync(path.join(presetDir, `inventory-${item.serverId}.json`), JSON.stringify({ httpStatus: response.status, ...state }, null, 2));
                    if (!response.ok || state.state !== 'loaded' || state.actualResourceCount < 1 || state.bundle?.sha256 !== item.sha256 || !state.bundle?.patients?.length) throw new Error(`required verified inventory failed for ${item.serverId}: HTTP ${response.status}, ${JSON.stringify(state)}`);
                    result.scenarios.push({ id: `inventory-${item.serverId}`, executed: true, status: 'pass', sha256: item.sha256, resourceCount: state.actualResourceCount });
                }
                sanity = JSON.parse(fs.readFileSync(path.join(presetDir, 'sanity.json'), 'utf8'));
                if (sanity.status !== 'pass' || !sanity.checks.some(check => check.name === 'client-fetch-data-with-access-token' && check.status === 'pass')
                    || sanity.checks.some(check => check.name?.includes('skipped'))) throw new Error('required clinical sanity journey did not execute');
                observedLogs = snapshotWorkflowLogs(teamDir, path.join(presetDir, 'sanity-logs.jsonl'));
                command(`${preset}-descriptor`, 'node', ['pcm-connectathon/scripts/export-sut-descriptor.js', '--team-config', path.join(teamDir, 'team-config.json'),
                    '--output', path.join(presetDir, 'sut-descriptor.json'), '--project', teamId, '--env-file', path.join(teamDir, '.env'), '--release-grade'], runtimeEnv);
                const descriptor = JSON.parse(fs.readFileSync(path.join(presetDir, 'sut-descriptor.json'), 'utf8'));
                result.images = descriptor.runtime.images;
                result.runtimeRevision = config.runtime?.revision || 0;
                command(`${preset}-hapi-sbom`, 'docker', ['cp', `${teamId}-ho-a-hapi-1:/app/sbom/pcm-ho-fhir.cdx.json`,
                    path.join(evidenceRoot, 'hapi-supply-chain', `${preset}.cdx.json`)], runtimeEnv);
                if (preset === 'strict') {
                    matrix('sp-client', 'pcm-environment-matrix.js', 'production-environment');
                    result.scenarios.push(...JSON.parse(fs.readFileSync(path.join(presetDir, 'production-environment.json'))).scenarios);
                }
                matrix('sp-client', 'pcm-042-release-matrix.js', 'pcm-042-release');
                result.scenarios.push(...JSON.parse(fs.readFileSync(path.join(presetDir, 'pcm-042-release.json'))).scenarios);
                matrix('sp-client', 'gateway-presence-matrix.js', 'gateway');
                result.scenarios.push(...JSON.parse(fs.readFileSync(path.join(presetDir, 'gateway.json'))).scenarios);
                matrix('ho-a-adapter', 'hapi-count-matrix.js', 'hapi-count');
                result.scenarios.push(...JSON.parse(fs.readFileSync(path.join(presetDir, 'hapi-count.json'))).scenarios);
                if (preset !== 'connectathon-easy') {
                    matrix('ho-a-adapter', 'hapi-authorization-matrix.js', 'hapi');
                    result.scenarios.push(...JSON.parse(fs.readFileSync(path.join(presetDir, 'hapi.json'))).scenarios);
                }
                // Qualify accepted cards against their explicit rich fixtures before ordinary browser uploads replace them.
                for (const card of ['catalog', 'access', 'patients', 'sources']) {
                    matrix('sp-client', `demo-${card}-matrix.js`, `demo-${card}`);
                    result.scenarios.push(...JSON.parse(fs.readFileSync(path.join(presetDir, `demo-${card}.json`))).scenarios);
                }
                if (preset !== 'strict') {
                    const restore = await guardedFetch(`${config.publicBaseUrls.pcmUi}/admin/config/simulation`, {
                        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ preset }), signal: AbortSignal.timeout(30000)
                    });
                    if (!restore.ok) throw new Error('DEMO named preset restoration failed');
                    command(`${preset}-demo-client-refresh`, 'docker', [...compose, 'restart', 'sp-client'], runtimeEnv);
                }
                let demoReport;
                command(`${preset}-demo-browser`, 'node', ['pcm-connectathon/ui/run-playwright.js', '--max-failures', '1', '--team-config', path.join(teamDir, 'team-config.json'),
                    '--team-id', teamId, '--artifacts', path.join(presetDir, 'demo-browser'), '--no-fixture-setup', '--grep', DEMO_BROWSER_GREP], { ...runtimeEnv, PCM_UI_ADMIN_PASSWORD: password }, () => {
                    const actual = JSON.parse(fs.readFileSync(path.join(presetDir, 'demo-browser/results.json')));
                    demoReport = actual;
                    result.demoBrowserAdmission = admitBrowser('demo', demoReport);
                });
                result.scenarios.push(...demoBrowserScenarios(demoReport));
                result.demoBrowserCounts = demoReport.stats;
                // The browser exercises current-plus-history clear. Preserve
                // protocol denials before that intentional destructive check.
                observedLogs.push(...snapshotWorkflowLogs(teamDir, path.join(presetDir, 'protocol-logs.jsonl')));
                // A stopped, pre-submission owner provides the real browser recovery case.
                // It never submitted a HAPI mutation; the verified inventory above is its reconciliation evidence.
                command(`${preset}-recovery-fixture`, 'node', ['-e',
                    "const {DataOperationRegistry}=require('./src/pcm-core/src/data-operations'); const registry=new DataOperationRegistry({directory:process.argv[1]}); console.log(JSON.stringify(registry.create('ho-a','import',{diagnostics:['CI pre-submission worker has exited; HAPI state was verified before reservation.']})));",
                    path.join(teamDir, 'state', 'data-operations')
                ], runtimeEnv);
                const registry = new DataOperationRegistry({ directory: path.join(teamDir, 'state', 'data-operations') });
                result.recoveryOperationId = registry.list('ho-a')[0].id;
                require('./bootstrap-local-team').configureClinicalBootstrap(path.join(teamDir, 'team-config.json'), {
                    'bundle-root': path.join(root, 'clinical-data/ci'), 'bootstrap-policy': 'if-empty',
                    ...Object.fromEntries(['ho-a', 'ho-b', 'ho-c'].flatMap(id => [[`${id}-bundle`, `${id}.source.transaction.json`], [`${id}-source`, id]]))
                });
                command(`${preset}-playwright`, 'node', ['pcm-connectathon/ui/run-playwright.js', '--max-failures', '1', '--team-config', path.join(teamDir, 'team-config.json'),
                    '--team-id', teamId, '--artifacts', path.join(presetDir, 'browser'), '--fixture-root', path.join(root, 'clinical-data/ci'), '--require-clinical',
                    '--grep', require('./browser-phase-admission').MAIN_RUNTIME_GREP, '--grep-invert', DEMO_BROWSER_GREP], { ...runtimeEnv, PCM_UI_ADMIN_PASSWORD: password }, () => {
                    result.browserAdmission = admitBrowser('main', JSON.parse(fs.readFileSync(path.join(presetDir, 'browser/results.json'))));
                });
                const browserReport = JSON.parse(fs.readFileSync(path.join(presetDir, 'browser/results.json'), 'utf8'));
                result.scenarios.push(...browserScenarios(browserReport));
                result.browserCounts = browserReport.stats;
                matrix('sp-client', 'pcm-042-clinical-regressions.js', 'pcm-042-clinical-regressions');
                result.scenarios.push(...JSON.parse(fs.readFileSync(path.join(presetDir, 'pcm-042-clinical-regressions.json'))).scenarios);
                observedLogs.push(...snapshotWorkflowLogs(teamDir, path.join(presetDir, 'clinical-browser-logs.jsonl')));
                // Replace only this owned disposable team's clinical phase with the tiny system-workflow fixtures.
                command(`${preset}-workflow-configuration`, 'node', ['pcm-connectathon/scripts/configure-system-workflow-fixtures.js', '--team-dir', teamDir, '--candidate-042', '--write', '--apply-running'], runtimeEnv);
                require('./bootstrap-local-team').configureClinicalBootstrap(path.join(teamDir, 'team-config.json'), {
                    'bundle-root': workflowFixtureRoot, 'bootstrap-policy': 'replace',
                    ...Object.fromEntries(['ho-a', 'ho-b', 'ho-c'].flatMap(id => [[`${id}-bundle`, `${id}.transaction.json`], [`${id}-source`, id]]))
                });
                command(`${preset}-workflow-import`, 'node', ['pcm-connectathon/scripts/run-clinical-import.js', '--team-id', teamId, '--teams-root', presetTeamsRoot,
                    '--all', '--bundle-root', workflowFixtureRoot], runtimeEnv);
                if (preset !== 'connectathon-easy') {
                    matrix('ho-a-adapter', 'hapi-system-workflow-matrix.js', 'hapi-system-workflows');
                    result.scenarios.push(...JSON.parse(fs.readFileSync(path.join(presetDir, 'hapi-system-workflows.json'))).scenarios);
                }
                let workflowReport;
                command(`${preset}-workflow-browser`, 'node', ['pcm-connectathon/ui/run-playwright.js', '--max-failures', '1', '--team-config', path.join(teamDir, 'team-config.json'),
                    '--team-id', teamId, '--artifacts', path.join(presetDir, 'workflow-browser'), '--workflows', '--candidate-042', '--workflow-fixture-root', workflowFixtureRoot,
                    ], { ...runtimeEnv, PCM_UI_ADMIN_PASSWORD: password }, () => {
                    workflowReport = JSON.parse(fs.readFileSync(path.join(presetDir, 'workflow-browser/results.json')));
                    result.workflowBrowserAdmission = admitBrowser('workflow', workflowReport);
                });
                result.scenarios.push(...workflowBrowserScenarios(workflowReport), ...require('./full-coverage').candidateBrowserScenarios(workflowReport));
                command(`${preset}-source-failure`, 'docker', [...compose, 'stop', 'ho-b-gateway'], runtimeEnv);
                try {
                    command(`${preset}-partial-workflow-browser`, 'node', ['pcm-connectathon/ui/run-playwright.js', '--max-failures', '1', '--team-config', path.join(teamDir, 'team-config.json'),
                        '--team-id', teamId, '--artifacts', path.join(presetDir, 'partial-workflow-browser'), '--workflows', '--workflow-fixture-root', workflowFixtureRoot, '--grep', 'PCM 0.4.0 failed source', '--workflow-partial'], { ...runtimeEnv, PCM_UI_ADMIN_PASSWORD: password }, () => {
                        result.partialBrowserAdmission = admitBrowser('partial', JSON.parse(fs.readFileSync(path.join(presetDir, 'partial-workflow-browser/results.json'))));
                    });
                    const report = JSON.parse(fs.readFileSync(path.join(presetDir, 'partial-workflow-browser/results.json')));
                    const outcomes = require('./full-coverage').partialWorkflowBrowserScenarios(report);
                    result.scenarios.push(...outcomes);
                } finally {
                    command(`${preset}-source-recovery`, 'docker', [...compose, 'start', 'ho-b-gateway'], runtimeEnv);
                }
                command(`${preset}-candidate-source-failure`, 'docker', [...compose, 'stop', 'ho-c-gateway'], runtimeEnv);
                try {
                    command(`${preset}-candidate-partial-browser`, 'node', ['pcm-connectathon/ui/run-playwright.js', '--max-failures', '1', '--team-config', path.join(teamDir, 'team-config.json'),
                        '--team-id', teamId, '--artifacts', path.join(presetDir, 'candidate-partial-browser'), '--workflows', '--candidate-042', '--workflow-fixture-root', workflowFixtureRoot,
                        '--grep', 'candidate 0.4.2 unavailable', '--workflow-partial'], { ...runtimeEnv, PCM_UI_ADMIN_PASSWORD: password }, () => {
                        result.candidatePartialBrowserAdmission = admitBrowser('candidate-partial', JSON.parse(fs.readFileSync(path.join(presetDir, 'candidate-partial-browser/results.json'))));
                    });
                    result.scenarios.push(...require('./full-coverage').candidateBrowserScenarios(JSON.parse(fs.readFileSync(path.join(presetDir, 'candidate-partial-browser/results.json'))), true));
                } finally { command(`${preset}-candidate-source-recovery`, 'docker', [...compose, 'start', 'ho-c-gateway'], runtimeEnv); }
                if (preset === 'strict') {
                    const plan = require('./verification-environment').planVerificationEnvironment(
                        JSON.parse(fs.readFileSync(path.join(teamDir, 'team-config.json'))),
                        fs.readFileSync(path.join(teamDir, '.env'), 'utf8'), 'test');
                    require('./verification-environment').applyVerificationEnvironment({
                        configPath: path.join(teamDir, 'team-config.json'), envPath: path.join(teamDir, '.env'), plan, compose,
                        execute: (name, program, values) => command(name, program, values, runtimeEnv)
                    });
                    command('strict-test-ready', 'node', ['pcm-connectathon/scripts/start-local-team.js', '--team-id', teamId, '--teams-root', presetTeamsRoot, '--no-build', '--wait-timeout', String(waitTimeout)], runtimeEnv);
                    matrix('sp-client', 'pcm-environment-matrix.js', 'test-environment');
                    result.scenarios.push(...JSON.parse(fs.readFileSync(path.join(presetDir, 'test-environment.json'))).scenarios);
                    command('strict-test-workflow-browser', 'node', ['pcm-connectathon/ui/run-playwright.js', '--max-failures', '1', '--team-config', path.join(teamDir, 'team-config.json'),
                        '--team-id', teamId, '--artifacts', path.join(presetDir, 'test-workflow-browser'), '--workflows', '--candidate-042', '--workflow-fixture-root', workflowFixtureRoot], { ...runtimeEnv, PCM_UI_ADMIN_PASSWORD: password }, () => {
                        result.testWorkflowBrowserAdmission = admitBrowser('test-workflow', JSON.parse(fs.readFileSync(path.join(presetDir, 'test-workflow-browser/results.json'))));
                    });
                    const verified = workflowBrowserScenarios(JSON.parse(fs.readFileSync(path.join(presetDir, 'test-workflow-browser/results.json'))));
                    if (verified.some(item => !item.executed)) throw new Error('strict test workflow browser did not execute');
                    result.scenarios.push({ id: 'strict-test-workflows', status: 'pass', executed: true });
                }


                observedLogs.push(...snapshotWorkflowLogs(teamDir, path.join(presetDir, 'workflow-logs.jsonl')));
                const logEvidence = verifyWorkflowLogs(observedLogs, { protectedPreset: preset !== 'connectathon-easy' });
                fs.writeFileSync(path.join(presetDir, 'workflow-log-evidence.json'), JSON.stringify(logEvidence, null, 2));
                result.scenarios.push(...logEvidence.scenarios);
                result.intentionalExclusions = ['Non-desktop projects omit the full operator/clinical journeys; each still executes its required responsive smoke.'];
                result.scenarioCounts = { required: result.scenarios.length, executed: result.scenarios.filter(item => item.executed).length,
                    passed: result.scenarios.filter(item => item.status === 'pass').length };
                result.policy = sanity.effectivePolicy;
                result.status = 'pass';
            } catch (error) { phaseFailed = true; result.status = 'fail'; result.error = error.message; throw error; }
            finally {
                try {
                    if (!fs.existsSync(path.join(teamDir, '.env'))) throw new Error('runtime creation did not complete');
                    command(`${preset}-cleanup`, 'node', ['pcm-connectathon/scripts/stop-local-team.js', '--team-id', teamId, '--teams-root', presetTeamsRoot, '--volumes'], runtimeEnv);
                    result.cleanup = { status: 'pass' };
                } catch (error) { result.cleanup = { status: 'fail', error: error.message }; result.status = 'fail'; }
                save();
                // Keep a pending phase error; otherwise required cleanup failure stops the preset loop here.
                if (result.cleanup.status !== 'pass' && !phaseFailed) throw new Error(`${preset} required cleanup failed: ${result.cleanup.error}`);
            }
        }
        validateQualification(summary);
        const scan = scanFiles([evidenceRoot], { awsOnly: true });
        fs.writeFileSync(path.join(evidenceRoot, 'aws-artifact-scan.json'), JSON.stringify(scan, null, 2));
        if (scan.findings.length) throw new Error('AWS credential canary/artifact scan failed');
        summary.status = 'pass';
    } catch (error) { summary.status = 'fail'; summary.error = error.message; throw error; }
    finally { save(); checksumFiles(evidenceRoot); }
    console.log(JSON.stringify({ status: summary.status, evidence: evidenceRoot }));
}

/** Reject historical partial-run flags before any dataset, Docker or file work. */
function assertFreshRun(args) {
    if (Object.keys(args).some(key => key.startsWith('resume-'))) {
        throw new Error('Historical resume modes are not distributed; start a fresh full verification run.');
    }
}

/** Run an independent qualification with no imported historical pass credit. */
async function main(argv = process.argv) {
    assertFreshRun(parseArgs(argv));
    return verify(argv);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { checksumFiles, main, readTeamAdminPassword, assertFreshRun };
