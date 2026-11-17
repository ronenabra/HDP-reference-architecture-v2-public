'use strict';
/** Verify bounded query evidence independently of upstream continuation trust. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { combinePreview, failureEvidence } = require('../src/clinical-preview');
const bundle = (count, extra = {}) => ({ resourceType: 'Bundle', type: 'searchset',
    entry: Array.from({ length: count }, (_, id) => ({ resource: { resourceType: 'Observation', id: String(id) } })), ...extra });
test('more than ten records and multiple types remain independently bounded with private next evidence', () => {
    const next = 'https://untrusted.invalid/?credential=private-continuation';
    const result = combinePreview([{ type: 'Observation', bundle: bundle(14, { total: 14, link: [{ relation: 'next', url: next }] }) },
        { type: 'Condition', bundle: { entry: [{ resource: { resourceType: 'Condition' } }], total: 1 } }], 'source-a');
    assert.equal(result.entry.length, 11);
    assert.equal(result.preview.outcome, 'bounded');
    assert.equal(result.preview.types[0].next, next);
    assert.equal(result.preview.types[1].boundary, 'complete');
    assert.doesNotMatch(JSON.stringify(result), /credential|untrusted/);
});
test('successful empty, unknown and known completed query outcomes stay distinct', () => {
    for (const [count, extra, outcome, boundary] of [[0, {}, 'empty', 'unknown'], [2, {}, 'unknown', 'unknown'],
        [2, { total: 2 }, 'complete', 'complete'], [0, { total: 0 }, 'empty', 'complete']]) {
        const result = combinePreview([{ type: 'Observation', bundle: bundle(count, extra) }], 'a');
        assert.equal(result.preview.outcome, outcome);
        assert.equal(result.preview.types[0].boundary, boundary);
    }
});
test('denial and unavailable types produce a partial result with bounded successful records', () => {
    const failures = [failureEvidence('Condition', { response: { status: 403 }, message: 'Scope denied' }),
        failureEvidence('Procedure', { message: 'Source timeout' })];
    const result = combinePreview([{ type: 'Observation', bundle: bundle(1) }], 'a', failures);
    assert.equal(result.preview.outcome, 'partial');
    assert.deepEqual(failures.map(value => value.outcome), ['denied', 'unavailable']);
});

test('labelled compatibility singleton responses retain their one resource without a completion claim', () => {
    const result = combinePreview([{ type: 'Observation', bundle: { resourceType: 'Observation', id: 'legacy-one' } }], 'legacy');
    assert.equal(result.entry[0].resource.id, 'legacy-one');
    assert.equal(result.preview.outcome, 'unknown');
});

test('OAuth invalid-grant and scope refusals remain denials even when transported as HTTP400', () => {
    for (const error of ['invalid_grant', 'access_denied', 'invalid_scope', 'insufficient_scope', 'invalid_authorization_details']) {
        assert.equal(failureEvidence('Observation', { response: { status: 400, data: { error } }, message: error }).outcome, 'denied');
    }
    assert.equal(failureEvidence('Observation', { response: { status: 400, data: { error: 'invalid_request' } }, message: 'Malformed request' }).outcome, 'unavailable');
});
