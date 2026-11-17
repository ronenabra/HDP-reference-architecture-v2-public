'use strict';
/** Focused recorded-evidence contracts for the pure frontend projection. */
const test = require('node:test'), assert = require('node:assert/strict');
const fhir = require('../../shared/ui/log-fhir-exchange');
const event = (type, details) => ({ details: { type, ...details } });
const outcome = { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'forbidden', diagnostics: '<script>untrusted</script>' }] };

test('GET routes retain exact URL, ordered repeated/empty/encoded parameters, and absent body', () => {
    const url = '/api/fhir-service/r4/Patient?x=a%2Bb&x=&empty&name=%D7%A9+z';
    const result = fhir.extract(event('OUTGOING_REQUEST', { method: 'get', url }));
    assert.equal(result.request[0].fields.find(field => field.label === 'URL / path').value, url);
    assert.deepEqual(fhir.pairs(url.split('?')[1]).values, [
        { raw: 'x=a%2Bb', name: 'x', value: 'a+b' }, { raw: 'x=', name: 'x', value: '' },
        { raw: 'empty', name: 'empty', value: '' }, { raw: 'name=%D7%A9+z', name: 'name', value: 'ש z' }
    ]);
    assert.match(fhir.bodyView(result.request[0]).label, /GET/);
    assert.equal(fhir.bodyView(result.request[0]).exact, null);
    assert.deepEqual(result.response, []);
});

test('POST data/body paths support JSON objects and strings without changing exact copy values', () => {
    for (const [key, value] of [['data', outcome], ['body', JSON.stringify(outcome)]]) {
        const candidate = fhir.extract(event('OUTGOING_REQUEST', { method: 'POST', url: '/fhir', [key]: value })).request[0];
        const view = fhir.bodyView(candidate);
        assert.equal(view.text, JSON.stringify(outcome, null, 2));
        assert.equal(view.exact, typeof value === 'string' ? value : JSON.stringify(value));
        assert.deepEqual(candidate.body.path, ['details', key]);
    }
});

