#!/usr/bin/env node
'use strict';

/** Run browser qualification in a pinned temporary Docker image. */

const fs = require('fs');
const { randomBytes } = require('node:crypto');
const path = require('path');
const { parseArgs, readJson, repoRoot, run, requireSafeTeamId } = require('../scripts/lib');

const { inspectTeamFixtures } = require('../scripts/fixture-patients');
const { stageBrowserCertificates } = require('../scripts/browser-certificates');
const { readEnvironmentValue } = require('../scripts/team-credentials');
const approvalModules = require('./approval-modules.json');

const IMAGE = process.env.PCM_PLAYWRIGHT_IMAGE || 'pcm-connectathon-playwright:1.62.1-sprint28';
const BASE_IMAGE = 'mcr.microsoft.com/playwright@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';

/** Check evidence for prohibited fields and the selected team's exact source-maintenance secrets. */
function secretScan(directory, maintenanceSecrets = []) {
    const prohibited = /adminPassword=/i;
    const findings = [];
    const walk = target => {
        for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
            const full = path.join(target, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (fs.statSync(full).size < 10 * 1024 * 1024) {
                const bytes = fs.readFileSync(full);
                if (prohibited.test(bytes) || maintenanceSecrets.some(secret => secret && bytes.includes(Buffer.from(secret)))) findings.push(full);
            }
        }
    };
    walk(directory);
    findings.push(...require('../../scripts/scan-release-artifacts').scanFiles([directory], { awsOnly: true }).findings.map(item => item.file));
    if (findings.length) throw new Error(`browser artifacts contain prohibited secret material: ${findings.join(', ')}`);
}

/**
 * Resolve actual plaintext maintenance values for the selected team's artifact leak check.
 * @param {object} config Selected team with explicit managed-source credential names.
 * @param {string} teamEnvironment Private managed .env text.
 * @param {object} environment Explicit plaintext process overrides.
 * @returns {string[]} Actual values that must never appear in browser artifacts.
 */
function selectedMaintenanceSecrets(config, teamEnvironment, environment = process.env) {
    return config.healthOrganizations.map(ho => environment[ho.import.credentialEnv]
        || readEnvironmentValue(teamEnvironment, ho.import.credentialEnv)).filter(Boolean);
}

/** Resolve the selected installation's actual Admin fixture without serializing it in arguments. */
function selectedAdminPassword(teamEnvironment, environment = process.env) {
    return environment.PCM_UI_ADMIN_PASSWORD || readEnvironmentValue(teamEnvironment, 'TEAM_ADMIN_PASSWORD');
}

/** A newly owned browser team needs an explicit private login fixture; preserve operator input. */
function ownedBootstrapEnvironment(environment = process.env) {
    return { ...environment, TEAM_ADMIN_PASSWORD: environment.TEAM_ADMIN_PASSWORD || randomBytes(32).toString('base64url') };
}

