#!/usr/bin/env node
'use strict';
/** Own the pinned running-UI walkthrough and its exact disposable source outages. */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { parseArgs, repoRoot, requireSafeTeamId } = require('../scripts/lib');
const { previewFixture } = require('./generate-preview-fixture');
const { selectedAdminPassword } = require('./run-playwright');
async function main(argv = process.argv) {
    const args = parseArgs(argv), root = repoRoot();
    const configPath = path.resolve(args['team-config'] || 'missing-team-config');
    const config = JSON.parse(fs.readFileSync(configPath)); requireSafeTeamId(config.teamId);
    if (args['disposable-team'] !== config.teamId) throw new Error('--disposable-team must explicitly name this owned team; the walkthrough mutates clinical fixtures and stops its HO A gateway');
    const originalConfig = path.join(path.dirname(configPath), 'ui-walkthrough-original.json');
    if (!fs.existsSync(originalConfig)) fs.writeFileSync(originalConfig, JSON.stringify(config, null, 2), { mode: 0o644 });
    const gateway = `${config.teamId}-ho-a-gateway-1`;
    const actualProject = execFileSync('docker', ['inspect', gateway, '--format', '{{index .Config.Labels "com.docker.compose.project"}}'], { encoding: 'utf8' }).trim();
    if (actualProject !== config.teamId) throw new Error('Gateway project ownership mismatch');
    const output = path.resolve(args.artifacts || `tmp/ui-walkthrough/${config.teamId}`);
    fs.mkdirSync(output, { recursive: true }); fs.chmodSync(output, 0o777);
    for (const file of fs.readdirSync(output)) if (/\.(request|done)$/.test(file)) fs.rmSync(path.join(output, file));
    const fixture = path.join(output, 'preview.source.transaction.json'); fs.writeFileSync(fixture, previewFixture()); fs.chmodSync(fixture, 0o444);
    const adminPassword = selectedAdminPassword(fs.readFileSync(path.join(path.dirname(configPath), '.env'), 'utf8'));
    if (!adminPassword) throw new Error('Missing required selected-team Admin authentication fixture');
    const image = args.image || 'pcm-connectathon-playwright:p0-ui-01';
    let stopped = false, handling = false, controlFailure;
    const gatewayId = execFileSync('docker', ['inspect', gateway, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
    const child = spawn('docker', ['run', '--rm', '--name', `${config.teamId}-ui-walkthrough`, '--init', '--network', 'host', '--entrypoint', 'node', '-e', 'PCM_UI_ADMIN_PASSWORD',
        '-v', `${path.join(__dirname, 'release-ui-walkthrough.js')}:/walkthrough.js:ro`, '-v', `${configPath}:/config.json:ro`, '-v', `${originalConfig}:/original.json:ro`,
        '-v', `${fixture}:/preview.source.transaction.json:ro`, '-v', `${path.join(root, 'clinical-data/ci')}:/ci:ro`, '-v', `${output}:/artifacts`, image, '/walkthrough.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, PCM_UI_ADMIN_PASSWORD: adminPassword } });
    const timer = setInterval(() => {
        if (handling) return;
        handling = true;
        try {
            for (const label of ['desktop', 'mobile']) for (const state of ['stop', 'start']) {
                const request = path.join(output, `${label}-${state}.request`), done = path.join(output, `${label}-${state}.done`);
                if (!fs.existsSync(request) || fs.existsSync(done)) continue;
                execFileSync('docker', [state, gatewayId], { stdio: 'ignore' }); stopped = state === 'stop'; fs.writeFileSync(done, state);
            }
        } catch (error) { controlFailure = error; child.kill('SIGTERM'); } finally { handling = false; }
    }, 100);
    try {
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        if (controlFailure) throw controlFailure;
        if (code !== 0) throw new Error(`Running UI walkthrough failed (${code}); preserve its private artifacts`);
    } finally { clearInterval(timer); if (stopped) execFileSync('docker', ['start', gatewayId], { stdio: 'ignore' }); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