test('form parsing requires recorded content type and retains original repeated values for copy', () => {
    const body = 'code=a%7Cb&code=&name=one+two';
    const details = { method: 'POST', url: '/fhir/Observation/_search', body };
    const raw = fhir.bodyView(fhir.extract(event('REQUEST', details)).request[0]);
    assert.equal(raw.text, body); assert.match(raw.label, /Recorded text/);
    const form = fhir.bodyView(fhir.extract(event('REQUEST', { ...details, headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' } })).request[0]);
    assert.match(form.text, /code = a\|b\n  Encoded: code=a%7Cb\ncode = /);
    assert.equal(form.exact, body);
});

test('response-only workflow and Doctor responses retain FHIR Bundle/OperationOutcome with unknown metadata', () => {
    const bundle = { resourceType: 'Bundle', type: 'batch-response', entry: [{ response: { status: '403' }, resource: outcome }] };
    for (const [type, key, body] of [['SYSTEM_WORKFLOW_RESPONSE', 'body', bundle], ['OUTGOING_RESPONSE', 'data', JSON.stringify(bundle)], ['RESPONSE', 'body', outcome]]) {
        const result = fhir.extract(event(type, { [key]: body }));
        assert.equal(result.request.length, 0); assert.equal(result.response.length, 1);
        assert.equal(result.response[0].fields.length, 0);
        assert.equal(JSON.parse(fhir.bodyView(result.response[0]).text).resourceType, body === outcome ? 'OperationOutcome' : 'Bundle');
    }
});

test('adapter errors keep request and response bodies separate; network failure invents no response', () => {
    const result = fhir.extract(event('OUTGOING_ERROR', { url: '/fhir/Patient', requestBody: '', requestHeaders: { 'Content-Type': 'application/fhir+json' },
        status: 403, responseBody: outcome, responseHeaders: { 'content-type': 'application/fhir+json' } }));
    assert.equal(fhir.bodyView(result.request[0]).exact, '');
    assert.deepEqual(result.response[0].body.path, ['details', 'responseBody']);
    assert.equal(fhir.bodyView(result.response[0]).label, 'Recorded FHIR OperationOutcome');
    const network = fhir.extract(event('OUTGOING_ERROR', { url: '/fhir/Patient', error: 'ECONNRESET' }));
    assert.equal(network.request.length, 1); assert.equal(network.response.length, 0);
});

test('native and derived gateway metadata do not invent body or status', () => {
    for (const type of ['HAPI_REQUEST', 'GATEWAY_REQUEST', 'HAPI_RESPONSE', 'GATEWAY_RESPONSE', 'HAPI_ERROR', 'ROUTE_ERROR']) {
        const record = event(type, { method: 'GET', url: '/fhir/Observation?status=final' });
        const before = JSON.stringify(record), result = fhir.extract(record);
        assert.equal(result.request[0].body, null);
        assert.equal(result.response.some(candidate => candidate.fields.some(field => field.label === 'Status')), false);
        assert.equal(JSON.stringify(record), before);
    }
});

test('explicit shallow nested HTTP candidates retain conflicts and exact duplicate field paths', () => {
    const result = fhir.extract(event('OUTGOING_ERROR', { error: {
        request: { method: 'POST', url: '/fhir/Patient', body: { id: 'one' }, data: { id: 'two' } },
        response: { status: 400, body: outcome, data: outcome }
    } }));
    assert.equal(result.request.length, 2); assert.equal(result.response.length, 1);
    assert.deepEqual(result.request.map(candidate => candidate.body.value.id), ['one', 'two']);
    assert.deepEqual(result.response[0].body.aliases, [['details', 'error', 'response', 'data']]);
    const malformed = fhir.extract(event('OUTGOING_ERROR', { url: '/fhir/Patient', error: { response: { status: 502, body: '<h1>failed</h1>' } } }));
    assert.equal(malformed.response.at(-1).body.value, '<h1>failed</h1>');
    const body = { resourceType: 'Bundle', entry: [{ request: { method: 'GET', url: 'Patient' } }] };
    assert.equal(fhir.extract(event('OUTGOING_REQUEST', { method: 'POST', url: '/fhir', body })).request.length, 1);
});

test('missing, null, empty string/object, malformed and non-FHIR error text remain distinct', () => {
    const labels = [];
    for (const body of [undefined, null, '', {}, '{"resourceType":"Bundle",', '<h1>502</h1>']) {
        const details = { url: '/fhir/Patient', status: 502, ...(body === undefined ? {} : { body }) };
        const view = fhir.bodyView(fhir.extract(event('RESPONSE', details)).response[0]);
        labels.push(view.label);
        assert.equal(view.exact, body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body));
        if (typeof body === 'string') assert.equal(view.text, body);
    }
    assert.equal(new Set(labels.slice(0, 4)).size, 4);
});

test('OAuth paths, snapshots, imports and unrelated FHIR objects are ineligible', () => {
    for (const record of [
        event('OUTGOING_RESPONSE', { url: '/fhir/token', data: outcome }),
        event('RESPONSE', { url: '/api/fhir-service/r4/introspect?fhir=Patient', body: outcome }),
        event('TOKEN_ISSUED', { body: outcome, response: { status: 200, body: outcome } }),
        event('constructor', { url: '/fhir/Patient', body: outcome }), event('__proto__', { body: outcome }),
        event('IMPORT_COMPLETED', { body: outcome }), event('CONSENT_SAVED', { snapshot: outcome }),
        event('REQUEST', { url: '/services/fhirish', savedConsent: outcome }),
        event('RESPONSE', { snapshot: { response: { body: outcome } } })
    ]) assert.equal(fhir.extract(record).request.length + fhir.extract(record).response.length, 0);
    assert.equal(fhir.route('/Patient/123').fhir, true);
    assert.equal(fhir.route('/patients/Patient').fhir, false);
});

test('deep/wide/large formatting is bounded with honest limits and no partial copy', () => {
    const deep = {}; let cursor = deep;
    for (let index = 0; index < 30; index++) cursor = cursor.child = {};
    for (const body of [deep, Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [i, i])), 'x'.repeat(fhir.LIMITS.valueChars + 1)]) {
        const result = fhir.extract(event('RESPONSE', { url: '/fhir/Patient', body }));
        const view = fhir.bodyView(result.response[0]);
        assert.match(view.label, /limit reached/); assert.equal(view.text, ''); assert.equal(view.exact, null);
    }
    const serialized = JSON.stringify({ resourceType: 'Bundle', text: 'x'.repeat(fhir.LIMITS.valueChars + 1) });
    const largeResponse = fhir.extract(event('SYSTEM_WORKFLOW_RESPONSE', { body: serialized }));
    assert.equal(largeResponse.response.length, 1);
    assert.match(fhir.bodyView(largeResponse.response[0]).label, /Display limit reached/);
    const many = { type: 'OUTGOING_ERROR', url: '/fhir/Patient' };
    for (const wrapper of ['error', 'data', 'body']) {
        many[wrapper] = {};
        for (const side of ['request', 'response']) many[wrapper][side] = {
            method: 'POST', url: '/fhir/Patient', status: 400,
            body: wrapper + side + 'body', data: wrapper + side + 'data', [side + 'Body']: wrapper + side + 'split'
        };
    }
    const limited = fhir.extract({ details: many });
    assert.equal(limited.request.length + limited.response.length, 16);
    assert.match(limited.notices[0], /Candidate limit reached/);
    assert.equal(fhir.pairs('x=1&'.repeat(500)).values.length, 200);
    assert.equal(fhir.pairs('x=1&'.repeat(500)).limited, true);
});

test('compact requests preserve GET and POST copy semantics independently of form presentation', () => {
    const url = '/fhir/Observation?code=a%7Cb&code=&empty';
    const get = fhir.requestView(fhir.extract(event('REQUEST', { method: 'GET', url, path: url })).request[0]);
    assert.equal(get.text, `GET ${url}`); assert.equal(get.exact, get.text);
    const body = 'code=a%7Cb&code=&name=one+two';
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/fhir+json' };
    const post = fhir.requestView(fhir.extract(event('REQUEST', { method: 'POST', url, headers, body })).request[0]);
    assert.equal(post.text, `POST ${url}\nContent-Type: application/x-www-form-urlencoded\n\ncode=a%7Cb\n&code=\n&name=one+two`);
    assert.equal(post.exact, `POST ${url}\nContent-Type: application/x-www-form-urlencoded\naccept: application/fhir+json\n\n${body}`);
});

test('503 request context omits an unknown method and keeps response headers readable', () => {
    const url = 'https://ho-a-hapi:8080/fhir/Observation?_count=10';
    const headers = { 'retry-after': '1', 'content-type': 'application/fhir+json' };
    const evidence = fhir.extract(event('OUTGOING_RESPONSE', { url, status: 503, headers, body: JSON.stringify(outcome) }));
    const request = fhir.requestView(evidence.request[0]);
    assert.equal(request.text, url); assert.equal(request.exact, url); assert.equal(request.method, false);
    assert.equal(fhir.headerView(headers), 'retry-after: 1\ncontent-type: application/fhir+json');
    assert.equal(fhir.bodyView(evidence.response[0]).text, JSON.stringify(outcome, null, 2));
});

test('compact formatters retain repeated headers, empty bodies and bounded values', () => {
    assert.equal(fhir.headerView({ 'set-cookie': ['one', 'two'], empty: '' }), 'set-cookie: one\nset-cookie: two\nempty: ');
    assert.equal(fhir.headerView('x-recorded: literal\r\n'), 'x-recorded: literal\r\n');
    assert.equal(fhir.headerView({ huge: 'x'.repeat(fhir.LIMITS.valueChars) }), null);
    const request = fhir.requestView(fhir.extract(event('REQUEST', { url: '/fhir/Patient', method: 'POST', body: '' })).request[0]);
    assert.equal(request.exact, 'POST /fhir/Patient\n\n'); assert.match(request.notice, /empty string/);
    const limited = fhir.requestView(fhir.extract(event('REQUEST', { url: '/fhir/Patient', body: 'x'.repeat(fhir.LIMITS.valueChars) })).request[0]);
    assert.equal(limited.exact, null); assert.match(limited.notice, /limit/);
});
