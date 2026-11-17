'use strict';
/** Finite auxiliary render/error/recovery checks; no private PCM authority substitute. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), ejs = require('ejs');
const { render } = require('../../../test-support/doctor-ux-render');
const { startAuxiliaryFixture } = require('../../../test-support/auxiliary-ui-fixture');

test('management renders exact long identities, empty/error states and escaped editable data', () => {
    const template = fs.readFileSync(path.resolve(__dirname, '../src/views/manage.ejs'), 'utf8');
    const renderManage = extra => ejs.render(template, { browserBase: '/mount/doctor', identity: 'id/with & spaces', teamId: '<team>',
        publicBaseUrls: { pcmUi: '/mount/pcm' }, identities: [{ id: 'id/with & spaces', label: 'Application'.repeat(60) }],
        orgs: [], endpoints: [], flash: null, ...extra });
    const empty = renderManage(); assert.match(empty, /No organization records returned/); assert.match(empty, /id%2Fwith%20%26%20spaces/); assert.match(empty, /&lt;team&gt;/);
    const html = renderManage({ orgs: [{ id: 'org', name: '</strong><script>bad()</script>' }], endpoints: [{ id: 'endpoint-' + '0'.repeat(55), address: 'https://source.test/' + 'long/'.repeat(80), status: 'suspended' }], flash: { type: 'error', message: '<error>' }, draft: { kind: 'endpoint', id: 'endpoint-' + '0'.repeat(55), jsonContent: '</textarea><script>bad()</script>' } });
    assert.doesNotMatch(html, /<script>bad\(\)<\/script>/); assert.match(html, /&lt;\/textarea&gt;/); assert.match(html, /aria-invalid="true" aria-describedby="manage-feedback"/);
    assert.match(html, /role="alert" id="manage-feedback"/); assert.equal((html.match(/class="explain-toggle"/g) || []).length, 1);
    assert.doesNotMatch(html, /Update Organization<\/button>/); assert.match(html, /Typing here does not save/);
});

test('advanced manual testing retains exact fields and planned/sent versus actual-token boundaries', () => {
    const html = render(); const manual = html.slice(html.indexOf('<!-- MANUAL SANDBOX CARD -->'));
    assert.match(manual, /Manual request testing · advanced/); assert.match(manual, /local test override/); assert.match(manual, /cannot change approved sources, scope or patient authority/);
    assert.match(manual, /name="consentId"/); assert.match(manual, /name="endpointUrl"/); assert.match(manual, /formaction="\/doctor\/discover"/);
    assert.match(manual, /disabled data-service-help/); assert.match(html, /Planned from intended operations; not yet authorized/); assert.match(html, /actual token response remains separate/);
});

test('actual management handlers retain exact save payload and recover malformed/rejected drafts without shared persistence', async () => {
    const f = await startAuxiliaryFixture();
    const post = (route, body) => fetch(f.doctor + route, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' }, body: new URLSearchParams(body) });
    try {
        const body = { identity: 'hospital-a', id: f.endpoint.id, jsonContent: '{"unfinished":' };
        const invalid = await post('/manage/endpoint', body); assert.equal(invalid.status, 400); assert.equal(invalid.headers.get('location'), null);
        const html = await invalid.text(); assert.match(html, /Endpoint update failed/); assert.match(html, /&#34;unfinished&#34;/); assert.match(html, /aria-invalid="true"/); assert.equal(f.calls.filter(c => c.action === 'update').length, 0);
        f.state.unavailable = true;
        const unavailable = await post('/manage/endpoint', body); assert.equal(unavailable.status, 400);
        const recovery = await unavailable.text(); assert.match(recovery, /Rejected endpoint draft/); assert.match(recovery, /&#34;unfinished&#34;/); assert.match(recovery, /current record is unavailable/);
        f.state.unavailable = false;
        const ordinary = await (await fetch(f.doctor + '/manage?identity=hospital-a')).text(); assert.doesNotMatch(ordinary, /unfinished|aria-invalid="true"/);
        const update = { ...f.endpoint, name: 'Saved endpoint' }; body.jsonContent = JSON.stringify(update);
        f.state.rejected = true; const rejected = await post('/manage/endpoint', body); assert.equal(rejected.status, 400); assert.match(await rejected.text(), /Synthetic PCM validation rejected/);
        f.state.rejected = false; const saved = await post('/manage/endpoint', body); assert.equal(saved.status, 302); assert.equal(saved.headers.get('location'), '/doctor/manage?identity=hospital-a');
        assert.deepEqual(f.calls.filter(c => c.action === 'update').at(-1), { action: 'update', type: 'Endpoint', id: f.endpoint.id, data: update, identity: 'hospital-a' });
        assert.match(await (await fetch(f.base + saved.headers.get('location'))).text(), /Endpoint updated\./);
        const catalog = await post('/manage/catalog-update', { identity: 'hospital-a', jsonContent: '{', reason: '<reason>' }); assert.equal(catalog.status, 400); assert.match(await catalog.text(), /value="&lt;reason&gt;"/);
        const proposal = { id: 'catalog', name: 'Corrected name' };
        const accepted = await post('/manage/catalog-update', { identity: 'hospital-a', jsonContent: JSON.stringify(proposal), reason: 'Correction' }); assert.equal(accepted.status, 302);
        assert.deepEqual(f.calls.at(-1), { action: 'catalog', data: proposal, reason: 'Correction', identity: 'hospital-a' });
    } finally { await f.close(); }
});

test('UI wrappers preserve mounts, raw generated documents and safe logged errors without changing protocol responses', async () => {
    const f = await startAuxiliaryFixture();
    try {
        for (const [route, filename] of [['api', 'api-docs.html'], ['admin-api', 'admin-api-docs.html']]) {
            const response = await fetch(f.pcm + '/docs/' + route); assert.equal(response.status, 200); const html = await response.text();
            assert.match(html, new RegExp('src="/pcm/docs/' + route + '/content"')); assert.match(html, /aria-current="page"/); assert.match(html, /Documentation does not report service health/);
            assert.doesNotMatch(html, /Redoc.init|swagger-ui|<button/);
            const content = await fetch(f.pcm + '/docs/' + route + '/content'); assert.equal(content.status, 200); assert.equal(await content.text(), fs.readFileSync(path.resolve(__dirname, '../../../docs', filename), 'utf8'));
        }
        for (const base of [f.doctor, f.pcm]) {
            const missing = await fetch(base + '/missing?client_secret=DO-NOT-ECHO', { headers: { Accept: 'text/html' } }); assert.equal(missing.status, 404); const text = await missing.text(); assert.match(text, /Page unavailable/); assert.doesNotMatch(text, /DO-NOT-ECHO|client_secret/);
            assert.equal((await fetch(base + '/healthz', { headers: { Accept: 'text/html' } })).headers.get('content-type').startsWith('application/json'), true);
            const protocol = await fetch(base + '/api/missing', { headers: { Accept: 'text/html' } }); assert.equal(protocol.status, 404); assert.doesNotMatch(await protocol.text(), /sandbox-header/);
        }
        const selectedError = await fetch(f.doctor + '/patients/select', { method: 'POST', headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ identity: 'hospital-a', patientId: '', patientSystem: 'http://fhir.health.gov.il/identifier/il-national-id' }) });
        assert.equal(selectedError.status, 400); assert.match(await selectedError.text(), /href="\/doctor\/patients\?identity=hospital-a"/);
        const applicationError = await (await fetch(f.doctor + '/missing?identity=hospital-b', { headers: { Accept: 'text/html' } })).text();
        assert.match(applicationError, /href="\/doctor\/\?identity=hospital-b"/);
        const bad = await fetch(f.doctor + '/selection', { method: 'POST', headers: { Accept: 'text/html', 'Content-Type': 'application/json' }, body: '{"secret":"DO-NOT-ECHO"' });
        assert.equal(bad.status, 400); assert.doesNotMatch(await bad.text(), /DO-NOT-ECHO|SyntaxError|at JSON/);
        const records = fs.readFileSync(path.join(process.env.LOG_DIR, 'current.log'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.ok(records.some(row => row.details.type === 'ROUTE_ERROR'), 'safe browser framing retains the existing structured failure event');
    } finally { await f.close(); }
});
