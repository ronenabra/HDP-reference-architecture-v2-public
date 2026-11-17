'use strict';
/** Execute supported metadata rendering and focus restoration, including historical evidence. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const values = require('../../shared/ui/help-values');
const { parseCatalog } = require('../../../scripts/generate-ui-help');
const template = fs.readFileSync(path.join(__dirname, '../src/views/logs.ejs'), 'utf8');
const catalog = parseCatalog(fs.readFileSync(path.join(__dirname, '../../../docs/ui-explanation-catalog.md'), 'utf8'));
const labels = ['Timestamp', 'Level', 'Event ID', 'Schema version', 'Classification', 'Event name', 'Source identity',
    'Source component ID', 'Source file', 'Source byte offset', 'Provenance', 'Derived from', 'Flow ID',
    'Correlation / request ID', 'Trace ID', 'Span ID', 'Parent span ID', 'Parse status', 'Provenance note'];

/** Isolate an actual authored function without executing page boot/network work. */
function code(name, next) { return template.slice(template.indexOf(`        function ${name}(`), template.indexOf(next, template.indexOf(`        function ${name}(`))); }

test('all supported metadata labels have explicit valid concept keys, arbitrary keys have none', () => {
    for (const label of labels) assert.ok(catalog[values.metadata(label)]?.body.length > 35, label);
    for (const label of ['arbitraryPayloadKey', '__proto__', 'constructor']) assert.equal(values.metadata(label), null);
    assert.match(catalog['logs.provenance'].body, /Legacy \/ unspecified means no supported provenance/);
    assert.match(catalog['logs.span-id'].body, /Not recorded means this source provided no span ID/);
    assert.match(catalog['logs.trace-id'].technical, /cannot recover missing propagation/);
    assert.equal(catalog['logs.payload'].title, 'Complete normalized JSON');
    for (const [label, key] of [['Timestamp', 'logs.time'], ['Flow ID', 'logs.flow-id'], ['Trace ID', 'logs.trace-id'], ['Correlation / request ID', 'logs.correlation']]) {
        assert.equal(values.metadata(label), key);
        assert.ok(template.includes(`data-help-key="${key}"`) || template.includes(`'${key}'`));
    }
});

test('rendered metadata binds optional, legacy, missing and derived evidence without payload key invention', () => {
    const script = code('renderEventMetadata', '\n        /** Fetch only');
    for (const legacy of [false, true]) {
        const record = { id: 'event', timestamp: '2026-11-05', level: 'WARN', component: 'Gateway', details: legacy ? { requestId: 'legacy-request' } : {},
            event: legacy ? undefined : { schemaVersion: '1.0', eventName: 'REQUEST', correlation: { spanId: 'span', parentSpanId: 'recorded-parent' } } };
        const context = { window: { PCM_HELP_VALUES: values }, selectedRecordModel: () => ({ record, provenance: { kind: 'derived', derivedFrom: { eventId: 'response' }, note: 'estimated' }, source: { componentId: 'gateway', logFile: 'history/app.log', byteOffset: 0 }, derived: true }),
            getFlowId: () => '', getTraceId: () => '', getCorrelationId: row => row.details.requestId || '',
            logCategory: () => 'system', formatLogClass: () => 'system/default', sourceIdentity: () => 'gateway', roleClass: () => 'gateway', conciseRole: () => 'Gateway',
            escapeHtml: String, escapeAttribute: String, inspectJourneyUrl: () => '/logs-view' };
        vm.createContext(context); vm.runInContext(script, context);
        const html = context.renderEventMetadata(record, { parseError: 'synthetic parse status' });
        for (const label of labels) assert.match(html, new RegExp(`<dt data-help-key="[a-z.-]+">${label}</dt>`), label);
        assert.match(html, /data-help-key="logs.level-warn"/);
        assert.match(html, /Source byte offset<\/dt><dd>0/);
        assert.match(html, /Flow ID<\/dt><dd>Not recorded/);
        assert.match(html, new RegExp('Parent span ID</dt><dd>' + (legacy ? 'Not recorded' : 'recorded-parent')));
        assert.match(html, /data-help-key="logs.parent-span-id"/);
        assert.match(html, /no separately captured raw request/);
        assert.equal(html.includes('Legacy record (no event schema)'), legacy);
        assert.equal(html.includes('legacy-request'), legacy);
    }
});

