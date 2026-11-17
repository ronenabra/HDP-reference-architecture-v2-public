#!/usr/bin/env node
'use strict';

/** Guard current operator documentation against known post-extraction drift. */

const fs = require('fs');
const path = require('path');
const { repoRoot } = require('./lib');

const root = repoRoot();
const files = ['README.md', 'pcm-connectathon/README.md', 'docs/local-release-runbook.md'];
const errors = [];
for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (/\/home\/vasya\/code\/PCM-Tester/.test(text)) errors.push(`${file} contains a machine-specific tester path`);
    if (!/bootstrap-local-team\.js/.test(text)) errors.push(`${file} does not name the canonical bootstrap`);
}
for (const file of ['src/pcm-core/src/views/consent.ejs', 'src/pcm-core/src/views/dashboard.ejs', 'src/pcm-core/src/views/logs.ejs', 'src/sp-client/src/views/index.ejs', 'src/sp-client/src/views/logs.ejs', 'src/sp-client/src/views/manage.ejs']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (/cdn\.jsdelivr\.net/.test(text)) errors.push(`${file} depends on a public CDN`);
}
if (errors.length) throw new Error(errors.join('; '));
console.log(JSON.stringify({ status: 'pass', files: files.length }));
