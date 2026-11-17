'use strict';

/** Publication retains finite test inputs while external standards stay external. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { eligible } = require('../../scripts/public-release');
const policy = require('../../docs/public-release-scope.json');
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '../..');

test('archived run payloads stay outside public selection', () => {
    assert.equal(policy.includeCompressedFixtures.length, 0);
    for (const file of policy.includeCompressedFixtures) assert.equal(eligible(file, policy), true, file);
    for (const file of ['test-support/fixtures/unreviewed.tar.gz', 'src/logs/archive.gz',
        'certs/rootCA.key', 'teams/one/.env', 'vendor/pcm-ig/0.4.2/input/fsh/profile.fsh',
        'docs/openapi.yaml', 'docs/pcm_process_flow.md', 'docs/FHIR-examples/Patient-example.json']) {
        assert.equal(eligible(file, policy), false, file);
    }
    const altered = structuredClone(policy);
    altered.includeCompressedFixtures.push('certs/archive.gz', 'src/logs/archive.gz', 'test-support/fixtures/secret.key');
    for (const file of altered.includeCompressedFixtures.slice(-3)) assert.equal(eligible(file, altered), false, file);
});

test('public API page links upstream while the Admin API generator keeps local ownership', () => {
    const fs = require('node:fs'), path = require('node:path'), root = path.resolve(__dirname, '../..');
    const page = fs.readFileSync(path.join(root, 'docs/api-docs.html'), 'utf8');
    assert.match(page, /github\.com\/MohGovIL\/Swagger/);
    assert.doesNotMatch(page, /__redoc_state|Redoc\.hydrate|Redoc\.init/);
    const generator = fs.readFileSync(path.join(root, 'scripts/generate-api-docs.js'), 'utf8');
    assert.match(generator, /openapi-admin\.yaml/);
    assert.doesNotMatch(generator, /\['openapi\.yaml', 'api-docs\.html'\]/);
});

test('ARCH-001 architecture keeps PCM JWKS private and Data Source enforcement fail closed', () => {
    const architecture = fs.readFileSync(path.join(repoRoot, 'system-architecture.md'), 'utf8');
    assert.match(architecture, /PCM exposes no public JWKS/);
    assert.match(architecture, /independently granted scopes form a union/);
    assert.match(architecture, /Unsupported\s+advanced\s+expressions fail closed/);
    assert.doesNotMatch(architecture, /scope enforcement is intentionally (?:omitted|incomplete)/i);
});

test('candidate browser acceptance requires every exact case on both devices', () => {
    const coverage = require('../scripts/full-coverage');
    const skipped = { suites: [{ specs: [{ title: 'candidate 0.4.2 SSO is independent of OTP', tests: [{ projectName: 'chromium-desktop', results: [{ status: 'skipped' }] }] }] }] };
    assert.equal(coverage.candidateRequiredScenarios().length, 10);
    assert.ok(coverage.candidateBrowserScenarios(skipped).every(row => row.executed === false));
    const passed = structuredClone(skipped); passed.suites[0].specs[0].tests[0].results[0].status = 'passed';
    const rows = coverage.candidateBrowserScenarios(passed);
    assert.equal(rows.find(row => row.id === 'browser-042-sso-desktop').executed, true);
    assert.equal(rows.find(row => row.id === 'browser-042-sso-mobile').executed, false);
});