test('anchor focus restoration retains severity cell and full-ID action instead of generic row', () => {
    let focused;
    const cell = { dataset: { column: 'level' }, tabIndex: 0, focus: () => { focused = 'level'; } };
    const button = { focus: () => { focused = 'id'; } };
    const idCell = { dataset: { column: 'traceId' }, querySelector: () => button };
    const row = { querySelectorAll: () => [cell, idCell], focus: () => { focused = 'row'; } };
    const list = { focus: () => { focused = 'list'; } };
    const context = { document: { getElementById: id => id === 'row' ? row : id === 'log-list' ? list : null } };
    vm.createContext(context); vm.runInContext(code('restoreReadingFocus', '        function restoreAnchor'), context);
    context.restoreReadingFocus({ focusedId: 'row', focusedColumn: 'level' }); assert.equal(focused, 'level');
    context.restoreReadingFocus({ focusedId: 'row', focusedColumn: 'traceId', focusedIdButton: true }); assert.equal(focused, 'id');
    context.restoreReadingFocus({ focusedId: 'row' }); assert.equal(focused, 'row');
    context.restoreReadingFocus({ focusedId: 'gone', focusedColumn: 'level' }); assert.equal(focused, 'list');
});

test('format scroll preserves complete normalized JSON independently of specialized pre previews', () => {
    const full = { scrollTop: 70, scrollLeft: 11 }, preview = { scrollTop: 0, scrollLeft: 0 };
    const raw = { scrollTop: 91, scrollLeft: 3 };
    const context = { eventDetailOpen: true, activeDetailTab: 'json', detailTabScroll: {},
        document: { getElementById: () => ({ querySelector: selector => selector.includes('logs.payload') ? full : selector.includes('raw-source-text') ? raw : preview }) } };
    vm.createContext(context);
    vm.runInContext(code('rememberDetailScroll', '        function syncDetailPresentation'), context);
    context.rememberDetailScroll(); full.scrollTop = 0; full.scrollLeft = 0; context.restoreDetailScroll();
    assert.equal(full.scrollTop, 70); assert.equal(full.scrollLeft, 11); assert.equal(preview.scrollTop, 0);
    context.activeDetailTab = 'raw'; context.rememberDetailScroll(); raw.scrollTop = 0; context.restoreDetailScroll(); assert.equal(raw.scrollTop, 91);
});

test('new help cells wait for managed tab stops and Explain OFF falls back without adding one', () => {
    let pending, focused;
    const cell = { dataset: { column: 'level' }, tabIndex: -1, isConnected: true, focus: () => { focused = 'cell'; } };
    const row = { isConnected: true, querySelectorAll: () => [cell], focus: () => { focused = 'row'; } };
    const context = { queueMicrotask: callback => { pending = callback; }, document: { getElementById: () => row } };
    vm.createContext(context); vm.runInContext(code('restoreReadingFocus', '        function restoreAnchor'), context);
    context.restoreReadingFocus({ focusedId: 'row', focusedColumn: 'level' });
    assert.equal(focused, undefined);
    cell.tabIndex = 0; pending(); assert.equal(focused, 'cell');
    cell.tabIndex = -1; context.restoreReadingFocus({ focusedId: 'row', focusedColumn: 'level' }); pending();
    assert.equal(focused, 'row'); assert.equal(cell.tabIndex, -1);
});

test('Escape dismisses Explain without discarding selected event detail or stealing its focus', () => {
    const start = template.indexOf("            document.addEventListener('keydown', event => {");
    const end = template.indexOf('\n            });', start) + '\n            });'.length;
    let listener, closed = 0;
    const tooltip = { hidden: false };
    const context = { activePanel: null, eventDetailOpen: true, window: { innerWidth: 1440 },
        closeEventDetail: () => { closed++; },
        document: { addEventListener: (_type, callback) => { listener = callback; },
            getElementById: id => id === 'pcm-help-tooltip' ? tooltip : { open: false } } };
    vm.createContext(context); vm.runInContext(template.slice(start, end), context);
    listener({ key: 'Escape', preventDefault() {} });
    assert.equal(closed, 0, 'Explain owns Escape while its tooltip is visible');
    tooltip.hidden = true;
    listener({ key: 'Escape', defaultPrevented: true, preventDefault() {} });
    assert.equal(closed, 0, 'A consumed Escape retains the selected detail');
    listener({ key: 'Escape', defaultPrevented: false, preventDefault() {} });
    assert.equal(closed, 1, 'Ordinary Escape still closes event detail');
});
