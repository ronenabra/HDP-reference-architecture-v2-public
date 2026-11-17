#!/usr/bin/env node
'use strict';

/** Pin and discover all six existing required browser modes before any live team is created/restored. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { parseArgs, repoRoot } = require('./lib');
const { plans, admit } = require('./browser-phase-admission');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Build one pinned image and collect only actual --list output; no runtime/fixture beforeAll hook runs. */
function discover(root, output, image) {
    assert.ok(!fs.existsSync(output), 'refusing to replace required browser discovery');
    fs.mkdirSync(output, { recursive: true, mode: 0o700 }); fs.chmodSync(output, 0o700);
    const command = (name, args) => {
        const file = path.join(output, name + '.log'), fd = fs.openSync(file, 'wx', 0o600);
        let result; try { result = spawnSync('docker', args, { cwd: root, stdio: ['ignore', fd, fd] }); } finally { fs.closeSync(fd); }
        assert.equal(result.status, 0, `required browser ${name} failed; log retained`);
    };
    command('build', ['build', '--pull=false', '-t', image, 'pcm-connectathon/ui']);
    const imageId = execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
    const phases = [];
    for (const plan of plans) {
        const artifacts = path.join(output, plan.name); fs.mkdirSync(artifacts); fs.chmodSync(artifacts, 0o777);
        const mounts = [`${root}:/repo:ro`, `${root}/src/shared/ui:/ui-assets:ro`, `${root}/src/shared/assertion-keys.js:/src/shared/assertion-keys.js:ro`,
            `${root}/pcm-connectathon/scripts/sanity-data-state.js:/scripts/sanity-data-state.js:ro`, `${root}/clinical-data/ci:/ci:ro`, `${artifacts}:/artifacts`,
            ...require('../ui/approval-modules.json').map(file => `${root}/src/shared/${file}:/src/shared/${file}:ro`)];
        const args = ['run', '--rm', '--init', '--network', 'none', '-e', 'PCM_NAV_REPO=/repo', '-e', 'PCM_UI_SP_URL=http://127.0.0.1:1', '-e', 'PCM_UI_PCM_URL=http://127.0.0.1:1',
            '-e', `PCM_UI_WORKFLOWS=${Boolean(plan.workflow)}`, '-e', `PCM_UI_CANDIDATE_042=${Boolean(plan.candidate)}`, '-e', `PCM_UI_WORKFLOW_PARTIAL=${Boolean(plan.partial)}`,
            ...mounts.flatMap(mount => ['-v', mount]), image, '--config', 'playwright.config.js', '--list'];
        if (plan.grep) args.push('--grep', plan.grep);
        if (plan.grepInvert) args.push('--grep-invert', plan.grepInvert);
        command(plan.name, args);
        const file = path.join(artifacts, 'results.json'), report = JSON.parse(fs.readFileSync(file));
        assert.equal(report.config.version, require('../ui/package.json').dependencies['@playwright/test']);
        phases.push({ ...admit(plan.name, report, true), report: { path: path.relative(root, file), sha256: digest(file) }, command: ['docker', ...args] });
    }
    assert.ok(phases.find(phase => phase.phase === 'main').required.some(row => row.id === 'browser-batch38-current-owners' && row.discovered),
        'required current batch integration browser case was not discovered');
    const result = { schemaVersion: 'pcm-required-browser-discovery/1', image, imageId, phases,
        sourceBindings: Object.fromEntries(['pcm-connectathon/ui/Dockerfile', 'pcm-connectathon/ui/package-lock.json', 'pcm-connectathon/ui/playwright.config.js', 'pcm-connectathon/scripts/browser-phase-admission.js', 'pcm-connectathon/scripts/discover-required-browser.js', 'pcm-connectathon/scripts/full-coverage.js', 'pcm-connectathon/ui/approval-modules.json', 'pcm-connectathon/scripts/sanity-data-state.js',
            ...require('../ui/approval-modules.json').map(file => `src/shared/${file}`),
            ...fs.readdirSync(path.join(root, 'pcm-connectathon/ui/tests/helpers')).filter(file => file.endsWith('.js')).map(file => `pcm-connectathon/ui/tests/helpers/${file}`),
            ...['approval-scope-fixture', 'consent-snapshot-fixture', 'services-fixture', 'team-config', 'certificates'].map(file => `test-support/${file}.js`),
            ...fs.readdirSync(path.join(root, 'pcm-connectathon/ui/tests')).filter(file => file.endsWith('.spec.js')).map(file => `pcm-connectathon/ui/tests/${file}`),
            ...fs.readdirSync(path.join(root, 'pcm-connectathon/ui/workflow-tests')).filter(file => file.endsWith('.js')).map(file => `pcm-connectathon/ui/workflow-tests/${file}`)]
            .map(file => [file, digest(path.join(root, file))])) };
    fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); return result;
}
if (require.main === module) { const args = parseArgs(process.argv); try { assert.ok(args.output && args.image); discover(repoRoot(), path.resolve(args.output), args.image); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { discover };
