#!/usr/bin/env node
'use strict';

/** Validate Terraform modules without a backend, state, plan, or cloud call. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, repoRoot } = require('../../scripts/lib');
const { LOCAL_ONLY_ENV, run } = require('./deploy-lib');

function moduleFiles(source) {
    return fs.readdirSync(source)
        .filter(name => name.endsWith('.tf') || name === '.terraform.lock.hcl')
        .sort();
}

function localProviderDirectory(source) {
    const providerMirror = path.join(
        source,
        '.terraform',
        'providers'
    );
    const platformDirectory = path.join(
        providerMirror,
        'registry.terraform.io',
        'hashicorp',
        'aws',
        '5.100.0',
        'linux_amd64'
    );
    if (!fs.existsSync(platformDirectory)) {
        throw new Error(`offline AWS provider cache is missing: ${platformDirectory}`);
    }
    return providerMirror;
}

function validateModule(name, options = {}) {
    const source = path.join(repoRoot(), 'pcm-connectathon', 'aws', 'terraform', name);
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `pcm-terraform-${name}-`));
    try {
        for (const fileName of moduleFiles(source)) {
            fs.copyFileSync(path.join(source, fileName), path.join(temporaryRoot, fileName));
        }
        // Planning prints commands without depending on an operator's private cache.
        const providerDirectory = options.dryRun
            ? path.join(source, '.terraform', 'providers')
            : localProviderDirectory(source);
        const env = {
            ...process.env,
            [LOCAL_ONLY_ENV]: 'true',
            TF_IN_AUTOMATION: '1',
            CHECKPOINT_DISABLE: '1'
        };
        run('terraform', [`-chdir=${temporaryRoot}`, 'fmt', '-check', '-recursive'], { env, dryRun: options.dryRun });
        run('terraform', [`-chdir=${temporaryRoot}`, 'init', '-backend=false', '-input=false', `-plugin-dir=${providerDirectory}`], { env, dryRun: options.dryRun });
        run('terraform', [`-chdir=${temporaryRoot}`, 'validate'], { env, dryRun: options.dryRun });
        return { module: name, sourceFiles: moduleFiles(source), status: options.dryRun ? 'planned' : 'pass' };
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

function main(argv = process.argv.slice(2)) {
    const args = parseArgs(['node', 'validate-terraform-offline.js', ...argv]);
    const results = ['baseline', 'team'].map(name => validateModule(name, { dryRun: Boolean(args['dry-run']) }));
    console.log(JSON.stringify({ mode: 'local-only', backend: false, cloudCalls: 0, results }, null, 2));
}

if (require.main === module) main();

module.exports = { localProviderDirectory, main, moduleFiles, validateModule };
