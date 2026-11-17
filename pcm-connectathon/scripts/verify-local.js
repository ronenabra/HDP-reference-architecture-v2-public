#!/usr/bin/env node
'use strict';

/** Required fast local verification gate with machine-readable sub-gate output. */

const { spawnSync } = require('child_process');
const path = require('path');
const { parseArgs, repoRoot } = require('./lib');

const REQUIRED_GATES = Object.freeze([
    { id: 'javascript', command: 'npm', args: ['test'] },
    { id: 'hapi-maven', command: './mvnw', args: ['--batch-mode', '--no-transfer-progress', 'test'], cwd: 'src/ho-fhir-server' },
    { id: 'pcm-ig-drift', command: 'npm', args: ['run', 'check:pcm-ig'] },
    { id: 'team-schema', command: 'node', args: ['pcm-connectathon/scripts/validate-team-config.js', '--config', 'pcm-connectathon/example-team-config.json'] },
    { id: 'descriptor-schema', command: 'node', args: ['pcm-connectathon/scripts/validate-sut-descriptor.js', '--input', 'pcm-connectathon/sut-descriptor.example.json'] },
    { id: 'openapi', command: 'npx', args: ['--no-install', 'redocly', 'lint', 'docs/openapi.yaml', 'docs/openapi-admin.yaml'] },
    { id: 'compose', command: 'docker', args: ['compose', '-f', 'docker-compose.yml', '-f', 'pcm-connectathon/compose.ho.yaml', '--env-file', 'pcm-connectathon/example.env', 'config', '--quiet'] },
    { id: 'references', command: 'node', args: ['pcm-connectathon/scripts/check-maintained-docs.js'] }
]);

function runGate(gate, root, dryRun = false) {
    const started = Date.now();
    if (dryRun) return { id: gate.id, status: 'planned', durationMilliseconds: 0, command: [gate.command, ...gate.args] };
    const result = spawnSync(gate.command, gate.args, { cwd: path.join(root, gate.cwd || '.'), stdio: 'inherit' });
    return { id: gate.id, status: result.status === 0 ? 'pass' : 'fail', exitCode: result.status ?? 1, durationMilliseconds: Date.now() - started };
}

function main(argv = process.argv) {
    const args = parseArgs(argv);
    const root = repoRoot();
    const results = [];
    for (const gate of REQUIRED_GATES) {
        const result = runGate(gate, root, Boolean(args['dry-run']));
        results.push(result);
        if (result.status === 'fail' && !args['keep-going']) break;
    }
    const completed = results.filter(result => ['pass', 'fail'].includes(result.status)).length;
    const summary = {
        schemaVersion: 'pcm-fast-gate/1',
        required: REQUIRED_GATES.map(gate => gate.id),
        results,
        status: args['dry-run'] ? 'planned' : (completed === REQUIRED_GATES.length && results.every(result => result.status === 'pass') ? 'pass' : 'fail')
    };
    console.log(`PCM_GATE_SUMMARY=${JSON.stringify(summary)}`);
    if (summary.status === 'fail') process.exitCode = 1;
    return summary;
}

if (require.main === module) main();

module.exports = { REQUIRED_GATES, main, runGate };
