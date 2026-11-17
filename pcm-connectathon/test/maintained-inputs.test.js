'use strict';

/** Build and test inputs must remain available without generated evidence payloads. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { eligible } = require('../../scripts/public-release');
const root = path.resolve(__dirname, '../..');
const evidence = 'docs/implementation-evidence/';

/** Traverse maintained source roots without generated dependencies or build output. */
function sourceFiles(directory) {
    const excluded = new Set(['.git', 'node_modules', 'target', '__pycache__', 'test-results', 'playwright-report']);
    return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
        if (excluded.has(entry.name) || entry.isSymbolicLink()) return [];
        const name = `${directory}/${entry.name}`;
        return entry.isDirectory() ? sourceFiles(name) : [name];
    });
}

/** Remove only known historical path-classification expressions, never file reads. */
function dependencies(source) {
    return source.split('\n').flatMap((line, index) => {
        const remaining = line.replace(/name\.startsWith\('docs\/implementation-evidence\/[^']*'\)/g, 'false');
        return remaining.includes(evidence) ? [index + 1] : [];
    });
}

test('maintained executable sources have no generated evidence input dependencies', () => {
    const names = ['scripts', 'src', 'pcm-connectathon', 'test-support', 'clinical-data', 'tests'].flatMap(sourceFiles);
    const findings = names.filter(name => /\.(?:[cm]?js|py|sh|ya?ml)$/.test(name))
        .filter(name => name !== 'pcm-connectathon/test/maintained-inputs.test.js')
        .flatMap(name => dependencies(fs.readFileSync(path.join(root, name), 'utf8')).map(line => `${name}:${line}`));
    assert.deepEqual(findings, [], 'Move required input bytes into maintained fixtures or build sources');
    const policy = JSON.parse(fs.readFileSync(path.join(root, 'docs/public-release-scope.json')));
    const manifest = 'docs/external-contract-inputs.json';
    assert.ok(fs.statSync(path.join(root, manifest)).isFile());
    assert.equal(eligible(manifest, policy), true, 'Public input lock must survive export');
    assert.ok(!JSON.stringify(policy.includeFiles).includes(evidence));
});

test('input audit rejects direct reads/imports while retaining historical path policy checks', () => {
    for (const expression of [
        `require('../../${evidence}fixture.json');`,
        `fs.readFileSync(path.join(root, '${evidence}fixture.json'));`,
        `const input = '${evidence}fixture.json';`
    ]) assert.deepEqual(dependencies(expression), [1]);
    assert.deepEqual(dependencies(`const benign = name => name.startsWith('${evidence}');`), []);
    assert.deepEqual(dependencies(`name.startsWith('${evidence}'); fs.readFileSync('${evidence}fixture.json');`), [1]);
});
