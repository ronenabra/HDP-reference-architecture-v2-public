'use strict';
/** Faithful permission wording, non-secret metadata and real optional form defaults. */
const test = require('node:test'), assert = require('node:assert/strict'), ejs = require('ejs'), fs = require('node:fs'), path = require('node:path');
const { describeScopes } = require('../src/smart-presentation');
test('wildcards, exact actions, unknown syntax and filtered requests retain their actual meaning', () => {
    const entries = describeScopes(['patient/*.rs', 'patient/Condition.r', 'patient/Observation.rs?date=ge2026-01-01', 'unknown']);
    assert.match(entries[0].label, /read and search all FHIR resource types/);
    assert.match(entries[1].label, /^read Condition/); assert.doesNotMatch(entries[1].label, /search/);
    assert.match(entries[2].label, /exact constraints/); assert.equal(entries[2].scope, 'patient/Observation.rs?date=ge2026-01-01');
    assert.equal(entries[3].label, 'Protocol permission: unknown');
});
test('actual authorization template keeps checked scope defaults inside optional details and never auto-selects fixtures', () => {
    const scopes = ['patient/*.rs'], template = fs.readFileSync(path.join(__dirname, '../src/views/authorize.ejs'), 'utf8');
    const html = ejs.render(template, { teamId: 'unit', clientName: 'Registered test app', transactionId: 'private-test-handle', scopes, permissions: describeScopes(scopes), patients: [{ subject: 'configured-patient-1', display: 'Explicit fixture' }], selfChanged: false, technical: { clientId: 'client', callback: 'https://doctor.test/callback', audience: 'https://pcm.test/r4' } });
    assert.match(html, /Requested application permissions/); assert.doesNotMatch(html, /Approved scope/);
    assert.match(html, /name="approved_scope" value="patient\/\*\.rs" checked/);
    assert.match(html, /data-smart-approve[^>]*disabled/); assert.doesNotMatch(html, /value="configured-patient-1" checked/);
    assert.match(html, /registered callback|Registered callback/); assert.doesNotMatch(html, /code_verifier|access_token|PRIVATE KEY/);
    assert.match(html, /name="decision" value="cancel"/); assert.match(html, /name="decision" value="deny"/);
});
