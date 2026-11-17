'use strict';
/** Actual writer -> normalized API/detail -> full authenticated-export fidelity. */
const test = require('node:test'), assert = require('node:assert/strict');
require('../../../test-support/team-config').installTestRuntime();
const { writeStructuredCorpus } = require('../../../test-support/log-structured-corpus');
const { createUiApp } = require('../src/index');
const { once } = require('node:events');

test('writer reader detail and export preserve token/snapshot and exclude AWS credentials', async t => {
    const corpus = writeStructuredCorpus(process.env.SHARED_LOGS_DIR);
    const app = createUiApp(), server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await app.locals.closeLogSearch(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base + '/api/unified-logs?page=true&order=timeline');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const page = await response.json(); assert.ok(page.bytesRead <= 1048576); assert.ok(page.entries.length <= 200);
    const row = page.entries.find(entry => entry.message === 'Opaque issuance fixture');
    assert.equal(row.details.issuanceRecord, undefined);
    const detail = await (await fetch(base + '/api/unified-logs/detail?reference=' + encodeURIComponent(row.reference))).json();
    assert.equal(detail.entry.details.access_token, corpus.token);
    assert.deepEqual(detail.entry.details.issuanceRecord, corpus.issuanceRecord);
    assert.deepEqual(JSON.parse(detail.raw), corpus.emitted.find(entry => entry.message === row.message));
    const exported = await fetch(base + '/admin/logs/download'); assert.equal(exported.status, 200);
    const text = await exported.text();
    assert.ok(text.includes(corpus.token)); assert.ok(text.includes('AWS_CREDENTIAL_BLOCKED'));
    assert.ok(!text.includes('owned-synthetic-aws-secret'));
    const exportBody = JSON.parse(text);
    const find = value => Array.isArray(value) ? value.find(item => item.message === row.message) || value.map(find).find(Boolean)
        : value && typeof value === 'object' ? (value.message === row.message ? value : Object.values(value).map(find).find(Boolean)) : undefined;
    const issued = find(exportBody); assert.ok(issued); assert.deepEqual(issued.details.issuanceRecord, corpus.issuanceRecord);
    const awsRow = page.entries.find(entry => entry.message === 'AWS excluded fixture');
    const awsDetail = await (await fetch(base + '/api/unified-logs/detail?reference=' + encodeURIComponent(awsRow.reference))).json();
    assert.equal(awsDetail.entry.details.issuanceRecord.AWS_SECRET_ACCESS_KEY, '[AWS_CREDENTIAL_BLOCKED]');
    assert.equal(awsDetail.entry.details.access_token, corpus.token);
});
