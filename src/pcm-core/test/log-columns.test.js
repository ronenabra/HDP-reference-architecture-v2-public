'use strict';
/** Display preference boundaries, exact ID semantics and actual table rendering. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const api = require('../../shared/ui/log-columns');
const source = fs.readFileSync(require.resolve('../src/views/logs.ejs'), 'utf8');
const defaults = api.validate(null);
/** Extract an authored function for execution against a narrow real contract boundary. */
function between(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }

test('defaults and malformed/unknown versions use only known booleans with required event identity', () => {
    assert.deepEqual(Object.entries(defaults).filter(([, on]) => on).map(([id]) => id), ['time', 'component', 'correlationId', 'kind', 'level', 'class', 'message']);
    for (const value of [null, false, [], 'invalid', { version: 2, visible: { time: false } }, { version: 1, visible: [] }]) assert.deepEqual(api.validate(value), defaults);
    const result = api.validate({ version: 1, visible: { time: false, traceId: true, flowId: 'true', message: false, extra: 'secret' } });
    assert.equal(result.time, false); assert.equal(result.traceId, true); assert.equal(result.flowId, false); assert.equal(result.message, true);
    assert.equal(result.component, true); assert.equal(Object.hasOwn(result, 'extra'), false);
});
test('event icons use exact recorded types and leave ambiguous errors, lifecycle and future events unknown', () => {
    const groups = [
        ['Request', '↗', ['REQUEST', 'OUTGOING_REQUEST', 'GATEWAY_REQUEST', 'HAPI_REQUEST', 'SYSTEM_WORKFLOW_REQUEST']],
        ['Response', '↩', ['RESPONSE', 'OUTGOING_RESPONSE', 'GATEWAY_RESPONSE', 'HAPI_RESPONSE', 'SYSTEM_WORKFLOW_RESPONSE']],
        ['Processing', '⚙', ['TOKEN_ISSUED', 'INTROSPECTION_DECISION', 'DS_AUTHORIZATION_DECISION', 'HAPI_RESULT_FILTER_SUMMARY']],
        ['Other/unknown', '?', ['OUTGOING_ERROR', 'GATEWAY_ERROR', 'HAPI_ERROR', 'PROCESS_START', 'FUTURE_REQUEST', 'FUTURE_SCHEMA', '', null]]
    ];
    for (const [label, icon, names] of groups) for (const name of names) {
        assert.deepEqual(api.kind({ details: { type: name } }), { label, icon });
        assert.deepEqual(api.kind({ event: { eventName: name } }), { label, icon });
    }
    assert.equal(api.kind({}).label, 'Other/unknown');
    assert.equal(api.kind({ event: { eventName: 'FUTURE_REQUEST' }, details: { type: 'REQUEST' } }).label, 'Other/unknown');
    const context = vm.createContext({ window: { PCM_LOG_COLUMNS: api } });
    vm.runInContext(between('function renderColumnKind(', 'function renderColumnId('), context);
    for (const [label, icon, names] of groups) {
        context.log = { details: { type: names[0] } };
        const html = vm.runInContext('renderColumnKind(log)', context);
        assert.ok(html.includes(`title="${label}"`));
        assert.ok(html.includes(`role="img" aria-label="${label}">${icon}</span>`));
        assert.match(html, /data-column="kind"/);
    }
    assert.equal(api.validate({ version: 1, visible: { time: false } }).kind, true);
    assert.equal(api.validate({ version: 1, visible: { kind: false } }).kind, false);
});
test('storage getter/read/write denial, malformed JSON and stale fields fall back gracefully without payload persistence', () => {
    const denied = () => { throw Error('SecurityError'); };
    assert.deepEqual(api.load(denied), defaults); assert.equal(api.save(denied, defaults), false);
    for (const text of ['', '{', 'null', '{"version":99}', '{"version":1,"visible":{"retired":true}}']) assert.deepEqual(api.load(() => ({ getItem: () => text })), defaults);
    assert.deepEqual(api.load(() => ({ getItem() { throw Error('denied'); } })), defaults);
    let saved;
    assert.equal(api.save(() => ({ setItem(key, text) { assert.equal(key, api.key); saved = JSON.parse(text); } }), { ...defaults, payload: 'never-save', traceId: true }), true);
    assert.deepEqual(Object.keys(saved), ['version', 'visible']); assert.deepEqual(Object.keys(saved.visible), api.columns.map(column => column.id));
    assert.equal(JSON.stringify(saved).includes('never-save'), false);
    assert.deepEqual(api.load(() => ({ getItem: () => JSON.stringify(saved) })), saved.visible);
    assert.equal(api.save(() => ({ setItem() { throw Error('quota'); } }), defaults), false);
});
test('normalized, legacy request, empty and missing identifiers agree exactly with metadata accessors', () => {
    const context = vm.createContext({});
    vm.runInContext(between('function getCorrelationId(', '/** Open one exact journey'), context);
    for (const log of [{}, { details: {} }, { details: { requestId: 'legacy-request', flowId: 'legacy-flow', traceId: 'legacy-trace' } },
        { event: { correlation: { correlationId: 'normalized-c', flowId: 'normalized-f', traceId: 'normalized-t' } }, details: { correlationId: 'old', requestId: 'older', flowId: 'old-f', traceId: 'old-t' } },
        { event: { correlation: { correlationId: '', flowId: '', traceId: '' } }, details: { correlationId: 'fallback' } }]) {
        context.log = log;
        for (const [field, getter] of [['correlationId', 'getCorrelationId'], ['flowId', 'getFlowId'], ['traceId', 'getTraceId']]) assert.equal(api.identifier(log, field), vm.runInContext(`${getter}(log)`, context));
    }
    assert.equal(api.identifier({}, 'invented'), '');
});
test('compact IDs retain exact full access and missing cells have no invented copy action', () => {
    const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
    const context = vm.createContext({ window: { PCM_LOG_COLUMNS: api }, escapeHtml: escape });
    vm.runInContext(between('function renderColumnId(', 'let clipboardController'), context);
    const full = '<long-identifier-שלום-' + 'x'.repeat(500) + '-end>';
    context.log = { details: { flowId: full } };
    const html = vm.runInContext("renderColumnId(log, 'flowId')", context);
    assert.ok(html.includes(escape(api.compact(full)))); assert.match(html, /data-id-field="flowId"/); assert.match(html, /Show complete Flow ID/);
    assert.ok(!html.includes(full)); assert.equal(api.identifier(context.log, 'flowId'), full);
    context.log = {}; const missing = vm.runInContext("renderColumnId(log, 'traceId')", context);
    assert.match(missing, /Not recorded/); assert.doesNotMatch(missing, /button/);
});
test('all visibility combinations align header/body/columns and group/spacer spans without changing viewer state', () => {
    const nodes = api.columns.flatMap(column => Array.from({ length: 3 }, () => ({ dataset: { column: column.id } })));
    const toggles = api.columns.map(column => ({ dataset: { columnToggle: column.id } }));
    const spans = [{ colSpan: 6 }, { colSpan: 6 }], table = { style: {} }, status = {};
    const list = { querySelectorAll: selector => selector === '[data-column]' ? nodes : spans, querySelector: () => table };
    const context = vm.createContext({ window: { PCM_LOG_COLUMNS: api }, document: {
        getElementById: id => id === 'log-list' ? list : status, querySelectorAll: () => toggles },
        captureAnchor: () => ({ id: 'held', offset: 7 }), restoreAnchor: anchor => assert.deepEqual(anchor, { id: 'held', offset: 7 }),
        localStorage: { setItem() {} }, selectedId: 'selected', followingLatest: false, visibleColumns: defaults });
    vm.runInContext(between('function syncColumns(', '/** Resolve the full ID'), context);
    for (let bits = 0; bits < 256; bits++) {
        context.visibleColumns = api.validate({ version: 1, visible: Object.fromEntries(api.columns.map((column, index) => [column.id, !!(bits & (1 << index))])) });
        vm.runInContext('syncColumns()', context);
        for (const node of nodes) assert.equal(node.hidden, !context.visibleColumns[node.dataset.column]);
        assert.equal(spans[0].colSpan, Object.values(context.visibleColumns).filter(Boolean).length); assert.equal(spans[1].colSpan, spans[0].colSpan);
        assert.equal(nodes.at(-1).hidden, false); assert.ok(parseInt(table.style.minWidth) >= 280);
    }
    vm.runInContext("changeColumns('traceId', true)", context);
    assert.equal(context.selectedId, 'selected'); assert.equal(context.followingLatest, false);
    vm.runInContext('changeColumns(null)', context); assert.deepEqual(context.visibleColumns, defaults);
});

