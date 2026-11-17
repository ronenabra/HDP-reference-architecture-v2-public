#!/usr/bin/env node
const path = require('path');
const { parseArgs, repoRoot } = require('../../scripts/lib');
const { rel, requireYes, run, terraform, terraformInit } = require('./deploy-lib');

const args = parseArgs(process.argv);
const positionalAction = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
const action = args.action || positionalAction || 'check';
const root = repoRoot();
const baselineDir = path.join(root, 'pcm-connectathon', 'aws', 'terraform', 'baseline');
const planPath = args.plan || '/tmp/pcm-connectathon-baseline.tfplan';
const baselineJsonPath = args['baseline-json'] || '/tmp/pcm-connectathon-baseline.json';
const dryRun = Boolean(args['dry-run']);

function init() {
    terraformInit(baselineDir, 'baseline', args, { dryRun });
}

function plan(extraArgs = []) {
    init();
    terraform(baselineDir, ['plan', ...extraArgs, '-out', planPath], { dryRun });
    console.log(`Plan saved to ${planPath}`);
}

function apply() {
    if (args['migrate-state']) {
        init();
        console.log('Baseline state backend migration complete. Run manage-baseline.js check/apply without --migrate-state for configuration changes.');
        return;
    }
    plan();
    terraform(baselineDir, ['apply', planPath], { dryRun });
}

function buildImages() {
    const json = terraform(baselineDir, ['output', '-raw', 'baseline_config_json'], { capture: true, dryRun });
    if (!dryRun) require('fs').writeFileSync(baselineJsonPath, json);
    console.log(`Wrote ${baselineJsonPath}`);
    run('bash', ['pcm-connectathon/aws/scripts/build-and-push-ecr.sh', '--aws-config', baselineJsonPath], {
        cwd: root,
        dryRun
    });
}

function destroy() {
    requireYes(args, 'baseline destroy');
    init();
    terraform(baselineDir, ['plan', '-destroy', '-out', planPath], { dryRun });
    console.log(`Destroy plan saved to ${planPath}`);
    terraform(baselineDir, ['apply', planPath], { dryRun });
}

switch (action) {
    case 'check':
        plan();
        break;
    case 'apply':
    case 'update':
    case 'create':
        apply();
        break;
    case 'build-images':
        buildImages();
        break;
    case 'destroy':
    case 'delete':
        destroy();
        break;
    default:
        throw new Error(`unknown action ${action}; use check, apply, build-images, or destroy`);
}

console.log(`Baseline action complete in ${rel(baselineDir)}`);
