#!/usr/bin/env node
'use strict';

/** Prepare, but never execute, an explicitly authorized staging validation. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, repoRoot } = require('./lib');

const NOT_RUN = 'NOT RUN — CREDENTIALS/AUTHORITY NOT SUPPLIED';
const NON_PRODUCTION_MARKERS = ['staging', 'sandbox', 'preprod', 'nonprod', '.test'];

/** Classify and fail closed on an operator-supplied staging origin. */
function classifyStagingOrigin(value) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch (error) {
        throw new Error(`staging origin is not an absolute URL: ${value}`);
    }
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:') throw new Error(`staging origin must use HTTPS: ${value}`);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`staging origin must not contain credentials, query, or fragment: ${value}`);
    if (['localhost', '127.0.0.1', '::1'].includes(host) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
        throw new Error(`staging origin must not be a local/private address: ${value}`);
    }
    if (host.endsWith('.amazonaws.com') || host.endsWith('.aws')) {
        throw new Error(`staging origin must not be an AWS control-plane or generated service host: ${value}`);
    }
    if (!NON_PRODUCTION_MARKERS.some(marker => host.includes(marker))) {
        throw new Error(`staging origin is not explicitly non-production: ${value}`);
    }
    return { origin: parsed.origin, host, classification: 'explicit-non-production' };
}

/** Produce separate non-mutating and mutation-gated tester command vectors. */
function commandPlan(configPath, reportRoot, testerRoot) {
    if (!testerRoot) throw new TypeError('an explicit standalone tester root is required');
    const resolvedTesterRoot = path.resolve(testerRoot);
    const python = path.join(resolvedTesterRoot, '.venv', 'bin', 'python');
    const base = [python, '-m', 'pcm_tester', '--config', configPath, '--strict'];
    return {
        environment: { PYTHONPATH: resolvedTesterRoot },
        nonMutating: [...base, '--skip-tags', 'lifecycle,destructive,operator', '--out', path.join(reportRoot, 'non-mutating')],
        mutating: [
            ...base,
            '--tags', 'lifecycle',
            '--enable-mutating-staging',
            '--external-authority-reference', '<REQUIRED-EXTERNAL-AUTHORITY-REFERENCE>',
            '--out', path.join(reportRoot, 'mutating')
        ]
    };
}

function main(argv = process.argv) {
    const args = parseArgs(argv);
    if (!args.config || !args['pcm-origin'] || !args['data-source-origins'] || !args['tester-root']) {
        throw new Error('--config, --pcm-origin, --data-source-origins, and --tester-root are required');
    }
    const configPath = path.resolve(args.config);
    if (!fs.existsSync(configPath)) throw new Error(`staging config does not exist: ${configPath}`);
    const origins = [args['pcm-origin'], ...String(args['data-source-origins']).split(',').filter(Boolean)];
    if (origins.length !== 4) throw new Error('exactly three comma-separated Data Source origins are required');
    const targets = origins.map(classifyStagingOrigin);
    const configSha256 = crypto.createHash('sha256').update(fs.readFileSync(configPath)).digest('hex');
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot(), encoding: 'utf8' });
    if (commit.status !== 0) throw new Error(commit.stderr || 'could not resolve candidate commit');
    const reportRoot = path.resolve(args['report-root'] || 'reports/staging-prepared');
    const prepared = {
        status: NOT_RUN,
        executionAuthorized: false,
        awsCalls: 0,
        remoteStateAccess: false,
        candidateCommit: commit.stdout.trim(),
        configPath,
        configSha256,
        targets,
        phases: commandPlan(configPath, reportRoot, args['tester-root']),
        instructions: 'Obtain separate credentials and written authority in a later task. Run non-mutating first; review it before explicitly authorizing mutation.'
    };
    const output = `${JSON.stringify(prepared, null, 2)}\n`;
    if (args.output) {
        const destination = path.resolve(args.output);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, output);
    }
    process.stdout.write(output);
    return prepared;
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}

module.exports = { NOT_RUN, classifyStagingOrigin, commandPlan, main };