test('unchanged keyed rows survive refresh for every hidden-column combination', () => {
    /** Model only the DOM visibility serialization used by keyed comparison. */
    function row(visible) {
        const cells = api.columns.map(column => ({ dataset: { column: column.id }, hidden: visible ? !visible[column.id] : false }));
        return { id: 'retained-event', classList: ['log-row'], querySelectorAll: () => cells, isEqualNode(other) { return this.outerHTML === other.outerHTML; },
            get outerHTML() { return cells.map(cell => `<td data-column="${cell.dataset.column}"${cell.hidden ? ' hidden=""' : ''}></td>`).join(''); } };
    }
    const script = between('const fragment = document.createDocumentFragment();', 'tbody.replaceChildren(fragment);');
    for (let bits = 0; bits < 256; bits++) {
        const visible = api.validate({ version: 1, visible: Object.fromEntries(api.columns.map((column, index) => [column.id, !!(bits & (1 << index))])) });
        const old = row(visible), candidate = row();
        const context = vm.createContext({ visibleColumns: visible, tbody: { children: [old] },
            template: { content: { querySelector: () => ({ children: [candidate] }) } },
            document: { createDocumentFragment: () => ({ rows: [], appendChild(node) { this.rows.push(node); } }) } });
        vm.runInContext(script, context);
        assert.equal(vm.runInContext('fragment.rows[0]', context), old, `visibility combination ${bits} preserves the original row`);
    }
});
