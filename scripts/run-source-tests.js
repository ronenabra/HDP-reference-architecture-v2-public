#!/usr/bin/env node
'use strict';

/** Run the unchanged source/workspace suites with one explicitly owned fresh TLS fixture. */
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { generateCertificates } = require('../test-support/certificates');

/** Execute every required source suite, retaining nonzero status and cleaning only our fixture. */
function main(selected = process.argv.slice(2)) {
    const root = path.resolve(__dirname, '..'), fixture = generateCertificates();
    const env = { ...process.env, PCM_TEST_CERTIFICATES: fixture.directory };
    try {
        const tests = selected.length ? selected : ['clinical-data/test', 'pcm-connectathon/test'].flatMap(directory => fs.readdirSync(path.join(root, directory))
            .filter(name => name.endsWith('.test.js')).sort().map(name => path.join(directory, name)));
        const focused = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, env, stdio: 'inherit' });
        if (focused.error || focused.status !== 0) return focused.status || 1;
        if (selected.length) return 0;
        const workspaces = spawnSync('npm', ['test', '--workspaces'], { cwd: root, env, stdio: 'inherit' });
        return workspaces.status ?? 1;
    } finally { fixture.cleanup(); }
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
