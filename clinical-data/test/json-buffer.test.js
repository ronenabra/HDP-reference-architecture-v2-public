'use strict';

/** Verify large-JSON decoding with small fixtures that exercise chunk and token boundaries. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { collapseJsonWhitespace, parseJsonBuffer } = require('../json-buffer');

test('large-buffer path preserves Unicode, escaping and whitespace inside strings', () => {
    const value = { text: 'שלום 😀  \t\n "quoted" \\ suffix', values: [true, null, -1.2e3], nested: { id: 'patient' } };
    const buffer = Buffer.from(JSON.stringify(value, null, 12));
    assert.deepEqual(parseJsonBuffer(buffer, 8), value);
    for (const size of [1, 2, 3, 7, 31]) assert.deepEqual(JSON.parse(collapseJsonWhitespace(buffer, size)), value);
    assert.deepEqual(parseJsonBuffer(buffer), value);
});

test('compaction retains token separators so malformed JSON cannot become valid', () => {
    for (const text of ['[1  2]', '[tr\n ue]', '"raw\nnewline"', '{"x":', '[1,]']) {
        assert.throws(() => parseJsonBuffer(Buffer.from(text), 1), SyntaxError);
    }
});

test('JSON inspection leaves original input bytes unchanged', () => {
    const buffer = Buffer.from(' {   "a":   [1,  2]  }\n');
    const original = Buffer.from(buffer);
    assert.deepEqual(parseJsonBuffer(buffer, 1), { a: [1, 2] });
    assert.deepEqual(buffer, original);
});
