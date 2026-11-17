'use strict';
/** Pure navigation, exact copy semantics and recorded-only specialized models. */
const test = require('node:test'), assert = require('node:assert/strict');
const explorer = require('../../shared/ui/log-record-explorer');
const jwt = (header, payload) => [header, payload].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.') + '.signature';

test('Read and Explore reveal complete results while restoring detail never steals focus or scroll', () => {
    // Only the DOM boundary used by mount is needed; no layout or browser is simulated.
    const revealed = [], focused = [];
    const document = { createElement(tag) {
        return { tag, children: [], dataset: {}, textContent: '', ownerDocument: document,
            append(...children) { this.children.push(...children); },
            replaceChildren(...children) { this.children = children; },
            setAttribute() {}, addEventListener() {},
            focus(options) { assert.deepEqual(options, { preventScroll: true }); focused.push(this); },
            scrollIntoView(options) { assert.deepEqual(options, { block: 'nearest' }); revealed.push(this); }
        };
    } };
    const host = document.createElement('div');
    const record = { details: { payload: { answer: 0 }, text: 'x'.repeat(1000), empty: '', falsy: false } };
    const view = explorer.mount(host, record);
    assert.equal(revealed.length, 0);
    view.navigate(['details', 'payload']);
    assert.equal(revealed.at(-1).textContent, 'Exploring $["details"]["payload"]');
    assert.equal(focused.at(-1), revealed.at(-1));
    for (const key of ['payload', 'text', 'empty', 'falsy']) {
        view.read(['details', key], record.details[key]);
        const result = revealed.at(-1);
        assert.equal(result.textContent, explorer.copyValue(record.details[key]));
        assert.equal(result.hidden, false); assert.equal(focused.at(-1), result);
    }
    const count = revealed.length;
    const restored = explorer.mount(host, record, { state: view.state() });
    assert.equal(revealed.length, count); assert.equal(focused.length, count);
    assert.deepEqual(restored.state().rootPath, ['details', 'payload']);
    assert.deepEqual(restored.state().chosenPath, ['details', 'falsy']);
});

test('unknown and legacy records retain arbitrary keys, all JSON types and exact copy values', () => {
    const record = JSON.parse('{"details":{"":{"a.b":[null,false,0,"",{},[]]},"__proto__":{"<script>":"literal & untrusted"},"long":"' + 'x'.repeat(4000) + '"}}');
    assert.deepEqual(explorer.specialized(record), []);
    assert.equal(explorer.fieldPath(['details', '', 'a.b', '0']), '$["details"][""]["a.b"]["0"]');
    assert.equal(explorer.at(record, ['details', '__proto__', '<script>']), 'literal & untrusted');
    assert.equal(explorer.at(record, ['constructor']), undefined);
    for (const value of [null, false, 0, '', {}, [], record]) {
        assert.equal(explorer.copyValue(value), typeof value === 'string' ? value : JSON.stringify(value));
        assert.deepEqual(JSON.parse(explorer.completeJson(value)), value);
    }
    assert.equal(explorer.preview(record.details.long).length, explorer.LIMITS.preview + 1);
    assert.equal(explorer.copyValue(record.details.long).length, 4000);
    assert.equal(explorer.type(null), 'null'); assert.equal(explorer.type([]), 'array');
    const scan = explorer.search(record, 'unTRUSTED').next();
    assert.equal(scan.done, true); assert.equal(scan.matches[0].value, 'literal & untrusted');
    for (const query of ['a.b', 'false', '0', '__proto__']) assert.ok(explorer.search(record, query).next().matches.length);
});

test('search traverses deep values iteratively and resumes after bounded work/results', () => {
    const record = { rows: Array.from({ length: 25000 }, (_, index) => index === 24999 ? 'last target' : null) };
    const scan = explorer.search(record, 'target'); let batch, batches = 0, matches = [];
    do { batch = scan.next(); matches.push(...batch.matches); assert.ok(batch.visits <= explorer.LIMITS.searchVisits); assert.ok(batch.matches.length <= explorer.LIMITS.matches); batches++; } while (!batch.done && batches < 10);
    assert.equal(batch.done, true); assert.ok(batches > 1); assert.equal(matches.length, 1); assert.deepEqual(matches[0].path, ['rows', '24999']);
    let deep = 'deep target'; for (let depth = 0; depth < 300; depth++) deep = { next: deep };
    assert.equal(explorer.search(deep, 'deep target').next().matches[0].path.length, 300);
    const all = explorer.search(record, ''); assert.equal(all.next().matches.length, explorer.LIMITS.matches);
});

