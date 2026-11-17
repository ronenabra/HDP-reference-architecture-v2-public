'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

test('network orchestration retries only a rejected cached bearer credential', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'pcm-introspection-client.js'), 'utf8');
    assert.match(source, /const attempts = this\.authMode === 'bearer' \? 2 : 1/);
    assert.match(source, /\[401, 403\]\.includes\(error\.response\?\.status\)/);
    assert.match(source, /this\.credentialCache\.clear\(/);
    assert.doesNotMatch(source, /catch \([^)]*\) \{\s*return \{ active: true/);
});

test('adapter applies source simulation and relays full non-AWS FHIR traffic for logging', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    assert.match(source, /const DEFAULT_OUTBOUND_TIMEOUT_MS = 10000/);
    assert.match(source, /rejectUnauthorized: bindings\.verifyServerCertificate !== false/);
    assert.match(source, /timeout: fixedBindings\.timeout/);
    assert.match(source, /headers: request\.headers/);
    assert.match(source, /body: response\.data/);
    assert.match(source, /\/fhir-proxy/);
    assert.match(source, /X-PCM-Request-URI/);
    assert.match(source, /currentEffectivePolicy\(\)/);
});

test('SMART discovery fails closed instead of inventing endpoint fallbacks', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    assert.match(source, /PCM SMART configuration is malformed/);
    assert.match(source, /PCM SMART endpoints do not match the configured issuer/);
    assert.doesNotMatch(source, /Discovery Failed[\s\S]*Fallback/);
});
