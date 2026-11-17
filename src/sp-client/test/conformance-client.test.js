'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { clientConformanceInfo } = require('../src/oauth');

test('SP-001 conformance policy labels strict and connectathon results from the same client library', () => {
    const strict = clientConformanceInfo({
        version: 'pcm-sandbox-policy/1', mode: 'strict', resultLabel: 'STRICT SANDBOX',
        compatibility: { warnings: [] }
    });
    const compatibility = clientConformanceInfo({
        version: 'pcm-sandbox-policy/1', mode: 'connectathon', resultLabel: 'CONNECTATHON COMPATIBILITY',
        compatibility: { warnings: ['named adapter active'] }
    });
    assert.deepEqual(strict.warnings, []);
    assert.equal(strict.resultLabel, 'STRICT SANDBOX');
    assert.equal(compatibility.resultLabel, 'CONNECTATHON COMPATIBILITY');
    assert.deepEqual(compatibility.warnings, ['named adapter active']);
});

test('SP-001 UI and headless exports use the same client module protocol paths', () => {
    const indexSource = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
    assert.match(indexSource, /beginSmartAuthorization/);
    assert.match(indexSource, /exchangeSmartAuthorization/);
    assert.match(indexSource, /requestCatalogUpdate/);
    const client = require('../src/client');
    for (const name of ['beginSmartAuthorization', 'exchangeSmartAuthorization', 'requestCatalogUpdate', 'fetchAllSources']) {
        assert.equal(typeof client[name], 'function');
    }
});