test('opaque issuance is never decoded even when it resembles a JWT; legacy never invents state', () => {
    const value = jwt({ alg: 'none' }, { active: true, patient: 'invented' });
    const record = { details: { type: 'TOKEN_ISSUED', access_token: value, issuanceRecord: { iat: 1, exp: 2, authorization: { scope: 'recorded' } } } };
    assert.equal(explorer.tokens(record)[0].opaque, true);
    const view = explorer.specialized(record)[0];
    assert.equal(view.fields.find(field => field.key === 'issuanceRecord').value, record.details.issuanceRecord);
    const legacy = explorer.specialized({ details: { type: 'TOKEN_ISSUED' } })[0];
    assert.equal(legacy.fields.find(field => field.key === 'issuanceRecord').available, false);
    assert.equal(legacy.fields.find(field => field.key === 'access_token').available, false);
});

test('recorded JWT/assertions decode Unicode header and payload without verification; malformed retains original', () => {
    const value = jwt({ alg: 'ES256' }, { name: 'שלום', exp: 0 });
    assert.deepEqual(explorer.decodeJwt('Bearer ' + value), { header: { alg: 'ES256' }, payload: { name: 'שלום', exp: 0 } });
    for (const bad of ['opaque', 'a.b.c', 'e30.bm90anNvbg.sig', value + '.extra', jwt([], {})]) assert.equal(explorer.decodeJwt(bad), null);
    const token = explorer.tokens({ details: { type: 'RESPONSE', body: { access_token: 'malformed.original.value' } } })[0];
    assert.equal(token.value, 'malformed.original.value'); assert.equal(token.opaque, false);
});

test('HTTP and decisions summarize only recorded fields and preserve false/zero/empty', () => {
    const record = { details: { type: 'RESPONSE', status: 0, body: '', decision: false, reason: null, custom: 'available generically' } };
    const views = explorer.specialized(record);
    assert.equal(views.find(view => view.title === 'HTTP exchange').fields.find(field => field.key === 'status').value, 0);
    const decision = views.find(view => view.title === 'Recorded authorization decision');
    assert.equal(decision.fields.find(field => field.key === 'decision').value, false);
    assert.equal(decision.fields.find(field => field.key === 'reason').available, true);
    assert.equal(decision.fields.find(field => field.key === 'active').available, false);
    assert.equal(explorer.search(record, 'custom').next().matches[0].value, 'available generically');
});

test('issuance grant constraints display frozen patient and basis paths without current-state inference', () => {
    const record = { details: { type: 'TOKEN_ISSUED', issuanceRecord: { authorization: {
        scope: 'patient/Observation.s?date=ge2026-01-01', patient: { system: 'synthetic', value: '1' },
        requested: { basis: { type: 'Consent', identifier: { system: 'basis', value: 'CONSENT-1' } } }, deadline: 123
    } } } };
    const view = explorer.specialized(record).find(group => group.title === 'Issuance-time grant constraints');
    assert.equal(view.fields.find(field => field.key === 'patient.value').value, '1');
    const basis = view.fields.find(field => field.key === 'requested.basis.identifier.value');
    assert.equal(basis.value, 'CONSENT-1'); assert.deepEqual(basis.path, ['details', 'issuanceRecord', 'authorization', 'requested', 'basis', 'identifier', 'value']);
    assert.equal(view.fields.find(field => field.key === 'deadline').value, 123);
});

test('specialized token discovery caps one wide object as well as nested traversal', () => {
    const headers = {};
    for (let index = 0; index < 100; index++) {
        const name = [...'authorization'].map((letter, bit) => index & (1 << bit) ? letter.toUpperCase() : letter).join('');
        headers[name] = `recorded ${index}`;
    }
    const record = { details: { headers } };
    assert.equal(explorer.tokens(record).length, 20);
    // A renderer bound must never remove the evidence from generic navigation.
    assert.equal(Object.keys(explorer.at(record, ['details', 'headers'])).length, 100);
});


test('event summary distinguishes recorded zero counts, absent facts, HTTP and auth evidence', () => {
    const { summary } = require('../../shared/ui/log-record-explorer');
    assert.deepEqual(summary({ details: { type: 'HAPI_RESULT_FILTER_SUMMARY', examined: 3, allowed: 3, removed: 0 } }), [
        { label: 'Input examined', value: 3 }, { label: 'Kept', value: 3 }, { label: 'Excluded', value: 0 }]);
    assert.deepEqual(summary({ details: { type: 'HAPI_RESULT_FILTER_SUMMARY', examined: null } }), []);
    assert.deepEqual(summary({ details: { type: 'REQUEST', method: 'GET', url: '/Patient', status: 200 } }).map(fact => fact.value), ['GET', '/Patient', 200]);
    assert.deepEqual(summary({ details: { type: 'INTROSPECTION_DECISION', active: false, decision: 'deny' } }).map(fact => fact.value), ['deny', false]);
    assert.deepEqual(summary({ details: { type: 'DS_AUTHORIZATION_DECISION', decision: 'deny', reasonCode: 'MISSING_TOKEN' } }).map(fact => fact.value), ['deny', 'MISSING_TOKEN']);
});