function main(argv = process.argv) {
    const args = parseArgs(argv);
    const root = repoRoot();
    const teamId = args['team-id'] || `ui-${Date.now()}`;
    requireSafeTeamId(teamId);
    const teamsRoot = path.resolve(root, args['teams-root'] || 'tmp/connectathon-ui-teams');
    const artifactRoot = path.resolve(root, args.artifacts || `tmp/ui-evidence/${teamId}`);
    const ownsTeam = !args['team-config'];
    let browserCertificates;
    let configPath = args['team-config'] ? path.resolve(args['team-config']) : path.join(teamsRoot, teamId, 'team-config.json');
    fs.mkdirSync(artifactRoot, { recursive: true });
    // The pinned image runs as its unprivileged pwuser. The evidence directory
    // is disposable and must be writable through the bind mount regardless of
    // the host user's numeric uid.
    fs.chmodSync(artifactRoot, 0o777);
    try {
        if (ownsTeam) {
            run('node', ['pcm-connectathon/scripts/bootstrap-local-team.js', '--team-id', teamId, '--teams-root', teamsRoot, '--port-index', String(args['port-index'] || 40), '--preset', 'connectathon-easy', ...(args['no-build'] ? ['--no-build'] : [])], { cwd: root, env: ownedBootstrapEnvironment() });
        }
        const config = readJson(configPath);
        const teamEnvFile = path.join(path.dirname(configPath), '.env');
        const teamEnv = fs.existsSync(teamEnvFile) ? fs.readFileSync(teamEnvFile, 'utf8') : '';
        const adminPassword = selectedAdminPassword(teamEnv);
        if (!adminPassword && (!args.grep || /Admin login|authenticated SMART/.test(args.grep))) {
            throw new Error('Missing required selected-team Admin authentication fixture');
        }
        browserCertificates = stageBrowserCertificates(path.join(path.dirname(configPath), 'certs'));
        run('docker', ['build', '--pull=false', '-t', IMAGE, 'pcm-connectathon/ui'], { cwd: root });
        const adminFixture = path.join(artifactRoot, 'admin-fixture.html');
        run('node', ['pcm-connectathon/ui/render-admin-fixture.js', adminFixture], { cwd: root });
        const fixtureFile = path.join(artifactRoot, 'fixture-facts.json');
        const configuredFixtureRoot = args['fixture-root'] || (fs.existsSync(path.join(path.dirname(configPath), 'bundles')) ? path.join(path.dirname(configPath), 'bundles') : undefined);
        const fixtureFacts = inspectTeamFixtures(config, configuredFixtureRoot, { noFixtureSetup: Boolean(args.workflows || args['hmo-journey'] || args['smart-addresses'] || args['no-fixture-setup']) });
        fs.writeFileSync(fixtureFile, JSON.stringify(fixtureFacts, null, 2));
        if (fixtureFacts.sources.some(source => source.state === 'failed')
            || (args['require-clinical'] && !fixtureFacts.patients.length)) throw new Error('selected clinical fixture is missing, replaced or unavailable');
        const dockerArgs = [
            'run', '--rm', '--init', '--network', 'host',
            '-e', `PCM_UI_SP_URL=${config.publicBaseUrls.spClient}`,
            '-e', `PCM_UI_PCM_URL=${config.publicBaseUrls.pcmUi}`,
            '-e', 'PCM_UI_ADMIN_PASSWORD',
            '-e', `PCM_UI_PRESET=${config.conformance.preset}`,
            '-e', `PCM_UI_CANDIDATE_042=${args['candidate-042'] ? 'true' : 'false'}`,
            '-e', `PCM_UI_DEPLOYMENT_IP=${args['browser-ip'] || ''}`,
            '-e', `PCM_UI_SMART_ADDRESSES=${args['smart-addresses'] ? 'true' : 'false'}`,
            '-e', `PCM_UI_SMART_IP=${args['browser-ip'] || ''}`,
            '-e', `PCM_UI_HMO_JOURNEY=${args['hmo-journey'] ? 'true' : 'false'}`,
            '-e', `PCM_UI_WORKFLOWS=${args.workflows ? 'true' : 'false'}`,
            '-e', `PCM_UI_WORKFLOW_PARTIAL=${args['workflow-partial'] ? 'true' : 'false'}`,
            '-e', 'PCM_UI_CERTS_DIR=/certs',
            '-e', 'PCM_UI_FIXTURE_FACTS=/fixture-facts.json',
            '-e', `PCM_UI_TEAM_ID=${config.teamId}`,
            // Existing owned beforeAll fixtures resolve the same read-only repository as supplemental jobs.
            '-e', 'PCM_NAV_REPO=/repo',
            '-v', `${root}:/repo:ro`,
            '-v', `${fixtureFile}:/fixture-facts.json:ro`,
            '-e', `PCM_UI_REQUIRE_CLINICAL=${args['require-clinical'] ? 'true' : 'false'}`,
            '-v', `${path.join(root, 'clinical-data/ci')}:/ci:ro`,
            '-v', `${path.join(root, 'src/shared/ui')}:/ui-assets:ro`,
            // Browser assertion fixtures use the same pure key-selection helper as the runtime.
            '-v', `${path.join(root, 'src/shared/assertion-keys.js')}:/src/shared/assertion-keys.js:ro`,
            // Both browser and Admin sanity clients consume this unchanged pure form helper.
            '-v', `${path.join(root, 'pcm-connectathon/scripts/sanity-data-state.js')}:/scripts/sanity-data-state.js:ro`,
            ...approvalModules.flatMap(file => ['-v', `${path.join(root, 'src/shared', file)}:/src/shared/${file}:ro`]),
            '-v', `${adminFixture}:/admin-fixture.html:ro`,
            '-v', `${browserCertificates.directory}:/certs:ro`,
            '-v', `${artifactRoot}:/artifacts`,
            IMAGE,
            '--config', 'playwright.config.js'
        ];
        if (args['smart-addresses']) dockerArgs.splice(dockerArgs.indexOf(IMAGE), 0, '--add-host', 'explicit-doctor-browser.test:127.0.0.1');
        if (args['hmo-journey']) dockerArgs.splice(dockerArgs.indexOf(IMAGE), 0, '--add-host', 'pcm-hmo-browser.test:127.0.0.1');
        if (args.workflows) {
            // Fabricated workflow inputs are read-only; browser tests mutate only the owned team's imports.
            dockerArgs.splice(dockerArgs.indexOf(IMAGE), 0, '-v', `${path.resolve(args['workflow-fixture-root'] || path.join(root, 'clinical-data/pcm-ig-040'))}:/workflow-fixtures:ro`);
        }
        if (args['project']) dockerArgs.push('--project', args.project);
        if (args.grep) dockerArgs.push('--grep', args.grep);
        if (args['max-failures']) dockerArgs.push('--max-failures', String(args['max-failures']));
        if (args['grep-invert']) dockerArgs.push('--grep-invert', args['grep-invert']);
        run('docker', dockerArgs, { cwd: root, env: { ...process.env, PCM_UI_ADMIN_PASSWORD: adminPassword } });
        const maintenanceSecrets = selectedMaintenanceSecrets(config, teamEnv);
        secretScan(artifactRoot, [...maintenanceSecrets, adminPassword]);
        console.log(JSON.stringify({ status: 'pass', image: `${BASE_IMAGE} + @playwright/test@1.62.1`, artifacts: artifactRoot }));
    } finally {
        try {
            browserCertificates?.cleanup();
        } finally {
            if (ownsTeam && !args['keep-team']) {
                try { run('node', ['pcm-connectathon/scripts/stop-local-team.js', '--team-id', teamId, '--teams-root', teamsRoot, '--volumes'], { cwd: root }); } catch (error) { console.error(`Scoped cleanup remains available: ${error.message}`); }
            }
        }
    }
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { BASE_IMAGE, IMAGE, main, secretScan, selectedMaintenanceSecrets, selectedAdminPassword, ownedBootstrapEnvironment };
