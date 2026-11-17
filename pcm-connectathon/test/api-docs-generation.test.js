'use strict';

/** The maintained renderer must not hydrate browser-normalized prerender markup. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { clientRenderedDocument } = require('../../scripts/generate-api-docs');

test('client rendering preserves the bundled specification and navigation initialization', () => {
    const serialized = JSON.stringify({ spec: { data: { info: { title: 'Test' }, paths: { '/test': {} } } }, options: {} });
    const input = `<html><head>pinned script</head><body>      <div id="redoc"><p>static<div>normalized</div></p></div>\n      <script>const __redoc_state = ${serialized}; var container = document.getElementById('redoc'); Redoc.hydrate(__redoc_state, container);</script></body></html>`;
    const output = clientRenderedDocument(input);
    assert.ok(output.includes(serialized));
    assert.match(output, /<div id="redoc"><\/div>/);
    assert.match(output, /Redoc.init\(__redoc_state.spec.data, __redoc_state.options, container\)/);
    assert.doesNotMatch(output, /hydrate|normalized/);
});

test('unexpected generator output fails visibly instead of emitting broken pages', () => {
    assert.throws(() => clientRenderedDocument('<html>new upstream template</html>'), /output structure changed/);
});
