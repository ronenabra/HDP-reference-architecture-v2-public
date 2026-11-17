'use strict';

/** Keep the operational export contract and offline bundled documentation aligned. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

test('Admin export source and bundled docs preserve completeness and preparation failures', () => {
    const yaml = fs.readFileSync(path.join(root, 'docs/openapi-admin.yaml'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'docs/admin-api-docs.html'), 'utf8');
    const serialized = html.match(/const __redoc_state = (.*);\n/);
    assert.ok(serialized, 'the existing pinned client renderer retains its bundled JSON state');
    const state = JSON.parse(serialized[1]);
    for (const endpoint of ['/admin/logs', '/admin/logs/download']) {
        const start = yaml.indexOf(`  ${endpoint}:\n`);
        assert.notEqual(start, -1);
        const end = yaml.indexOf('\n  /', start + 1);
        const block = yaml.slice(start, end === -1 ? undefined : end);
        const operation = state.spec.data.paths[endpoint].get;
        assert.equal(operation.description, block.match(/^      description: (.*)$/m)[1]);
        for (const status of ['200', '207', '409', '500']) {
            const description = block.match(new RegExp(`        "${status}":\\n          description: (.*)`));
            assert.ok(description, `${endpoint} documents HTTP ${status}`);
            assert.equal(operation.responses[status].description, description[1]);
        }
        assert.match(operation.responses['409'].description, /cleared during export preparation/);
        assert.match(operation.responses['500'].description, /No complete or partial export/);
    }
    assert.match(html, /Redoc\.init\(__redoc_state\.spec\.data, __redoc_state\.options, container\)/);
    assert.doesNotMatch(html, /Redoc\.hydrate/);
});

test('README preserves export semantics and links to the maintained API references', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const paragraph = readme.split('\n\n')
        .find(value => value.includes('HTTP 409') && value.includes('HTTP 207'));
    assert.ok(paragraph, 'the installation guide explains incomplete log downloads');
    assert.match(paragraph, /HTTP 207 reports\s+partial source failures/);
    assert.match(paragraph, /HTTP 409 reports a concurrent clear/);
    assert.match(paragraph, /Browse limits do not\s+truncate/);
    for (const name of ['docs/openapi-admin.yaml', 'docs/admin-api-docs.html', 'docs/api-docs.html']) {
        assert.ok(readme.includes(`](${name})`), name);
        assert.ok(fs.statSync(path.join(root, name)).isFile(), name);
    }
});
