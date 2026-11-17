'use strict';

/** Headless template and browser-state regressions for the bounded shared log viewer. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const template = fs.readFileSync(path.join(__dirname, '../src/views/logs.ejs'), 'utf8');
const rendered = ejs.render(template, { teamId: 'test-<team>' });
const scripts = [...rendered.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(Boolean);

/** Minimal DOM surface: tests inspect text/HTML and dispatch state transitions, not layout. */
class Element {
    constructor(id = '') {
        this.id = id;
        this.dataset = {};
        this.isConnected = true;
        this.scrollLeft = 0;
        this.clientWidth = 1000;
        this.textContent = '';
        this.innerHTML = '';
        this.attributes = new Map();
        this.classes = new Set();
        this.classList = {
            add: (...values) => values.forEach(value => this.classes.add(value)),
            remove: (...values) => values.forEach(value => this.classes.delete(value)),
            toggle: (value, on) => on ? this.classes.add(value) : this.classes.delete(value)
        };
        this.value = '';
        this.options = [];
        this.tagName = 'INPUT';
        this.style = {};
        this.listeners = {};
        this.children = [];
        this.scrollHeight = 400;
        this.scrollTop = 0;
        this.clientHeight = 400;
    }
    isEqualNode(other) { return this.outerHTML === other.outerHTML; }
    remove() {}
    select() {}
    get innerHTML() { return this.html || ''; }
    set innerHTML(value) {
        this.html = value;
        this.rawElement = null; this.structuredElement = null; this.panels = {};
        for (const match of value.matchAll(/<section id="(panel-[^"]+)"[^>]*>([\s\S]*?)<\/section>/g)) {
            const panel = new Element(match[1]); panel.innerHTML = match[2]; this.panels[match[1]] = panel;
        }
        if (this.tagName === 'TEMPLATE') {
            const body = new Element('template-body');
            body.children = [...value.matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map(match => {
                const row = new Element(match[0].match(/id="([^"]+)"/)?.[1]);
                row.outerHTML = match[0]; return row;
            });
            this.content = { querySelector: () => body };
        }
    }
    querySelectorAll(selector) { return selector === 'pre' ? [this.querySelector('[data-help-key="logs.payload"]'), this.querySelector('.raw-source-text')].filter(Boolean) : []; }
    contains(node) { return node === this || this.children.includes(node); }
    setPointerCapture(id) { this.pointerId = id; }
    hasPointerCapture(id) { return this.pointerId === id; }
    releasePointerCapture() { this.pointerId = null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(element) { this.children.push(element); this.options.push(element); }
    replaceChildren(...children) { this.children = children.flatMap(child => child.fragment ? child.children : [child]); this.innerHTML = this.children.map(child => child.outerHTML || '').join(''); this.textContent = ''; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    querySelector(selector) {
        if (selector === 'pre.raw-source-text') selector = '.raw-source-text';
        if (selector === 'table') return this.table || (this.table = new Element('table'));
        if (this.panels?.['panel-raw'] && selector === '.raw-source-text') {
            this.rawElement = this.panels['panel-raw'].querySelector('pre'); return this.rawElement;
        }
        if (this.panels?.['panel-json'] && selector !== '.raw-source-text') return this.panels['panel-json'].querySelector('pre');
        const raw = selector === '.raw-source-text' || this.innerHTML.includes('class="raw-source-text"');
        if ((selector === 'pre' || selector === '.raw-source-text' || selector.includes('logs.payload')) && /<pre\b/.test(this.innerHTML)) {
            const key = raw ? 'rawElement' : 'structuredElement';
            if (!this[key]) {
                this[key] = new Element();
                this[key].textContent = this.innerHTML.match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/)?.[1].replace(/\r\n?/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&') || '';
            }
            return this[key];
        }
        return null;
    }
    getBoundingClientRect() { return { top: 0, bottom: 240, height: 240, width: 1000 }; }
    focus() {}
}

/** Isolate each UI test with controllable fetch completion order and local preferences. */
function browser({ search = '', storage = {}, fetch } = {}) {
    const elements = new Map();
    const rows = [];
    const documentListeners = {};
    const windowListeners = {};
    const element = id => {
        if (id.startsWith('panel-') && elements.get('details-pane')?.panels?.[id]) return elements.get('details-pane').panels[id];
        if (!elements.has(id)) { const node = new Element(id); if (id === 'log-workspace') node.clientHeight = 1000; node.focus = () => { context.document.activeElement = node; }; elements.set(id, node); }
        return elements.get(id);
    };
    const location = new URL(`http://localhost/logs-view${search}`);
    const requests = [];
    const pending = [];
    const timers = new Map();
    let timerId = 0;
    const context = vm.createContext({
        URL, URLSearchParams, AbortController, performance, console, queueMicrotask,
        setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
        clearTimeout: id => timers.delete(id),
        setInterval: () => 1, requestAnimationFrame: callback => callback(),
        confirm: () => true,
        localStorage: {
            getItem: key => storage[key] ?? null,
            setItem: (key, value) => { storage[key] = value; }
        },
        navigator: { clipboard: { writeText: async text => { context.copiedText = text; } } },
        cancelEventResize: () => {},
        document: {
            body: new Element('body'),
            getElementById: element,
            querySelectorAll: selector => selector === '.log-row' ? rows : [],
            querySelector: selector => element(selector),
            createDocumentFragment: () => { const node = new Element(); node.fragment = true; return node; },
            addEventListener: (name, handler) => { documentListeners[name] = handler; },
            createElement: tag => { const node = new Element(); node.tagName = tag.toUpperCase(); return node; },
            activeElement: null
        },
        window: {
            location, innerWidth: 1024, addEventListener: (name, handler) => { (windowListeners[name] ||= []).push(handler); },
            history: { replaceState: (_, __, value) => { location.href = new URL(value, location).href; },
                pushState: (_, __, value) => { location.href = new URL(value, location).href; } },
            PCM_HELP_VALUES: require('../../shared/ui/help-values')
        },
        fetch: (url, options = {}) => {
            requests.push({ url, options });
            if (fetch) return fetch(url, options);
            return new Promise(resolve => pending.push(body => resolve({ ok: true, json: async () => body })));
        }
    });
    context.window.PCM_LOG_COLUMNS = require('../../shared/ui/log-columns');
    context.window.PCM_LOG_CLIPBOARD = require('../../shared/ui/log-clipboard');
    context.document.getSelection = () => null;
    context.document.removeEventListener = () => {};
    context.document.body.append = () => {};
    vm.runInContext(scripts[0], context);
    return { context, element, rows, requests, pending, storage, location, documentListeners, timers,
        tick: () => { const pendingTimers = [...timers.values()]; timers.clear(); pendingTimers.forEach(timer => timer.callback()); },
        dispatchWindow: (name, event = {}) => { for (const handler of windowListeners[name] || []) handler(event); },
        run: source => vm.runInContext(source, context),
        set: (name, value) => { context.fixture = value; vm.runInContext(`${name} = fixture;`, context); },
        resizeScript: () => vm.runInContext(scripts[1], context) };
}

/** Canonical fixture carries a selected-record reference without embedding its full payload. */
function entry(overrides = {}) {
    return { id: 'pcm-1', component: 'PCM Core', timestamp: '2026-10-06T11:12:13Z', level: 'INFO', message: 'Request', reference: 'record-ref',
        details: { role: 'pcm', type: 'REQUEST', method: 'POST', url: '/token', flowId: 'flow-1', correlationId: 'corr-1' },
        event: { schemaVersion: '1.0', eventName: 'http.request', source: { componentId: 'pcm-core', role: 'pcm' },
            provenance: { kind: 'emitted' }, correlation: { flowId: 'flow-1', correlationId: 'corr-1' } }, ...overrides };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('native receipt, timeout and work-finish details preserve unknown outcomes without mislabelling a terminal', () => {
    const ui = browser();
    ui.context.record = { event: { source: { role: 'hapi' } }, details: { type: 'HAPI_REQUEST' } };
    assert.match(ui.run('nativeLifecycleNote(record)'), /completion was not observed.*unknown/);
    ui.context.record.details.type = 'HAPI_NATIVE_WORK_FINISHED';
    assert.match(ui.run('nativeLifecycleNote(record)'), /does not establish response delivery, transaction commit/);
    ui.context.record.details.type = 'HAPI_ASYNC_TIMEOUT';
    assert.match(ui.run('nativeLifecycleNote(record)'), /unknown/);
    ui.context.record.details.type = 'HAPI_RESPONSE';assert.equal(ui.run('nativeLifecycleNote(record)'), '');
    ui.context.record.details.type = 'HAPI_REQUEST';ui.context.record.event.source.role = 'pcm';
    assert.equal(ui.run('nativeLifecycleNote(record)'), '');
});

test('template renders safely with labels, scope explanations, and parseable inline JavaScript', () => {
    assert.match(rendered, /test-&lt;team&gt;/);
    assert.equal(scripts.length, 2);
    scripts.forEach((script, index) => assert.doesNotThrow(() => new vm.Script(script, { filename: `logs-${index}.js` })));
    for (const id of ['role', 'healthOrganizationId', 'level', 'method', 'correlationId', 'path', 'status']) {
        assert.ok(rendered.includes(`for="filter-${id}"`));
    }
    assert.match(rendered, /HAPI runtime records include request, permission and selected native error observations/);
    assert.match(rendered, /HAPI import remains a separate source/);
    assert.match(rendered, /Cache hits and direct calls can skip hops/);
    assert.match(rendered, /five retained rotations/);
    assert.match(rendered, /role="separator" tabindex="0"/);
    assert.match(rendered, /onkeydown="selectLogByKeyboard\(event, this\)"/);
    assert.match(rendered, /id="diagnosticsSwitch"/);
});

test('role classes use semantic metadata, never display labels, and palette is separate from severity and marks', () => {
    const ui = browser();
    for (const role of ['pcm', 'doctor', 'gateway', 'adapter', 'hapi', 'hapi-import', 'fhir', 'application', 'middleware', 'security', 'addon']) {
        ui.context.log = { component: 'Organization <custom> name', details: { role } };
        assert.equal(ui.run('roleClass(log)'), `role-${role}`);
        assert.ok(template.includes(`.role-badge.role-${role} {`));
    }
    ui.context.log = { component: 'PCM Core', details: { role: 'x" onclick="alert(1)' } };
    assert.equal(ui.run('roleClass(log)'), 'role-unknown');
    assert.doesNotMatch(template, /\.log-row \.badge\s*\{/);
    assert.equal(ui.run("severityClass('WARN')"), 'severity-warning');
    assert.match(template, /\.log-row\.mark-yellow/);
});

test('selected details retain structured identity and escaped exact malformed raw source text', () => {
    const ui = browser();
    ui.context.selected = entry();
    ui.context.result = { entry: entry({ details: {} }), details: {}, raw: '  {broken <script>alert("x")</script>\r',
        source: { componentId: 'pcm-core', logFile: 'app.log.1', byteOffset: 0 }, provenance: { kind: 'emitted' } };
    const html = ui.run('renderSelectedRecord(selected, result) + renderEventMetadata(selected, result)');
    assert.match(html, /Complete normalized JSON/);
    assert.match(html, /Exact raw source text/);
    assert.match(html, /Schema version<\/dt><dd>1.0/);
    assert.match(html, /Source byte offset<\/dt><dd>0/);
    assert.match(html, /app.log.1/);
    assert.match(html, /\{broken &lt;script&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
});

test('derived gateway details identify the source response and preserve the selected request identity', () => {
    const ui = browser();
    const selected = entry({ id: 'gateway-req', component: 'HO A Gateway', details: { role: 'gateway', type: 'GATEWAY_REQUEST', method: 'GET', url: '/Patient' },
        event: { schemaVersion: '1.0', eventName: 'gateway.request', source: { componentId: 'ho-a-gateway', role: 'gateway', healthOrganizationId: 'ho-a' },
            provenance: { kind: 'derived', derivedFrom: 'gateway.response' } } });
    ui.context.selected = selected;
    ui.context.result = { entry: selected, raw: '{"type":"GATEWAY_RESPONSE","status":200}',
        source: { componentId: 'ho-a-gateway', logFile: 'access.log', byteOffset: 45 } };
    const html = ui.run('renderSelectedRecord(selected, result) + renderEventMetadata(selected, result)');
    assert.match(ui.run('formatLogMessage(selected)'), /^Derived Gateway Request:/);
    assert.match(html, /Derived gateway request: reconstructed/);
    assert.match(html, /no separately captured raw request/);
    assert.match(html, /gateway-req/);
    assert.match(html, /GATEWAY_RESPONSE/);
    assert.match(html, /Source identity<\/dt><dd>ho-a-gateway · gateway · ho-a/);
});

test('emitted gateway request keeps its own raw source without a reconstruction disclosure', () => {
    const ui = browser();
    const selected = entry({ details: { role: 'gateway', type: 'GATEWAY_REQUEST', arrivalId: 'a'.repeat(32) },
        event: { schemaVersion: '1.0', source: { componentId: 'ho-a-gateway', role: 'gateway' }, provenance: { kind: 'emitted' } } });
    ui.context.selected = selected;
    ui.context.result = { entry: selected, raw: '{"details":{"type":"GATEWAY_REQUEST"}}' };
    const html = ui.run('renderSelectedRecord(selected, result) + renderEventMetadata(selected, result)');
    assert.match(html, /Exact raw source text/);
    assert.match(html, /emitted/);
    assert.match(ui.run('formatLogMessage(selected)'), /^Gateway Request:/);
    assert.doesNotMatch(ui.run('formatLogMessage(selected)'), /Derived/);
    assert.doesNotMatch(html, /Derived gateway request|source text belongs to the gateway response|no separately captured raw request/);
});

test('legacy records expose missing raw explicitly, and an empty details object cannot hide raw text', () => {
    const ui = browser();
    ui.context.selected = entry({ event: undefined });
    ui.context.result = { details: {}, raw: 'not JSON <failure>' };
    assert.match(ui.run('renderSelectedRecord(selected, result)'), /not JSON &lt;failure&gt;/);
    assert.match(ui.run('renderSelectedRecord(selected)'), /Raw source text is unavailable/);
    assert.match(ui.run('renderEventMetadata(selected)'), /Legacy record \(no event schema\)/);
});

test('page-only ID groups count all exact recorded IDs and observed roles without inventing completeness', () => {
    const ui = browser();
    ui.context.entries = [entry(), entry({ id: 'g', level: 'WARN', details: { role: 'gateway', type: 'GATEWAY_REQUEST', flowId: 'flow-1' },
        event: { source: { role: 'gateway', healthOrganizationId: 'ho-a' }, provenance: { kind: 'derived' }, correlation: { flowId: 'flow-1' } } }),
        entry({ id: 'unlinked', event: undefined, details: {} })];
    const summary = ui.run('pageJourneySummary(entries)');
    assert.equal(summary.groups.length, 2);
    assert.equal(summary.uncorrelated, 1);
    assert.equal(summary.groups[0].count, 2);
    assert.deepEqual([...summary.groups[0].roles], ['pcm', 'gateway']);
    assert.equal(summary.groups[0].complete, undefined);
    assert.equal(summary.groups[0].missingRoles, undefined);
});

test('coverage reasons and source inventory remain truthful, bounded, and text safe', () => {
    const ui = browser();
    ui.set('currentLogs', [entry()]);
    ui.context.result = { coverage: { scope: 'page', state: 'partial', reasons: ['older-records', 'filtered-view', 'oversized-records'], rowLimit: 200 },
        sources: [{ componentId: '<injected>', label: 'HO HAPI', role: 'hapi-import', healthOrganizationId: 'ho-a', coverage: 'import-only', state: 'missing' }] };
    ui.run('renderPageCoverage(result)');
    assert.match(ui.element('page-coverage').textContent, /Evidence in the loaded page: 1 events/);
    assert.match(ui.element('page-coverage').textContent, /never-recorded events cannot be recovered/);
    assert.match(ui.element('page-coverage').textContent, /Oversized records were omitted/);
    assert.match(ui.element('source-list').innerHTML, /missing · import-only/);
    assert.match(ui.element('source-list').innerHTML, /&lt;injected&gt;/);
    assert.doesNotMatch(ui.element('source-list').innerHTML, /<injected>/);
    ui.context.result = { coverage: { scope: 'page', state: 'bounded', reasons: [] } };
    ui.run('renderPageCoverage(result)');
    assert.match(ui.element('page-coverage').textContent, /^Evidence in the loaded page/);
    assert.doesNotMatch(ui.element('page-coverage').textContent, /complete/i);
});

test('Diagnostics is opt-in and an explicit OFF URL overrides a stored ON preference', () => {
    for (const [search, storage, expected] of [
        ['', {}, false], ['', { showDiagnosticUnifiedLogs: 'true' }, true],
        ['?diagnostics=false', { showDiagnosticUnifiedLogs: 'true' }, false], ['?diagnostics=true', {}, true]
    ]) {
        const ui = browser({ search, storage });
        ui.run('loadMarkedLogs()');
        assert.equal(ui.run('showDiagnosticLogs'), expected);
    }
});

test('filter controls restore unknown roles and apply exact values in a fresh snapshot', async () => {
    const ui = browser({ search: '?role=custom-role&healthOrganizationId=ho-a' });
    ui.element('filter-role').tagName = 'SELECT';
    ui.run('loadFilters()');
    assert.equal(ui.element('filter-role').value, 'custom-role');
    assert.equal(ui.element('filter-role').options[0].textContent, 'custom-role');
    ui.set('pageCursor', 'old-cursor');
    ui.element('filter-path').value = '/api/path';
    ui.run('applyFilters()');
    assert.equal(ui.run('pageCursor'), '');
    const request = new URL(ui.requests[0].url, ui.location);
    assert.equal(request.searchParams.get('role'), 'custom-role');
    assert.equal(request.searchParams.get('healthOrganizationId'), 'ho-a');
    assert.equal(request.searchParams.get('path'), '/api/path');
    assert.equal(request.searchParams.has('cursor'), false);
    assert.equal(request.searchParams.get('diagnostics'), 'false');
    ui.pending[0]({ entries: [] });
    await settle();
});

test('bounded page rendering forwards filters, adds metadata, and performs no eager detail reads', async () => {
    const ui = browser({ search: '?role=pcm&level=ERROR&method=POST&correlationId=corr-1&status=500&path=%2Ftoken' });
    const work = ui.run('refreshLogs(true)');
    assert.equal(ui.requests.length, 1);
    for (const [name, value] of [['role', 'pcm'], ['level', 'ERROR'], ['method', 'POST'], ['correlationId', 'corr-1'], ['status', '500'], ['path', '/token']]) {
        assert.equal(new URL(ui.requests[0].url, ui.location).searchParams.get(name), value);
    }
    ui.pending[0]({ entries: [entry({ message: '<unsafe>' })], rowLimit: 200, nextCursor: 'older', coverage: { scope: 'page', state: 'partial', reasons: ['older-records'] } });
    await work;
    const html = ui.element('log-table-body').innerHTML;
    assert.match(html, /role-badge role-pcm/);
    assert.match(html, /component-cell/);
    assert.doesNotMatch(html, /schema 1.0 · emitted/);
    assert.match(html, /tabindex="0"/);
    assert.equal(ui.requests.length, 1);
    assert.equal(ui.run('nextCursor'), 'older');
    assert.doesNotMatch(template, /id="older-logs"/);
});

test('newer navigation beats delayed pages and history keeps background latest checks', async () => {
    const ui = browser();
    const old = ui.run('refreshLogs(true)');
    const latest = ui.run('refreshLogs(true)');
    assert.equal(ui.requests[0].options.signal.aborted, true);
    ui.pending[1]({ entries: [entry({ id: 'latest' })], nextCursor: 'next' });
    await latest;
    ui.pending[0]({ entries: [entry({ id: 'stale' })] });
    await old;
    assert.equal(ui.run('currentLogs[0].id'), 'latest');
    ui.run('holdReading(); maybeLoadHistory()');
    assert.equal(new URL(ui.requests[2].url, ui.location).searchParams.get('cursor'), 'next');
    ui.pending[2]({ entries: [entry({ id: 'older' })] });
    await settle();
    const background = ui.run('refreshLogs()');
    assert.equal(ui.requests.length, 4);
    assert.equal(new URL(ui.requests[3].url, ui.location).searchParams.has('cursor'), false);
    ui.pending[3]({ entries: [entry({ id: 'fresh-latest' })] });
    await background;
    assert.match(ui.element('view-state').textContent, /Position held/);
    ui.run("setLogOrderMode('timeline')");
    assert.equal(ui.run('pageCursor'), '');
    assert.equal(new URL(ui.requests[4].url, ui.location).searchParams.has('cursor'), false);
    ui.pending[4]({ entries: [] });
    await settle();
});

test('A to B to A selection race cannot overwrite the newest details and raw CR/LF stays exact', async () => {
    const ui = browser();
    const a = entry({ id: 'a', reference: 'a-ref' });
    const b = entry({ id: 'b', reference: 'b-ref' });
    ui.set('currentLogs', [a, b]);
    ui.context.row = new Element('row');
    const first = ui.run("selectLog('a', row)");
    const middle = ui.run("selectLog('b', row)");
    const newest = ui.run("selectLog('a', row)");
    assert.equal(ui.requests[0].options.signal.aborted, true);
    assert.equal(ui.requests[1].options.signal.aborted, true);
    const exact = '\n  newest raw\r\n';
    ui.pending[2]({ entry: a, raw: exact });
    await newest;
    ui.pending[1]({ entry: b, raw: 'stale B' });
    ui.pending[0]({ entry: a, raw: 'stale A' });
    await Promise.all([first, middle]);
    assert.match(ui.element('details-pane').innerHTML, /newest raw/);
    assert.doesNotMatch(ui.element('details-pane').innerHTML, /stale [AB]/);
    assert.equal(ui.element('details-pane').rawElement.textContent, exact);
    assert.equal(ui.element('details-pane').getAttribute('aria-busy'), 'false');
});

test('page navigation invalidates pending selected details and position holding preserves the selected record', async () => {
    const ui = browser();
    const selected = entry();
    ui.set('currentLogs', [selected]);
    ui.context.row = new Element('row');
    const detail = ui.run("selectLog('pcm-1', row)");
    ui.run('holdReading()');
    assert.equal(ui.requests[0].options.signal.aborted, false);
    ui.pending[0]({ entry: selected, raw: 'held record' });
    await detail;
    assert.match(ui.element('details-pane').innerHTML, /held record/);
    ui.set('currentLogs', [selected]);
    const secondDetail = ui.run("selectLog('pcm-1', row)");
    const page = ui.run('refreshLogs(true, true)');
    ui.pending[1]({ entry: selected, raw: 'stale selected payload' });
    await secondDetail;
    assert.doesNotMatch(ui.element('details-pane').innerHTML, /stale selected payload/);
    ui.pending[2]({ entries: [] });
    await page;
    assert.equal(ui.run('selectedId'), null);
});

test('clear while held discards pages, selected payloads, and coverage before late reads can arrive', async () => {
    const ui = browser();
    ui.set('currentLogs', [entry()]);
    ui.run('holdReading()');
    ui.context.row = new Element('row');
    const detail = ui.run("selectLog('pcm-1', row)");
    const clearing = ui.run('clearLogs()');
    assert.equal(ui.requests[1].options.method, 'POST');
    ui.pending[1]({ status: 'cleared' });
    await clearing;
    ui.pending[0]({ entry: entry(), raw: 'old secret payload' });
    await detail;
    assert.equal(ui.run('currentLogs.length'), 0);
    assert.equal(ui.run('selectedId'), null);
    assert.equal(ui.element('log-table-body').innerHTML, '');
    assert.doesNotMatch(ui.element('details-pane').innerHTML, /old secret payload/);
    assert.match(ui.element('page-coverage').textContent, /No page loaded after clear/);
    const requestsAfterClear = ui.requests.length;
    ui.run('refreshLogs()');
    assert.equal(ui.requests.length, requestsAfterClear, 'interval polling cannot refill an empty held view after clear');
    const fresh = ui.run('followLatest()');
    assert.equal(ui.requests.length, requestsAfterClear + 1, 'an explicit request can load a fresh snapshot');
    ui.pending[requestsAfterClear]({ entries: [entry({ id: 'fresh-after-clear' })] });
    await fresh;
    await settle();
    assert.equal(ui.run('currentLogs[0].id'), 'fresh-after-clear');
});

test('keyboard selection and splitter controls support Enter, Space, arrows, Home, and End', () => {
    const ui = browser();
    ui.context.calls = [];
    ui.run('selectLog = (id) => calls.push(id)');
    ui.context.row = new Element('row');
    ui.context.row.setAttribute('data-log-id', 'a%2Fb');
    ui.context.event = { key: 'Enter', preventDefault() { this.prevented = true; } };
    ui.run('selectLogByKeyboard(event, row)');
    assert.deepEqual([...ui.context.calls], ['a/b']);
    assert.equal(ui.context.event.prevented, true);
    ui.context.event.key = ' ';
    ui.run('selectLogByKeyboard(event, row)');
    assert.equal(ui.context.calls.length, 2);
    ui.resizeScript();
    const splitter = ui.element('resizer');
    ui.run('resizeEventPane(60, false)');
    for (const [key, expected] of [['ArrowDown', '55'], ['ArrowUp', '60'], ['Home', '25'], ['End', '70']]) {
        splitter.listeners.keydown({ key, preventDefault() {} });
        assert.equal(splitter.getAttribute('aria-valuenow'), expected);
        assert.equal(ui.element('event-detail').style.height, `${expected}%`);
    }
});

test('AWS-safe projections are clearly distinct from exact raw and parse failures remain visible', () => {
    const ui = browser();
    ui.context.selected = entry();
    ui.context.result = { entry: entry(), raw: '[withheld]', rawRedacted: true, parseError: 'Malformed external JSON' };
    const html = ui.run('renderSelectedRecord(selected, result) + renderEventMetadata(selected, result)');
    assert.match(html, /AWS-safe source projection; original raw withheld\/blocked/);
    assert.doesNotMatch(html, /<h3 class="h6">Exact raw source text<\/h3>/);
    assert.match(html, /Malformed external JSON/);
    assert.match(html, /\[withheld\]/);
});

test('flow and trace filters are exact and journey links preserve Diagnostics without unrelated filters', async () => {
    const traceId = '1234567890abcdef1234567890abcdef';
    const ui = browser({ search: `?flowId=flow-1&traceId=${traceId}&role=pcm&diagnostics=false&status=500` });
    ui.run('loadFilters()');
    assert.equal(ui.element('filter-flowId').value, 'flow-1');
    assert.equal(ui.element('filter-traceId').value, traceId);
    const work = ui.run('refreshLogs(true)');
    const params = new URL(ui.requests[0].url, ui.location).searchParams;
    assert.equal(params.get('flowId'), 'flow-1');
    assert.equal(params.get('traceId'), traceId);
    ui.pending[0]({ entries: [] });
    await work;
    const target = new URL(ui.run("inspectJourneyUrl('flowId', 'flow <one>')"), ui.location);
    assert.equal(target.searchParams.get('flowId'), 'flow <one>');
    assert.equal(target.searchParams.get('diagnostics'), 'false');
    assert.equal(target.searchParams.has('role'), false);
    assert.equal(target.searchParams.has('traceId'), false);
    assert.equal(target.searchParams.has('status'), false);
    ui.context.entries = [entry({ event: { correlation: { traceId } }, details: { role: 'application' } })];
    assert.equal(ui.run('pageJourneySummary(entries).groups[0].kind'), 'Trace');
});

test('failed older snapshot has an actionable empty state instead of stale rows or endless loading', async () => {
    const ui = browser({ fetch: async () => ({ ok: false, json: async () => ({ error: 'Logs rotated; return to Latest' }) }) });
    ui.set('currentLogs', [entry()]);
    ui.set('pageCursor', 'expired-cursor');
    await ui.run('refreshLogs(true, true)');
    assert.equal(ui.run('currentLogs.length'), 0);
    assert.match(ui.element('log-status').textContent, /Logs rotated/);
    assert.match(ui.element('log-table-body').innerHTML, /Jump to latest to retry/);
    assert.match(ui.element('page-coverage').textContent, /coverage cannot be determined/);
    assert.equal(ui.element('log-list').getAttribute('aria-busy'), 'false');
});

test('synchronous page-read initiation failure is contained, releases busy state and permits retry', async () => {
    let fail = true;
    const ui = browser({ fetch: () => {
        if (fail) throw new Error('Synchronous fetch initiation failure');
        return Promise.resolve({ ok: true, json: async () => ({ entries: [entry()] }) });
    } });
    let read;
    assert.doesNotThrow(() => { read = ui.run('refreshLogs(true, true)'); });
    await read;
    assert.match(ui.element('log-status').textContent, /Log read failed: Synchronous fetch initiation failure/);
    assert.match(ui.element('log-table-body').innerHTML, /Jump to latest to retry/);
    assert.match(ui.element('page-coverage').textContent, /coverage cannot be determined/);
    assert.equal(ui.element('log-list').getAttribute('aria-busy'), 'false');
    assert.equal(ui.run('activeRead'), null);
    fail = false;
    await ui.run('refreshLogs()');
    assert.equal(ui.requests.length, 2, 'the failed start must not block later polling');
    assert.equal(ui.run('currentLogs[0].id'), 'pcm-1');
    assert.equal(ui.element('log-list').getAttribute('aria-busy'), 'false');
});

test('synchronous poll initiation failure retains the held page, selection, exact raw and coverage', async () => {
    let fail = false;
    const raw = 'source\r\n<exact>\r\n';
    const selected = entry();
    const ui = browser({ fetch: url => {
        if (fail) throw new Error('Synchronous poll initiation failure');
        const result = url.includes('/detail?') ? { entry: selected, raw } : { entries: [entry({ id: 'new-page' })] };
        return Promise.resolve({ ok: true, json: async () => result });
    } });
    ui.context.result = { entries: [selected], nextCursor: 'held-older', coverage: { state: 'bounded', rowLimit: 200, reasons: [] } };
    ui.run('applyLogResult(result)');
    await ui.run("selectLog('pcm-1', null)");
    const html = ui.element('log-table-body').innerHTML;
    const coverage = ui.element('page-coverage').textContent;
    const details = ui.element('details-pane').innerHTML;
    fail = true;
    let read;
    assert.doesNotThrow(() => { read = ui.run('refreshLogs()'); });
    await read;
    assert.match(ui.element('log-status').textContent, /showing the previous successful snapshot/);
    assert.equal(ui.element('log-table-body').innerHTML, html);
    assert.equal(ui.element('page-coverage').textContent, coverage);
    assert.equal(ui.element('details-pane').innerHTML, details);
    assert.equal(ui.element('details-pane').rawElement.textContent, raw);
    assert.equal(ui.run('selectedId'), selected.id);
    assert.equal(ui.run('nextCursor'), 'held-older');
    assert.equal(ui.run('activeRead'), null);
    assert.equal(ui.element('log-list').getAttribute('aria-busy'), 'false');
    fail = false;
    await ui.run('refreshLogs(true)');
    assert.equal(ui.run('currentLogs[0].id'), 'new-page');
    assert.equal(ui.run('selectedId'), selected.id);
    assert.equal(ui.element('details-pane').rawElement.textContent, raw);
});

test('superseded synchronous read failure cannot clear a newer request or replace its status', async () => {
    let complete;
    let starts = 0;
    const ui = browser({ fetch: () => {
        if (++starts === 1) throw new Error('Superseded initiation failure');
        return new Promise(resolve => { complete = () => resolve({ ok: true, json: async () => ({ entries: [entry({ id: 'newest' })] }) }); });
    } });
    let old;
    assert.doesNotThrow(() => { old = ui.run('refreshLogs(true)'); });
    const current = ui.run('refreshLogs(true)');
    const controller = ui.run('activeRead');
    ui.element('log-status').textContent = 'New request pending';
    await old;
    assert.equal(ui.element('log-status').textContent, 'New request pending');
    assert.equal(ui.run('activeRead'), controller);
    assert.equal(ui.element('log-list').getAttribute('aria-busy'), 'true');
    complete();
    await current;
    assert.equal(ui.run('currentLogs[0].id'), 'newest');
    assert.equal(ui.run('activeRead'), null);
    assert.equal(ui.element('log-list').getAttribute('aria-busy'), 'false');
});

test('partial clear failure discards the stale snapshot and provides recovery instructions', async () => {
    const ui = browser({ fetch: async () => ({ ok: false, json: async () => ({ status: 'partial', results: [{ component: 'ho-a', status: 'failed', error: 'permission denied' }] }) }) });
    ui.set('currentLogs', [entry()]);
    await ui.run('clearLogs()');
    assert.equal(ui.run('currentLogs.length'), 0);
    assert.match(ui.element('log-status').textContent, /ho-a: permission denied/);
    assert.match(ui.element('page-coverage').textContent, /Clear failed or was partial/);
    assert.match(ui.element('page-coverage').textContent, /Jump to latest/);
});

test('clear acknowledgement reports retained read-only extensions without claiming they were deleted', async () => {
    const ui = browser({ fetch: async () => ({ ok: true, json: async () => ({ status: 'cleared', results: [
        { component: 'pcm-core', status: 'cleared' }, { component: 'extensions/security', status: 'retained' }
    ] }) }) });
    await ui.run('clearLogs()');
    assert.match(ui.element('log-status').textContent, /1 read-only extension source\(s\) retained: extensions\/security/);
    assert.match(ui.element('details-pane').innerHTML, /Retained extension events may reappear/);
    assert.doesNotMatch(ui.element('log-status').textContent, /Subsequent rows are newly written/);
    assert.match(template, /Read-only extension logs are retained/);
});


test('selected Event ID and Flow ID metadata retain their authored help bindings', () => {
    const ui = browser();
    ui.context.selected = entry();
    const html = ui.run('renderEventMetadata(selected)');
    assert.match(html, /<dt data-help-key="logs.id">Event ID<\/dt><dd>pcm-1<\/dd>/);
    assert.match(html, /<dt data-help-key="logs.flow-id">Flow ID<\/dt><dd>flow-1<\/dd>/);
});

test('reading holds incoming pages, selected details and cursor until Jump to latest is explicit', async () => {
    const ui = browser();
    const selected = entry();
    ui.context.result = { entries: [selected], nextCursor: 'held-older', bytesRead: 100 };
    ui.run('applyLogResult(result, true); holdReading()');
    ui.set('selectedId', selected.id); ui.set('selectedRecord', selected);
    ui.element('details-pane').innerHTML = 'Selected immutable payload';
    const html = ui.element('log-table-body').innerHTML;
    const poll = ui.run('refreshLogs()');
    ui.pending[0]({ entries: [entry({ id: 'new-event' })], nextCursor: 'new-older', bytesRead: 200 });
    await poll;
    assert.equal(ui.element('log-table-body').innerHTML, html);
    assert.equal(ui.element('details-pane').innerHTML, 'Selected immutable payload');
    assert.equal(ui.run('nextCursor'), 'held-older');
    assert.equal(ui.element('follow-latest').textContent, '1 new on page · Jump to latest');
    assert.match(ui.element('view-state').textContent, /Position held/);
    ui.run('followLatest()');
    assert.equal(ui.run('currentLogs[0].id'), 'new-event');
    assert.equal(ui.run('nextCursor'), 'new-older');
    assert.equal(ui.run('selectedId'), selected.id);
    assert.equal(ui.element('details-pane').innerHTML, 'Selected immutable payload');
    ui.run("openEventDetail()");
    assert.equal(ui.element('selection-state').hidden, false);
    assert.match(ui.element('selection-state').textContent, /outside the current page/);
});

test('scroll prefetch is single-flight, retains filters, and applies only at the older edge', async () => {
    const ui = browser({ search: '?role=doctor&path=%2Ffhir&status=200&diagnostics=false' });
    ui.context.result = { entries: [entry()], nextCursor: 'snapshot-1' };
    ui.run('applyLogResult(result); holdReading()');
    ui.element('log-list').scrollHeight = 1000;
    const work = ui.run('maybeLoadHistory()');
    ui.run('maybeLoadHistory()');
    assert.equal(ui.requests.length, 1);
    const params = new URL(ui.requests[0].url, ui.location).searchParams;
    for (const [key, value] of [['cursor', 'snapshot-1'], ['role', 'doctor'], ['path', '/fhir'], ['status', '200'], ['diagnostics', 'false']]) assert.equal(params.get(key), value);
    ui.pending[0]({ entries: [entry({ id: 'older' })], nextCursor: 'snapshot-2' }); await work;
    assert.equal(ui.run('currentLogs.length'), 1);
    assert.equal(ui.run('prefetchedPage.cursor'), 'snapshot-1');
    ui.element('log-list').scrollTop = 500;
    await ui.run('maybeLoadHistory()');
    assert.equal(ui.run('currentLogs.length'), 2);
    assert.equal(ui.run('prefetchedPage'), null);
    assert.equal(ui.element('log-list').scrollTop, 500);
    assert.equal(ui.requests.length, 1);
});

for (const tail of ['top', 'bottom']) test(`history ${tail} deduplicates pages and caps cache/rendering at 600 rows without discarding details`, () => {
    const ui = browser();
    ui.set('logTailPosition', tail);
    ui.context.result = { entries: Array.from({ length: 200 }, (_, id) => entry({ id: `page-0-${id}` })), nextCursor: 'page-1' };
    ui.run('applyLogResult(result); selectedId = currentLogs[0].id; selectedRecord = currentLogs[0]');
    ui.element('details-pane').innerHTML = 'Retained immutable details';
    for (let page = 1; page <= 8; page++) {
        // Real layout is covered in Playwright; this model marks all rows in the
        // newer cached pages as fully offscreen for the eviction guard.
        for (const row of ui.run('currentLogs')) ui.element(ui.run(`logRowId(${JSON.stringify(row.id)})`)).getBoundingClientRect = () => ({ top: -100, bottom: -50 });
        ui.context.older = { entries: Array.from({ length: 200 }, (_, id) => entry({ id: `page-${page}-${id}` })), nextCursor: `page-${page + 1}`, previousCursor: `previous-${page}` };
        assert.equal(ui.run(`applyHistoryPage(older, 'page-${page}')`), true);
        assert.ok(ui.run('logPages.length') <= 3);
        assert.ok(ui.run('currentLogs.length') <= 600);
        assert.equal(new Set(ui.run('currentLogs').map(row => row.id)).size, ui.run('currentLogs.length'));
    }
    assert.equal(ui.run('currentLogs.length'), 600);
    assert.equal(ui.run('currentLogs[0].id'), tail === 'top' ? 'page-6-0' : 'page-8-0');
    assert.ok(ui.run('previousCursor'));
    assert.doesNotMatch(template, /id="footer-hint"/);
    assert.equal(ui.element('details-pane').innerHTML, 'Retained immutable details');
    const count = ui.run('currentLogs.length');
    ui.context.older = { entries: [ui.run('currentLogs[0]'), ui.run('currentLogs[0]')], nextCursor: null };
    ui.run("applyHistoryPage(older, 'final')");
    assert.equal(ui.run('currentLogs.length'), count);
    assert.equal(ui.run('nextCursor'), null);
    assert.equal(ui.run('nextCursor'), null);
});

test('eviction defers while the newest page is visible or contains keyboard focus', () => {
    const ui = browser();
    ui.context.result = { entries: [entry()], nextCursor: 'next' };
    ui.run('applyLogResult(result); logPages = [result, result, result]');
    assert.equal(ui.run('canEvictPage()'), false);
    const row = ui.element(ui.run('logRowId(currentLogs[0].id)'));
    row.getBoundingClientRect = () => ({ top: -100, bottom: -50 });
    row.focus();
    assert.equal(ui.run('canEvictPage()'), false);
    ui.context.document.activeElement = null;
    assert.equal(ui.run('canEvictPage()'), true);
});

test('empty filtered continuations are paced, terminate at EOF and never cache empty pages', async () => {
    const ui = browser();
    ui.context.result = { entries: [], nextCursor: 'empty-1' };
    ui.run('applyLogResult(result)');
    for (let index = 1; index <= 5; index++) {
        assert.equal(ui.timers.size, 1);
        assert.equal([...ui.timers.values()][0].delay, 200);
        ui.tick();
        assert.equal(ui.requests.length, index);
        ui.pending[index - 1]({ entries: [], nextCursor: index === 5 ? null : `empty-${index + 1}` });
        await settle();
        assert.equal(ui.run('logPages.length'), 1);
        assert.equal(ui.run('currentLogs.length'), 0);
    }
    ui.tick();
    assert.equal(ui.requests.length, 5);
    assert.equal(ui.run('nextCursor'), null);
});

test('navigation, Jump to latest and clear cancel delayed history reads and their timers', async () => {
    for (const action of ['followLatest()', "applyFilters(null, true)", 'clearLogs()']) {
        const ui = browser();
        ui.context.result = { entries: [entry()], nextCursor: 'old-snapshot' };
        ui.run('applyLogResult(result)');
        const old = ui.run('maybeLoadHistory()');
        ui.run(action);
        assert.equal(ui.requests[0].options.signal.aborted, true);
        ui.pending[0]({ entries: [entry({ id: 'stale-history' })] }); await old;
        assert.equal(ui.run("currentLogs.some(row => row.id === 'stale-history')"), false);
        if (action === 'clearLogs()') ui.pending[1]({ status: 'cleared', results: [] });
        else ui.pending[1]({ entries: [entry({ id: 'new-view' })] });
        await settle();
        assert.equal(ui.run('historyRead'), null);
    }
});

test('failed and non-advancing history reads retain rows/cursor without a retry loop', async () => {
    for (const failure of ['synchronous', 'cursor']) {
        const ui = browser();
        ui.context.result = { entries: [entry()], nextCursor: 'same-cursor' };
        ui.run('applyLogResult(result)');
        if (failure === 'synchronous') ui.run("fetch = () => { throw new Error('Synthetic history failure'); }");
        const work = ui.run('maybeLoadHistory()');
        if (failure === 'cursor') ui.pending[0]({ entries: [], nextCursor: 'same-cursor' });
        await work;
        assert.equal(ui.run('nextCursor'), 'same-cursor');
        assert.equal(ui.run('currentLogs.length'), 1);
        assert.match(ui.element('log-status').textContent, /Scroll to retry/);
        ui.tick();
        assert.equal(ui.run('historyRead'), null);
        assert.equal(ui.timers.size, 0);
    }
});

test('the actual live edge resumes following and an evicted newer edge keeps reading', () => {
    const ui = browser();
    ui.context.result = { entries: [entry()], nextCursor: null };
    ui.run("applyLogResult(result); holdReading(); historyDirection = 'newer'; handleLogScroll()");
    assert.equal(ui.run('followingLatest'), true);
    ui.run("holdReading(); previousCursor = 'newer-page'; handleLogScroll()");
    assert.equal(ui.run('followingLatest'), false);
});

test('history restores the bounded multi-page window, coverage and continuation without mutating the saved view', () => {
    const ui = browser();
    ui.context.result = { entries: [entry()], nextCursor: 'older-1' };
    ui.context.older = { entries: [entry({ id: 'older-event' })], nextCursor: 'older-2' };
    ui.run("applyLogResult(result); applyHistoryPage(older, 'older-1'); saveCurrentView()");
    ui.context.saved = ui.run('captureView()');
    ui.context.other = { entries: [entry({ id: 'another-view' })] };
    ui.run('applyLogResult(other); restoreView(saved)');
    assert.equal(ui.run('currentLogs.length'), 2);
    assert.equal(ui.run('logPages.length'), 2);
    assert.equal(ui.run('nextCursor'), 'older-2');
    assert.match(ui.element('page-coverage').textContent, /loaded window: 2 events/i);
    ui.context.more = { entries: [entry({ id: 'next-event' })], nextCursor: null };
    ui.run("applyHistoryPage(more, 'older-2')");
    assert.equal(ui.run('saved.logPages.length'), 2);
    assert.equal(ui.run('saved.result.entries.length'), 2);
    assert.equal(ui.run('saved.nextCursor'), 'older-2');
});

test('position holding keeps selection while background checks and scroll continuations continue', async () => {
    const ui = browser();
    ui.context.result = { entries: [entry()], nextCursor: 'older-1' };
    ui.run('applyLogResult(result); selectedId = currentLogs[0].id; holdReading()');
    const poll = ui.run('refreshLogs()');
    ui.pending[0]({ entries: [entry({ id: 'newer-event' })] }); await poll;
    assert.equal(ui.run('currentLogs[0].id'), 'pcm-1');
    assert.equal(ui.run('queuedResult.entries[0].id'), 'newer-event');
    const work = ui.run('maybeLoadHistory()');
    ui.pending[1]({ entries: [entry({ id: 'older-event' })], nextCursor: null }); await work;
    assert.equal(ui.run('currentLogs.length'), 2);
    assert.equal(ui.run('selectedId'), 'pcm-1');
    assert.match(ui.element('view-state').textContent, /Position held/);
});

test('live checks buffer separately from a history window and Jump to latest releases that window', async () => {
    const ui = browser();
    ui.context.result = { entries: [entry()], nextCursor: 'older-1' };
    ui.context.older = { entries: [entry({ id: 'older-event' })], nextCursor: null };
    ui.run("applyLogResult(result); holdReading(); applyHistoryPage(older, 'older-1')");
    const html = ui.element('log-table-body').innerHTML;
    const work = ui.run('refreshLogs()');
    ui.pending[0]({ entries: [entry({ id: 'fresh-event' }), entry()], nextCursor: 'fresh-history' }); await work;
    assert.equal(ui.element('log-table-body').innerHTML, html);
    assert.equal(ui.run('logPages.length'), 2);
    assert.match(ui.element('follow-latest').textContent, /1 new on page · Jump to latest/);
    ui.run('followLatest()');
    assert.equal(ui.run('logPages.length'), 1);
    assert.equal(ui.run('queuedResult'), null);
    assert.equal(ui.run('currentLogs[0].id'), 'fresh-event');
    assert.equal(ui.run('nextCursor'), 'fresh-history');
    assert.equal(ui.run('pageCursor'), '');
});

for (const tail of ['top', 'bottom']) test(`checkpoint catch-up ${tail} accepts every burst page before advancing with bounded memory`, async () => {
    const ui = browser();
    ui.set('logTailPosition', tail);
    ui.context.result = { entries: [entry()], liveCursor: 'live-0', resumeCursor: 'resume-0', nextCursor: 'older-0' };
    ui.run('applyLogResult(result, true)');
    ui.element('log-list').scrollHeight = 20000;
    const seen = new Set();
    for (let page = 0; page < 5; page++) {
        for (const row of ui.run('currentLogs')) ui.element(ui.run(`logRowId(${JSON.stringify(row.id)})`)).getBoundingClientRect = () => ({ top: -100, bottom: -50 });
        const work = ui.run('catchUpLive()');
        assert.equal(new URL(ui.requests[page].url, ui.location).searchParams.get('cursor'), page ? `next-${page}` : 'live-0');
        const rows = Array.from({ length: 200 }, (_, index) => entry({ id: `new-${page * 200 + index}` }));
        ui.pending[page]({ entries: rows, previousCursor: page === 4 ? null : `next-${page + 1}`, liveCursor: `live-${page + 1}`, resumeCursor: `resume-${page + 1}`, nextCursor: `older-${page + 1}` });
        await work;
        rows.forEach(row => { assert.equal(seen.has(row.id), false); seen.add(row.id); });
        assert.equal(ui.run('liveAnchor.liveCursor'), `live-${page + 1}`);
        assert.ok(ui.run('currentLogs.length') <= 600); assert.ok(ui.run('logPages.length') <= 3);
        assert.equal(ui.run('catchingUp'), page !== 4);
    }
    assert.equal(seen.size, 1000);
    assert.equal(ui.run('followingLatest'), true);
});

test('a scroll during live catch-up retains reading position and schedules the requested history edge', async () => {
    const ui = browser();
    ui.context.result = { entries: [entry()], liveCursor: 'live-0', resumeCursor: 'resume-0', nextCursor: 'older-0' };
    ui.run('applyLogResult(result, true)');
    const work = ui.run('catchUpLive()');
    ui.element('log-list').scrollTop = 150;
    ui.run("holdReading(); historyDirection = 'older'");
    ui.pending[0]({ entries: [entry({ id: 'new-event' })], previousCursor: 'next-1', liveCursor: 'live-1', resumeCursor: 'resume-1' }); await work;
    assert.equal(ui.element('log-list').scrollTop, 150);
    assert.equal(ui.run('followingLatest'), false);
    assert.ok(ui.run('historyTimer') !== null);
});

test('explicit read invalidation or filter navigation aborts catch-up without acknowledging its unseen response', async () => {
    for (const action of ['invalidateReads(false); holdReading()', 'applyFilters(null, true)']) {
        const ui = browser();
        ui.context.result = { entries: [entry()], liveCursor: 'live-0', resumeCursor: 'resume-0' };
        ui.run('applyLogResult(result, true)');
        const work = ui.run('catchUpLive()');
        ui.run(action);
        assert.equal(ui.requests[0].options.signal.aborted, true);
        ui.pending[0]({ entries: [entry({ id: 'unseen-late' })], liveCursor: 'live-late', resumeCursor: 'resume-late' }); await work;
        assert.equal(ui.run("currentLogs.some(row => row.id === 'unseen-late')"), false);
        assert.notEqual(ui.run('liveAnchor?.liveCursor'), 'live-late');
        if (action.startsWith('applyFilters')) { ui.pending[1]({ entries: [] }); await settle(); }
    }
});

test('catch-up failures, unavailable sources and oversized records retain the checkpoint and surface a compact warning', async () => {
    for (const result of [{ skippedLongLines: 1 }, { failures: [{ component: 'source-a' }] }, { previousCursor: 'live-0' }]) {
        const ui = browser();
        ui.context.result = { entries: [entry()], liveCursor: 'live-0', resumeCursor: 'resume-0' };
        ui.run('applyLogResult(result, true)');
        const work = ui.run('catchUpLive()');
        ui.pending[0]({ entries: [entry({ id: 'not-acknowledged' })], liveCursor: 'live-1', ...result }); await work;
        assert.equal(ui.run('liveAnchor.liveCursor'), 'live-0');
        assert.equal(ui.run('currentLogs[0].id'), 'pcm-1');
        assert.equal(ui.run('followingLatest'), false);
        assert.match(ui.element('monitor-status').textContent, /Catch-up stopped.*Coverage/);
        assert.match(ui.element('log-status').textContent, /checkpoint|Catch-up stopped/);
        assert.equal(ui.run('liveTimer'), null);
    }
});

test('viewer budgets and coverage live in the sidebar while the monitoring bar retains scope and state', () => {
    const scope = rendered.match(/<section class="scope-strip[\s\S]*?<\/section>/)[0];
    assert.match(scope, /id="view-state"/); assert.match(scope, /id="filter-summary"/);
    assert.match(scope, /id="monitor-status"/);
    assert.doesNotMatch(scope, /id="(?:log-status|page-coverage)"/);
    const sidebar = rendered.slice(rendered.indexOf('<section id="workbench-panel-coverage"'));
    assert.match(sidebar, /Viewer diagnostics/); assert.match(sidebar, /id="log-status"/); assert.match(sidebar, /id="page-coverage"/);
});

test('an empty live check advances metadata without rebuilding the event DOM or moving its scroll', async () => {
    const ui = browser();
    ui.context.result = { entries: [entry()], liveCursor: 'live-0', resumeCursor: 'resume-0' };
    ui.run('applyLogResult(result, true)');
    const html = ui.element('log-table-body').innerHTML;
    ui.element('log-list').scrollTop = 24;
    const work = ui.run('catchUpLive()');
    ui.pending[0]({ entries: [], previousCursor: null, liveCursor: 'live-1', resumeCursor: 'resume-1' }); await work;
    assert.equal(ui.element('log-table-body').innerHTML, html);
    assert.equal(ui.element('log-list').scrollTop, 24);
    assert.equal(ui.run('liveAnchor.liveCursor'), 'live-1');
    assert.equal(ui.run('window.logPageTimings.renderMilliseconds'), 0);
});

test('Jump drains a finite target before reporting following and subsequent automatic polls remain enabled', async () => {
    const ui = browser();
    ui.context.result = { entries: [entry()], liveCursor: 'live-0', resumeCursor: 'resume-0' };
    ui.run('applyLogResult(result, true); holdReading(); followLatest()');
    assert.match(ui.element('view-state').textContent, /Loading updates/);
    ui.pending[0]({ entries: [entry()], liveCursor: 'live-0', resumeCursor: 'resume-0' }); await settle();
    const work = ui.run('catchUpLive()');
    assert.match(ui.element('view-state').textContent, /Loading updates/);
    ui.pending[1]({ entries: [entry({ id: 'new-event' })], liveCursor: 'live-1', resumeCursor: 'resume-1', previousCursor: null }); await work;
    assert.match(ui.element('view-state').textContent, /^Following latest$/);
    const poll = ui.run('refreshLogs()');
    assert.equal(ui.requests.length, 3);
    ui.pending[2]({ entries: [], liveCursor: 'live-2', resumeCursor: 'resume-2', previousCursor: null }); await poll;
    assert.equal(ui.run('liveAnchor.liveCursor'), 'live-2');
    assert.doesNotMatch(template, /isPaused|setPaused|pauseSwitch|manualCatchup/);
});

test('starting to read during a Jump cancels head restoration instead of replacing the reading window', async () => {
    const ui = browser();
    ui.context.result = { entries: [entry()], liveCursor: 'live-0', resumeCursor: 'resume-0' };
    ui.run('applyLogResult(result, true); followLatest(); holdReading()');
    assert.equal(ui.requests[0].options.signal.aborted, true);
    ui.pending[0]({ entries: [entry({ id: 'late-restored-head' })], liveCursor: 'live-late', resumeCursor: 'resume-late' }); await settle();
    assert.equal(ui.run('currentLogs[0].id'), 'pcm-1');
    assert.equal(ui.run('liveAnchor.liveCursor'), 'live-0');
    assert.equal(ui.run('followingLatest'), false);
});

for (const readingDuringRequest of [false, true]) test(`catch-up offscreen row focus is ${readingDuringRequest ? 'protected while reading' : 'kept on the list while following'}`, async () => {
    const ui = browser();
    ui.context.result = { entries: [entry()], liveCursor: 'live-0', resumeCursor: 'resume-0' };
    ui.context.one = { entries: [entry({ id: 'new-1' })], liveCursor: 'live-1', resumeCursor: 'resume-1', previousCursor: 'next-2' };
    ui.context.two = { entries: [entry({ id: 'new-2' })], liveCursor: 'live-2', resumeCursor: 'resume-2', previousCursor: 'next-3' };
    ui.run("applyLogResult(result, true); selectedId = 'pcm-1'; selectedRecord = currentLogs[0]; applyHistoryPage(one, 'p1', 'newer', true); applyHistoryPage(two, 'p2', 'newer', true)");
    const row = ui.element(ui.run("logRowId('pcm-1')"));
    row.closest = () => row; row.getBoundingClientRect = () => ({ top: -100, bottom: -50 }); row.focus();
    assert.equal(ui.run("canEvictPage('newer')"), false);
    const work = ui.run('catchUpLive()');
    if (readingDuringRequest) ui.run('holdReading()');
    ui.pending[0]({ entries: [entry({ id: 'new-3' })], liveCursor: 'live-3', resumeCursor: 'resume-3', previousCursor: null }); await work;
    if (readingDuringRequest) {
        assert.equal(ui.context.document.activeElement, row);
        assert.equal(ui.run('liveAnchor.liveCursor'), 'live-2');
        assert.ok(ui.run('prefetchedPage'));
    } else {
        assert.equal(ui.context.document.activeElement, ui.element('log-list'));
        assert.equal(ui.run('liveAnchor.liveCursor'), 'live-3');
        assert.equal(ui.run("currentLogs.some(row => row.id === 'pcm-1')"), false);
    }
    assert.equal(ui.run('selectedId'), 'pcm-1');
});

for (const tail of ['top', 'bottom']) test(`newer ${tail} pages reload after eviction, retain the opposite cursor and keep memory bounded`, () => {
    const ui = browser();
    ui.set('logTailPosition', tail);
    ui.context.result = { entries: [entry({ id: 'page-8' })], previousCursor: 'newer-7', nextCursor: 'older-9' };
    ui.run('applyLogResult(result); holdReading()');
    for (let index = 7; index >= 0; index--) {
        for (const row of ui.run('currentLogs')) ui.element(ui.run(`logRowId(${JSON.stringify(row.id)})`)).getBoundingClientRect = () => ({ top: -100, bottom: -50 });
        ui.context.page = { entries: [entry({ id: `page-${index}` })], previousCursor: index ? `newer-${index - 1}` : null, nextCursor: `older-${index + 1}` };
        assert.equal(ui.run(`applyHistoryPage(page, 'newer-${index}', 'newer')`), true);
        assert.ok(ui.run('logPages.length') <= 3);
        assert.ok(ui.run('currentLogs.length') <= 600);
        assert.equal(ui.run('previousCursor'), index ? `newer-${index - 1}` : null);
    }
    assert.equal(ui.run('nextCursor'), 'older-3');
    assert.equal(ui.run('currentLogs[0].id'), tail === 'top' ? 'page-0' : 'page-2');
    assert.equal(ui.run('currentLogs.length'), 3);
    assert.doesNotMatch(template, /id="(?:footer-hint|older-status)"/);
});

test('direction reversal aborts stale prefetch without invalidating current snapshot or a newer read', async () => {
    const ui = browser();
    ui.context.result = { entries: [entry()], previousCursor: 'newer-page', nextCursor: 'older-page' };
    ui.run('applyLogResult(result); holdReading()');
    const older = ui.run('maybeLoadHistory()');
    ui.run("setHistoryDirection('newer')");
    const newer = ui.run('maybeLoadHistory()');
    assert.equal(ui.requests[0].options.signal.aborted, true);
    assert.equal(new URL(ui.requests[1].url, ui.location).searchParams.get('cursor'), 'newer-page');
    ui.pending[0]({ entries: [entry({ id: 'stale-older' })], nextCursor: null }); await older;
    assert.ok(ui.run('historyRead'));
    ui.pending[1]({ entries: [entry({ id: 'correct-newer' })], previousCursor: null, nextCursor: 'older-current' }); await newer;
    assert.equal(ui.run("currentLogs.some(row => row.id === 'stale-older')"), false);
    assert.equal(ui.run('currentLogs[0].id'), 'correct-newer');
    assert.equal(ui.run('nextCursor'), 'older-page');
});

test('empty newer pages progress without caching them, then the actual newest edge resumes live with Event detail open', async () => {
    const ui = browser();
    ui.context.result = { entries: [entry()], previousCursor: 'newer-1', nextCursor: 'older-1' };
    ui.run("applyLogResult(result); holdReading(); eventDetailOpen = true; historyDirection = 'newer'");
    for (let index = 1; index <= 3; index++) {
        const work = ui.run('maybeLoadHistory()');
        ui.pending[index - 1]({ entries: [], previousCursor: index === 3 ? null : `newer-${index + 1}`, nextCursor: `back-${index}` }); await work;
        assert.equal(ui.run('logPages.length'), 1);
        assert.equal(ui.run('currentLogs.length'), 1);
        assert.equal(ui.run('nextCursor'), 'older-1');
    }
    ui.run('resumeLiveAtEdge()');
    assert.equal(ui.run('followingLatest'), true);
    assert.equal(ui.run('eventDetailOpen'), true);
    assert.equal(new URL(ui.requests[3].url, ui.location).searchParams.has('cursor'), false);
    ui.pending[3]({ entries: [entry()] }); await settle();
});

test('automatic following at the newest edge preserves sparse filtered matches during unchanged checks', async () => {
    const ui = browser();
    ui.context.result = { entries: [], nextCursor: 'sparse-1' };
    ui.context.match = { entries: [entry()], previousCursor: null, nextCursor: null };
    ui.run("applyLogResult(result); holdReading(); applyHistoryPage(match, 'sparse-1'); historyDirection = 'newer'; resumeLiveAtEdge()");
    assert.equal(ui.run('followingLatest'), true);
    assert.equal(ui.requests.length, 1);
    ui.pending[0]({ entries: [], nextCursor: 'new-sparse-1' }); await settle();
    assert.equal(ui.run('currentLogs.length'), 1);
    assert.equal(ui.run('followingLatest'), true);
    const poll = ui.run('refreshLogs()');
    ui.pending[1]({ entries: [entry({ id: 'fresh-match' })] }); await poll;
    assert.equal(ui.run('currentLogs[0].id'), 'fresh-match');
    assert.equal(ui.run('logPages.length'), 1);
});

test('fresh source-health failures are reported without relabeling held-page coverage', async () => {
    const ui = browser();
    ui.context.result = { entries: [entry()], failures: [], sources: [{ componentId: 'pcm-core', state: 'available' }], coverage: { state: 'bounded', rowLimit: 200, reasons: [] } };
    ui.run('applyLogResult(result); holdReading()');
    const heldCoverage = ui.element('page-coverage').textContent;
    const work = ui.run('refreshLogs()');
    ui.pending[0]({ ...ui.context.result, failures: [{ component: 'pcm-core' }], sources: [{ componentId: 'pcm-core', state: 'unavailable' }] });
    await work;
    assert.match(ui.element('log-status').textContent, /latest check unavailable sources: pcm-core/);
    assert.equal(ui.element('page-coverage').textContent, heldCoverage);
    assert.notEqual(ui.run('queuedResult'), null);
});

test('forced latest refresh preserves the selection while intentional filter navigation clears it', async () => {
    const ui = browser();
    const selected = entry();
    ui.set('currentLogs', [selected]);
    ui.context.row = new Element('row');
    const detail = ui.run("selectLog('pcm-1', row)");
    const latest = ui.run('refreshLogs(true)');
    ui.pending[0]({ entry: selected, raw: 'source\r\nbytes' });
    await detail;
    ui.pending[1]({ entries: [entry({ id: 'other' })] });
    await latest;
    assert.equal(ui.run('selectedId'), 'pcm-1');
    assert.equal(ui.element('details-pane').rawElement.textContent, 'source\r\nbytes');
    ui.run('applyFilters(null, true)');
    assert.equal(ui.run('selectedId'), null);
    ui.pending[2]({ entries: [] });
    await settle();
});

test('nested flow/trace inspection restores exact filters, page, held position, selection and raw CRLF', async () => {
    const ui = browser({ search: '?role=pcm&healthOrganizationId=ho-a&level=INFO&diagnostics=false&custom=preserved#anchor' });
    const selected = entry();
    ui.context.result = { entries: [selected], nextCursor: 'original-older' };
    ui.run("loadFilters(); applyLogResult(result); pageCursor = 'original-page'; followingLatest = false");
    ui.set('selectedId', selected.id); ui.set('selectedRecord', selected);
    ui.set('selectedResult', { raw: 'original\r\nraw\r\n' });
    ui.run('document.getElementById("details-pane").innerHTML = renderSelectedRecord(selectedRecord, selectedResult); selectDetailTab("raw")');
    ui.run("openEventDetail()");
    ui.element('details-pane').querySelector('.raw-source-text').scrollTop = 71;
    const originalUrl = ui.location.href;
    ui.run("inspectJourney(null, 'flowId', 'flow +/&?=')");
    assert.equal(ui.location.searchParams.get('flowId'), 'flow +/&?=');
    assert.equal(ui.location.searchParams.get('diagnostics'), 'false');
    assert.equal(ui.location.searchParams.has('role'), false);
    assert.equal(ui.location.searchParams.get('custom'), 'preserved');
    ui.pending.shift()({ id: 'flow-query', state: 'running' }); await settle();
    ui.pending.shift()({ state: 'complete', entries: [entry({ id: 'flow-row' })], progress: { matched: 1 }, nextOffset: null }); await settle();
    ui.run("inspectJourney(null, 'traceId', '0123456789abcdef0123456789abcdef')");
    ui.pending.shift()({ id: 'trace-query', state: 'running' }); await settle();
    ui.pending.shift()({ state: 'complete', entries: [entry({ id: 'trace-row' })], progress: { matched: 1 }, nextOffset: null }); await settle();
    ui.run('returnToResults()');
    assert.equal(ui.location.searchParams.get('flowId'), 'flow +/&?=');
    assert.equal(ui.run('currentLogs[0].id'), 'flow-row');
    ui.run('returnToResults()');
    assert.equal(ui.location.href, originalUrl);
    assert.equal(ui.run('pageCursor'), 'original-page');
    assert.equal(ui.run('Object.hasOwn(captureView(), "isPaused")'), false);
    assert.equal(ui.run('followingLatest'), false);
    assert.equal(ui.run('selectedId'), selected.id);
    assert.equal(ui.run('eventDetailOpen'), true);
    assert.equal(ui.element('details-pane').querySelector('.raw-source-text').textContent, 'original\r\nraw\r\n');
    assert.equal(ui.element('details-pane').querySelector('.raw-source-text').scrollTop, 71);
    assert.equal(ui.requests.filter(request => request.url === '/api/unified-logs/search').length, 2, 'return restores existing jobs without creating a new scan');
    assert.ok(ui.requests.every(request => request.url.startsWith('/api/unified-logs/search')), 'inspection never enters browser-paced browse reads');
});

test('snapshots keep raw records out of browser history/localStorage and remain bounded', () => {
    const ui = browser();
    ui.run('saveCurrentView()');
    for (let index = 0; index < 30; index++) ui.run('pushView(window.location.href); saveCurrentView()');
    assert.equal(ui.run('viewSnapshots.size'), 20);
    assert.deepEqual(ui.storage, {});
    assert.match(template, /replaceState\(\{ logsView: activeHistoryKey \}/);
    assert.match(template, /pushState\(\{ logsView: activeHistoryKey \}/);
});

test('concise component identity preserves organization or custom extension name exactly once', () => {
    const ui = browser();
    ui.context.log = entry({ component: 'Reference Health Organization A Gateway', event: { source: { role: 'gateway', componentId: 'ho-a-gateway', healthOrganizationId: 'ho-a' } } });
    assert.equal(ui.run('conciseRole(log)'), 'Gateway');
    assert.equal(ui.run('conciseOrganization(log)'), 'HO-A');
    ui.context.log = entry({ component: 'Custom Security Sensor', event: { source: { role: 'security' } } });
    assert.equal(ui.run('conciseRole(log)'), 'Security');
    assert.equal(ui.run('conciseOrganization(log)'), 'Custom Security Sensor');
});

test('history keys are unique per document and stale or mismatched history restores URL filters freshly', async () => {
    const first = browser({ search: '?role=pcm' });
    const second = browser({ search: '?flowId=flow-1' });
    const firstKey = first.run('saveCurrentView()');
    const secondKey = second.run('saveCurrentView()');
    assert.notEqual(firstKey, secondKey);
    second.location.href = 'http://localhost/logs-view?role=pcm';
    second.context.historyEvent = { state: { logsView: firstKey } };
    second.run('handleHistoryNavigation(historyEvent)');
    assert.equal(new URL(second.requests[0].url, second.location).searchParams.get('role'), 'pcm');
    assert.equal(new URL(second.requests[0].url, second.location).searchParams.has('flowId'), false);
    second.pending[0]({ entries: [entry({ id: 'correct-pcm' })] }); await settle();
    assert.equal(second.run('currentLogs[0].id'), 'correct-pcm');
    // Defense in depth: even a key present in this document cannot restore a
    // snapshot whose URL differs from the browser's active navigation target.
    second.context.historyEvent = { state: { logsView: secondKey } };
    second.run('handleHistoryNavigation(historyEvent)');
    second.pending[1]({ entries: [entry({ id: 'correct-again' })] }); await settle();
    assert.equal(second.run('currentLogs[0].id'), 'correct-again');
});

test('repeated Back through expired snapshots never expands the 20-view memory bound', async () => {
    const ui = browser();
    ui.run('saveCurrentView()');
    for (let index = 0; index < 45; index++) {
        ui.location.href = `http://localhost/logs-view?flowId=expired-${index}`;
        ui.context.historyEvent = { state: { logsView: `old-document-${index}` } };
        ui.run('handleHistoryNavigation(historyEvent)');
        ui.pending[index]({ entries: [entry({ id: `new-${index}` })] }); await settle();
        assert.ok(ui.run('viewSnapshots.size') <= 20);
    }
    assert.equal(ui.run('viewSnapshots.size'), 20);
});

test('restoring a pending page clears destination rows and explicitly reloads the restored URL while held', async () => {
    const ui = browser({ search: '?role=pcm' });
    ui.run("loadFilters(); saveCurrentView()");
    ui.context.saved = ui.run('captureView()');
    ui.context.result = { entries: [entry({ id: 'different-view' })], nextCursor: 'different-cursor' };
    ui.run('applyLogResult(result)');
    ui.run('restoreView(saved)');
    assert.equal(ui.run('currentLogs.length'), 0);
    assert.equal(ui.run('nextCursor'), null);
    assert.match(ui.element('log-table-body').innerHTML, /Loading bounded snapshot/);
    assert.doesNotMatch(ui.element('log-table-body').innerHTML, /different-view/);
    assert.equal(ui.run('Object.hasOwn(captureView(), "isPaused")'), false);
    assert.equal(new URL(ui.requests[0].url, ui.location).searchParams.get('role'), 'pcm');
    ui.pending[0]({ entries: [entry({ id: 'restored-pcm' })] }); await settle();
    assert.equal(ui.run('currentLogs[0].id'), 'restored-pcm');
    assert.equal(ui.run('Object.hasOwn(captureView(), "isPaused")'), false);
});


test('bottom Event and upper sidebar close independently with focused Escape dismissal', () => {
    const ui = browser();
    ui.run("refreshLogs = () => {}; window.onload(); openEventDetail(); openWorkbench('filters')");
    ui.element('filters-trigger').dataset.openPanel = 'filters';
    ui.element('filters-trigger').focus();
    ui.documentListeners.keydown({ key: 'Escape', preventDefault() {} });
    assert.equal(ui.run('activePanel'), null);
    assert.equal(ui.run('eventDetailOpen'), true);
    ui.run("openWorkbench('tools'); closeEventDetail(false)");
    assert.equal(ui.run('activePanel'), 'tools');
    assert.equal(ui.run('eventDetailOpen'), false);
    ui.run("openEventDetail(); closeWorkbench()");
    assert.equal(ui.element('event-detail').hidden, false);
    assert.equal(ui.element('resizer').hidden, false);
    assert.equal(ui.element('toggle-event-detail').getAttribute('aria-expanded'), 'true');
});

test('real format tabs retain independent scroll, roving focus and unchanged raw bytes', () => {
    const ui = browser();
    ui.context.selected = entry(); ui.context.result = { raw: '  <raw>\r\n\tline\r' };
    ui.run('document.getElementById("details-pane").innerHTML = renderSelectedRecord(selected, result); openEventDetail()');
    const structured = ui.element('panel-json').querySelector('pre');
    const raw = ui.element('panel-raw').querySelector('pre');
    raw.textContent = ui.context.result.raw;
    structured.scrollTop = 125; structured.scrollLeft = 15;
    ui.context.key = { key: 'ArrowLeft', preventDefault() {} };
    ui.run('handleDetailTabKey(key)');
    assert.equal(ui.run('activeDetailTab'), 'raw');
    assert.equal(ui.element('tab-raw').getAttribute('tabindex'), '0');
    assert.equal(ui.element('tab-json').getAttribute('tabindex'), '-1');
    assert.equal(ui.context.document.activeElement, ui.element('tab-raw'));
    assert.equal(ui.element('panel-json').hidden, true);
    raw.scrollTop = 240; raw.scrollLeft = 31;
    ui.run("selectDetailTab('json')");
    assert.deepEqual([structured.scrollTop, structured.scrollLeft], [125, 15]);
    ui.context.key.key = 'End'; ui.run('handleDetailTabKey(key); toggleDetailWrap()');
    assert.deepEqual([raw.scrollTop, raw.scrollLeft], [240, 31]);
    assert.equal(raw.textContent, '  <raw>\r\n\tline\r');
    assert.equal(ui.element('details-pane').classes.has('no-wrap'), true);
    assert.equal(ui.element('copy-detail').textContent, 'Copy raw text');
});

test('closed Event navigation preserves tab scroll and size without mutating saved snapshots', () => {
    const ui = browser();
    ui.set('selectedRecord', entry()); ui.set('selectedId', 'pcm-1');
    ui.set('selectedResult', { raw: 'line\r\n' });
    ui.context.result = { entries: [entry()] };
    ui.run('applyLogResult(result); document.getElementById("details-pane").innerHTML = renderSelectedRecord(selectedRecord, selectedResult); openEventDetail(); selectDetailTab("raw"); resizeEventPane(60)');
    ui.element('panel-raw').querySelector('pre').scrollTop = 180;
    ui.element('event-metadata-body').scrollTop = 75; ui.element('event-detail').scrollTop = 150;
    ui.run('closeEventDetail(false)');
    // A hidden browser pre has no scroll box, even though its saved offset exists.
    ui.element('panel-raw').querySelector('pre').scrollTop = 0;
    ui.element('event-metadata-body').scrollTop = 0; ui.element('event-detail').scrollTop = 0;
    ui.context.saved = ui.run('captureView()');
    assert.equal(ui.context.saved.detailTabScroll.raw.top, 180);
    assert.equal(ui.context.saved.metadataScroll, 75); assert.equal(ui.context.saved.eventScroll, 150);
    ui.run('resizeEventPane(70); restoreView(saved)');
    assert.equal(ui.run('eventDetailOpen'), false);
    assert.equal(ui.run('eventPanePercent'), 60);
    assert.equal(ui.run('detailTabScroll.raw.top'), 180);
    ui.run('openEventDetail()');
    const raw = ui.element('panel-raw').querySelector('pre');
    assert.equal(raw.scrollTop, 180);
    assert.equal(ui.element('event-metadata-body').scrollTop, 75); assert.equal(ui.element('event-detail').scrollTop, 150);
    assert.equal(raw.textContent, 'line\r\n');
    raw.scrollTop = 225; ui.run('rememberDetailScroll()');
    assert.equal(ui.context.saved.detailTabScroll.raw.top, 180, 'snapshot offsets are immutable copies');
});

test('layout preferences reject malformed storage and adapt minimum without losing requested size', () => {
    for (const value of [undefined, '', '0', '24', '71', 'Infinity', 'NaN', '{"raw":"secret"}']) {
        const ui = browser({ storage: { unifiedLogEventPanePercent: value } });
        ui.run('loadEventPaneSize()'); assert.equal(ui.run('eventPanePercent'), 48);
    }
    const ui = browser({ storage: { unifiedLogEventPanePercent: '35' } });
    ui.run('loadEventPaneSize()'); assert.equal(ui.run('eventPanePercent'), 35);
    ui.element('log-workspace').clientHeight = 400;
    ui.run('resizeEventPane(eventPanePercent, false)');
    assert.equal(ui.element('resizer').getAttribute('aria-valuemin'), '50');
    assert.equal(ui.element('resizer').getAttribute('aria-valuenow'), '50');
    assert.equal(ui.run('eventPanePercent'), 35);
    assert.equal(ui.storage.unifiedLogEventPanePercent, '35');
    ui.element('log-workspace').clientHeight = 1000;
    ui.run('resizeEventPane(eventPanePercent, false)');
    assert.equal(ui.element('resizer').getAttribute('aria-valuenow'), '35');
    ui.run('resizeEventPane(200)'); assert.equal(ui.run('eventPanePercent'), 70);
    ui.run('resizeEventPane(-1)'); assert.equal(ui.run('eventPanePercent'), 25);
    ui.run('resizeEventPane(NaN)'); assert.equal(ui.run('eventPanePercent'), 25);
    ui.context.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    assert.doesNotThrow(() => ui.run('loadEventPaneSize(); resizeEventPane(55)'));
    assert.equal(ui.run('eventPanePercent'), 55);
});

test('splitter pointer ownership, cancellation, loss and close clean up without persisting cancelled sizes', () => {
    const ui = browser(); ui.resizeScript(); ui.run('openEventDetail(); resizeEventPane(48)');
    const splitter = ui.element('resizer');
    ui.element('event-detail').getBoundingClientRect = () => ({ height: ui.run('eventPanePercent') * 10 });
    const pointer = (pointerId, clientY, extras = {}) => ({ pointerId, clientY, button: 0, pointerType: 'touch', preventDefault() {}, ...extras });
    splitter.listeners.pointerdown(pointer(1, 500, { isPrimary: false }));
    assert.equal(ui.run('dragPointerId'), null);
    splitter.listeners.pointerdown(pointer(1, 500));
    splitter.listeners.pointermove(pointer(2, 200));
    assert.equal(ui.run('eventPanePercent'), 48);
    splitter.listeners.pointermove(pointer(1, 400));
    assert.ok(Math.abs(ui.run('eventPanePercent') - 58) < 1e-9);
    splitter.listeners.pointercancel(pointer(1, 400));
    assert.equal(ui.run('eventPanePercent'), 48);
    assert.equal(ui.storage.unifiedLogEventPanePercent, '48');
    assert.equal(splitter.hasPointerCapture(1), false);
    assert.equal(ui.context.document.body.classes.has('resizing-event'), false);
    splitter.listeners.pointerdown(pointer(3, 500));
    splitter.listeners.pointermove(pointer(3, 450));
    splitter.listeners.pointerup(pointer(3, 450));
    assert.equal(ui.storage.unifiedLogEventPanePercent, '53');
    splitter.listeners.pointerdown(pointer(4, 500));
    splitter.listeners.pointermove(pointer(4, 400));
    ui.run('closeEventDetail(false)');
    assert.equal(ui.run('eventPanePercent'), 53);
    assert.equal(ui.run('dragPointerId'), null);
    ui.run('openEventDetail()');
    splitter.listeners.pointerdown(pointer(5, 500));
    splitter.listeners.pointermove(pointer(5, 400));
    splitter.listeners.lostpointercapture(pointer(5, 400));
    assert.equal(ui.run('eventPanePercent'), 53);
    assert.equal(splitter.classes.has('resizing'), false);
    splitter.listeners.pointerdown(pointer(6, 500));
    splitter.listeners.pointermove(pointer(6, 350));
    ui.run('saveCurrentView()');
    assert.equal(ui.run('dragPointerId'), null);
    assert.equal(ui.run('viewSnapshots.get(activeHistoryKey).eventPanePercent'), 53);
});

test('explicit copy preserves exact raw and failures or stale completions never change the selected record', async () => {
    const ui = browser();
    ui.context.selected = entry(); ui.context.result = { raw: 'copy\r\n\t<exact>' };
    ui.set('selectedRecord', ui.context.selected); ui.set('selectedResult', ui.context.result);
    ui.run('document.getElementById("details-pane").innerHTML = renderSelectedRecord(selected, result); openEventDetail(); selectDetailTab("raw")');
    const raw = ui.element('panel-raw').querySelector('pre'); raw.textContent = ui.context.result.raw;
    assert.equal(ui.context.copiedText, undefined, 'rendering never writes the clipboard');
    await ui.run('copyDetailText()'); assert.equal(ui.context.copiedText, 'copy\r\n\t<exact>');
    assert.match(ui.element('detail-status').textContent, /Raw source text copied/);
    ui.run('selectDetailTab("structured")');
    await ui.run('copyDetailText()');
    assert.equal(ui.context.copiedText, JSON.stringify({ ...ui.context.selected, details: ui.context.selected.details }, null, 2));
    ui.run('selectDetailTab("raw")');
    ui.context.navigator.clipboard.writeText = async () => { throw new Error('permission'); };
    await ui.run('copyDetailText()');
    assert.match(ui.element('detail-status').textContent, /Automatic copy was blocked/);
    assert.equal(raw.textContent, 'copy\r\n\t<exact>');
    let finish;
    ui.context.navigator.clipboard.writeText = () => new Promise(resolve => { finish = resolve; });
    const copying = ui.run('copyDetailText()');
    ui.run('detailRevision++'); ui.element('detail-status').textContent = 'New selection';
    finish(); await copying;
    assert.equal(ui.element('detail-status').textContent, 'New selection');
});


/** Mouse release can happen outside the element or while its window is inactive. */
function splitterFixture() {
    const ui = browser(); ui.resizeScript(); ui.run('openEventDetail(); resizeEventPane(48)');
    const splitter = ui.element('resizer');
    ui.element('event-detail').getBoundingClientRect = () => ({ height: ui.run('eventPanePercent') * 10 });
    const pointer = (pointerId, clientY, extras = {}) => ({ pointerId, clientY, button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, preventDefault() {}, ...extras });
    return { ui, splitter, pointer };
}

test('splitter window completion follows its owning pointer even when the element misses release', () => {
    const { ui, splitter, pointer } = splitterFixture();
    splitter.listeners.pointerdown(pointer(1, 500));
    splitter.listeners.pointermove(pointer(1, 400));
    ui.dispatchWindow('pointerup', pointer(2, 400, { buttons: 0 }));
    assert.equal(ui.run('dragPointerId'), 1, 'another pointer must not complete the owned drag');
    ui.dispatchWindow('pointerup', pointer(1, 400, { buttons: 0 }));
    assert.equal(ui.run('dragPointerId'), null);
    assert.equal(splitter.classes.has('resizing'), false);
    assert.equal(ui.context.document.body.classes.has('resizing-event'), false);
    assert.equal(splitter.hasPointerCapture(1), false);
    assert.ok(Math.abs(Number(ui.storage.unifiedLogEventPanePercent) - 58) < 1e-9);
    // The bubbling element callback is harmless after capture-phase completion.
    splitter.listeners.pointerup(pointer(1, 400, { buttons: 0 }));
    assert.ok(Math.abs(ui.run('eventPanePercent') - 58) < 1e-9);
});

test('splitter recovers a missed mouse release on re-entry without ending active touch or another pointer', () => {
    const { ui, splitter, pointer } = splitterFixture();
    splitter.listeners.pointerdown(pointer(1, 500));
    splitter.listeners.pointermove(pointer(1, -1500));
    assert.equal(ui.run('eventPanePercent'), 70);
    ui.dispatchWindow('pointermove', pointer(2, 300, { buttons: 0 }));
    assert.equal(ui.run('dragPointerId'), 1);
    ui.dispatchWindow('pointermove', pointer(1, 300, { buttons: 1 }));
    assert.equal(ui.run('dragPointerId'), 1);
    ui.dispatchWindow('pointermove', pointer(1, 300, { buttons: 0 }));
    assert.equal(ui.run('dragPointerId'), null);
    assert.equal(ui.run('eventPanePercent'), 70, 'released hover position must not resize the pane');
    assert.equal(ui.storage.unifiedLogEventPanePercent, '70');
    splitter.listeners.pointerdown(pointer(3, 500, { pointerType: 'touch' }));
    ui.dispatchWindow('pointermove', pointer(3, 350, { pointerType: 'touch', buttons: 0 }));
    assert.equal(ui.run('dragPointerId'), 3, 'touch cancellation uses its explicit lifecycle');
    ui.dispatchWindow('pointercancel', pointer(3, 350, { pointerType: 'touch', buttons: 0 }));
    assert.equal(ui.run('dragPointerId'), null);
    assert.equal(ui.run('eventPanePercent'), 70);
    splitter.listeners.pointerdown(pointer(4, 500, { pointerType: 'pen' }));
    splitter.listeners.pointermove(pointer(4, 540, { pointerType: 'pen' }));
    ui.dispatchWindow('pointermove', pointer(4, 540, { pointerType: 'pen', buttons: undefined }));
    assert.equal(ui.run('dragPointerId'), 4, 'missing button data is not proof of release');
    ui.dispatchWindow('pointermove', pointer(4, 540, { pointerType: 'pen', buttons: 2 }));
    assert.equal(ui.run('dragPointerId'), null, 'primary contact release ends the drag even if a barrel button remains held');
    assert.ok(Math.abs(ui.run('eventPanePercent') - 66) < 1e-9);
});

test('splitter window blur cancels rather than saving an interrupted drag, then keyboard and pointer still work', () => {
    const { ui, splitter, pointer } = splitterFixture();
    splitter.listeners.pointerdown(pointer(1, 500));
    splitter.listeners.pointermove(pointer(1, 380));
    assert.ok(Math.abs(ui.run('eventPanePercent') - 60) < 1e-9);
    ui.dispatchWindow('blur');
    assert.equal(ui.run('dragPointerId'), null);
    assert.equal(ui.run('eventPanePercent'), 48);
    assert.equal(ui.storage.unifiedLogEventPanePercent, '48');
    assert.equal(splitter.classes.has('resizing'), false);
    splitter.listeners.keydown({ key: 'ArrowUp', preventDefault() {} });
    assert.equal(ui.run('eventPanePercent'), 53);
    splitter.listeners.pointerdown(pointer(1, 500));
    splitter.listeners.pointermove(pointer(1, 450));
    ui.dispatchWindow('pointerup', pointer(1, 450, { buttons: 0 }));
    assert.ok(Math.abs(ui.run('eventPanePercent') - 58) < 1e-9);
    assert.equal(ui.run('dragPointerId'), null);
});


test('splitter accepts a new press after a missed release without allowing a second pointer to take ownership', () => {
    const { ui, splitter, pointer } = splitterFixture();
    splitter.listeners.pointerdown(pointer(1, 500));
    splitter.listeners.pointermove(pointer(1, 400));
    splitter.listeners.pointerdown(pointer(2, 300));
    assert.equal(ui.run('dragPointerId'), 1);
    splitter.listeners.pointerdown(pointer(1, 300, { button: 2, buttons: 3 }));
    assert.equal(ui.run('dragStartY'), 500, 'secondary button does not restart a drag');
    splitter.listeners.pointerdown(pointer(1, 300, { pointerType: 'touch' }));
    assert.equal(ui.run('dragStartY'), 500, 'a different pointer type cannot take ownership');
    splitter.listeners.pointerdown(pointer(1, 300));
    assert.equal(ui.run('dragStartY'), 300, 'a genuine new primary press starts fresh geometry');
    assert.equal(splitter.hasPointerCapture(1), true);
    splitter.listeners.pointermove(pointer(1, 350));
    ui.dispatchWindow('pointerup', pointer(1, 350, { buttons: 0 }));
    assert.ok(Math.abs(ui.run('eventPanePercent') - 53) < 1e-9);
    assert.equal(ui.run('dragPointerId'), null);
});

test('retained search fences late result responses and cancels separate server work when leaving', async () => {
    const ui = browser();
    ui.element('filter-traceId').value = 'exact-trace'; ui.element('search-text').value = ' literal [.*] ';
    const start = ui.run('startSearch()');
    assert.equal(ui.requests[0].url, '/api/unified-logs/search');
    assert.equal(JSON.parse(ui.requests[0].options.body).text, ' literal [.*] ');
    ui.pending.shift()({ id: 'owned-query', state: 'running' }); await settle();
    assert.match(ui.requests[1].url, /search\/owned-query\?/);
    const signal = ui.requests[1].options.signal;
    ui.run('leaveSearch(false)'); assert.equal(signal.aborted, true);
    assert.equal(ui.requests.at(-1).options.method, 'DELETE');
    ui.pending.shift()({ id: 'owned-query', state: 'complete', entries: [entry()], progress: { matched: 1 } });
    await start; await settle();
    assert.equal(ui.run('currentLogs.length'), 0);
    assert.equal(ui.run('searchSession'), null);
    assert.equal(ui.element('search-banner').hidden, true);
});

test('retained search progress-only polls keep rows/selection/scroll stable and never start browse continuation', async () => {
    let bytes = 10;
    const row = entry();
    const ui = browser({ search: '?role=pcm', fetch: async () => ({ ok: true, json: async () => ({ id: 'progress', state: 'running', entries: [row],
        progress: { matched: 1, bytesRead: bytes, scannedFiles: 0, totalFiles: 2 }, nextOffset: null,
        coverage: { scope: 'search-snapshot', reasons: [] }, sources: [] }) }) });
    ui.set('searchSession', { id: 'progress', offset: 0, state: 'running', filters: { role: 'adapter', source: 'ho-b-adapter', text: 'Rare' }, started: performance.now() });
    ui.run('window.searchRenderCalls = 0; const searchOriginalApply = applyLogResult; applyLogResult = (...args) => { window.searchRenderCalls++; return searchOriginalApply(...args); };');
    await ui.run('readSearchPage()'); ui.element('log-list').scrollTop = 100;
    ui.set('selectedId', row.id); bytes = 1048576;
    await ui.run('readSearchPage()');
    assert.equal(ui.run('window.searchRenderCalls'), 1);
    assert.equal(ui.element('log-list').scrollTop, 100); assert.equal(ui.run('selectedId'), row.id);
    assert.match(ui.element('search-progress').textContent, /Searching retained history.*1 matches.*1 MiB/);
    assert.equal(ui.run('nextCursor'), null);
    assert.match(ui.element('filter-full').textContent, /Source: ho-b-adapter.*Role: adapter.*Text: Rare/);
    assert.doesNotMatch(ui.element('filter-summary').textContent, /role=pcm/);
    await ui.run('maybeLoadHistory()'); await ui.run('refreshLogs()');
    assert.equal(ui.requests.length, 2);
});

test('retained search cancellation acknowledges partial state and unavailable queries expose retry', async () => {
    const ui = browser({ fetch: async (url, options) => options.method === 'DELETE'
        ? { ok: true, json: async () => ({ state: 'cancelled' }) }
        : { ok: true, json: async () => ({ id: 'cancel', state: 'cancelled', entries: [], nextOffset: null, progress: { matched: 0 }, sources: [] }) } });
    ui.set('searchSession', { id: 'cancel', offset: 0, state: 'running', started: performance.now() });
    await ui.run('cancelSearch()');
    assert.equal(ui.run('searchSession.state'), 'cancelled');
    assert.match(ui.element('search-progress').textContent, /Search cancelled/);
    assert.equal(ui.element('search-cancel').disabled, true);
    ui.run('searchFailure(new Error("expired"))');
    assert.equal(ui.run('searchSession.state'), 'failed');
    assert.match(ui.element('search-progress').textContent, /expired.*Retry retained search or return/);
});

test('saved retained query restores its own job/filter scope and never falls through to browse/live polling', async () => {
    const ui = browser({ fetch: async () => ({ ok: true, json: async () => ({ id: 'saved', state: 'complete', entries: [entry()],
        nextOffset: null, progress: { matched: 1 }, sources: [] }) }) });
    ui.set('searchSession', { id: 'saved', offset: 0, state: 'complete', filters: { traceId: 'exact', text: 'literal' }, started: performance.now() });
    ui.set('currentResult', { entries: [entry()] });
    const snapshot = ui.run('captureView()'); ui.run('leaveSearch(false)');
    ui.context.savedSearch = snapshot; ui.run('restoreView(savedSearch)'); await settle();
    assert.equal(ui.run('searchSession.id'), 'saved');
    assert.equal(ui.element('filter-traceId').value, 'exact'); assert.equal(ui.element('search-text').value, 'literal');
    assert.equal(ui.element('search-banner').hidden, false);
    await ui.run('refreshLogs()');
    assert.equal(ui.requests.length, 1); assert.match(ui.requests[0].url, /search\/saved\?/);
});

test('cancel during query creation waits for admission then stops the known job without orphaning it', async () => {
    const ui = browser(); const start = ui.run('startSearch()');
    const creationSignal = ui.requests[0].options.signal;
    await ui.run('cancelSearch()');
    assert.equal(creationSignal.aborted, false);
    assert.match(ui.element('search-progress').textContent, /Cancellation requested.*admission/);
    ui.pending.shift()({ id: 'late-admission', state: 'running' }); await settle();
    assert.equal(ui.requests.at(-1).options.method, 'DELETE');
    ui.pending.shift()({ state: 'cancelled' }); await settle();
    ui.pending.shift()({ id: 'late-admission', state: 'cancelled', entries: [], nextOffset: null, progress: { matched: 0 }, sources: [] });
    await start; assert.equal(ui.run('searchSession.state'), 'cancelled');
});

for (const field of ['correlationId', 'traceId', 'flowId']) {
    test(`exact ${field} inspection creates only the accepted worker query and preserves its selected preview`, async () => {
        const ui = browser({ search: '?role=pcm&healthOrganizationId=ho-a&level=ERROR&diagnostics=false' });
        const selected = entry({ event: { source: { componentId: 'pcm-core', role: 'pcm' }, correlation: { [field]: 'exact-value' } } });
        ui.set('selectedRecord', selected); ui.set('selectedId', selected.id); ui.set('selectedResult', { raw: 'full\r\n' });
        ui.element('search-text').value = 'unapplied text'; ui.element('search-source').value = 'other';
        const work = ui.run(`inspectJourney(null, '${field}', 'exact-value')`);
        assert.deepEqual(JSON.parse(ui.requests[0].options.body), { [field]: 'exact-value', diagnostics: 'false' });
        assert.equal(ui.run('currentLogs[0].id'), selected.id);
        assert.equal(ui.run('selectedResult.raw'), 'full\r\n');
        assert.match(ui.element('inspection-preview').textContent, /not counted/);
        assert.equal(ui.element('search-source').value, '');
        ui.pending.shift()({ id: 'query' }); await settle();
        for (let index = 0; index < 3; index++) {
            ui.pending.shift()({ state: 'running', entries: [], nextOffset: null, progress: { bytesRead: index * 1000000, totalFiles: 53 } });
            await settle();
            assert.equal(ui.run('currentLogs[0].id'), selected.id, 'empty progress keeps the matching selected event');
            assert.match(ui.element('search-progress').textContent, /Searching retained history/);
            assert.match(ui.element('investigation-observed').textContent, /roles none yet/);
            if (index < 2) ui.run('readSearchPage(0)');
        }
        const final = ui.run('readSearchPage(0)');
        ui.pending.shift()({ state: 'complete', entries: [selected], nextOffset: null, progress: { matched: 1 } });
        await final; await work;
        assert.equal(ui.run('currentLogs.length'), 1, 'stable source event ID deduplicates the preview');
        assert.equal(ui.element('inspection-preview').textContent, '');
        assert.match(ui.element('investigation-observed').textContent, /roles pcm · sources pcm-core/);
        assert.ok(ui.requests.every(request => request.url.startsWith('/api/unified-logs/search')));
    });
}

test('trace and explicit related correlation remain distinct and observed roles are actual result evidence', async () => {
    let body;
    const ui = browser({ fetch: async (url, options = {}) => {
        if (options.method === 'POST') { body = JSON.parse(options.body); return { ok: true, json: async () => ({ id: 'query' }) }; }
        const roles = body.traceId ? ['adapter'] : ['adapter', 'gateway'];
        return { ok: true, json: async () => ({ state: 'complete', entries: roles.map(role => entry({ id: role, event: { source: { role, componentId: role }, correlation: body } })), nextOffset: null, progress: { matched: roles.length } }) };
    } });
    await ui.run("inspectJourney(null, 'traceId', 'trace-one')");
    assert.deepEqual(body, { traceId: 'trace-one', diagnostics: 'false' });
    assert.match(ui.element('investigation-description').textContent, /correlation-only events are excluded/);
    assert.match(ui.element('investigation-observed').textContent, /roles adapter ·/);
    await ui.run("inspectJourney(null, 'correlationId', 'same-request')");
    assert.deepEqual(body, { correlationId: 'same-request', diagnostics: 'false' });
    assert.match(ui.element('investigation-observed').textContent, /roles adapter, gateway/);
    assert.match(ui.element('investigation-description').textContent, /trace IDs differ/);
    assert.equal(ui.run('searchReturnView'), null, 'nested inspections use capped memory keys rather than unbounded return snapshot chains');
});

test('terminal empty, cancelled and source failure outcomes discard unverified selected previews', async () => {
    for (const state of ['complete', 'cancelled', 'partial', 'failed']) {
        const ui = browser({ fetch: async (_url, options = {}) => ({ ok: true, json: async () => options.method === 'POST' ? { id: 'query' }
            : { state, entries: [], nextOffset: null, progress: { matched: 0 }, failures: state === 'partial' ? [{ component: 'pcm-core' }] : [] } }) });
        ui.set('selectedRecord', entry());
        await ui.run("inspectJourney(null, 'flowId', 'flow-1')");
        assert.equal(ui.run('currentLogs.length'), 0);
        assert.equal(ui.element('inspection-preview').textContent, '');
        if (state === 'complete') assert.match(ui.element('log-table-body').innerHTML, /No matches within/);
        else assert.match(ui.element('search-progress').textContent, /cancelled|partial|failed/);
        if (state === 'partial') assert.match(ui.element('search-progress').textContent, /unavailable sources: pcm-core/);
    }
});

test('inspection retry uses the admitted scope despite unapplied edits and keeps Diagnostics', async () => {
    const bodies = [];
    const ui = browser({ search: '?diagnostics=true', fetch: async (_url, options = {}) => {
        if (options.method === 'POST') bodies.push(JSON.parse(options.body));
        return { ok: true, json: async () => options.method === 'POST' ? { id: 'query' } : { state: 'complete', entries: [], nextOffset: null } };
    } });
    ui.run("loadMarkedLogs()");
    await ui.run("inspectJourney(null, 'flowId', 'workflow')");
    ui.element('filter-flowId').value = 'unapplied'; ui.element('search-text').value = 'unapplied';
    await ui.run('retrySearch()');
    assert.deepEqual(bodies, [{ flowId: 'workflow', diagnostics: 'true' }, { flowId: 'workflow', diagnostics: 'true' }]);
    assert.match(ui.element('investigation-description').textContent, /Diagnostics shown unchanged/);
});

test('new-tab inspection links start worker jobs and invalid fields cannot start an investigation', async () => {
    const ui = browser({ search: '?inspection=correlationId&correlationId=corr&role=pcm&diagnostics=false' });
    assert.equal(ui.run('startUrlInspection()'), true);
    assert.deepEqual(JSON.parse(ui.requests[0].options.body), { correlationId: 'corr', diagnostics: 'false' });
    ui.run("inspectJourney(null, 'unsupported', 'value')");
    assert.equal(ui.requests.length, 1);
    ui.run('leaveSearch(false)');
    ui.pending.shift()({ id: 'abandoned' }); await settle();
    assert.equal(ui.requests.at(-1).options.method, 'DELETE', 'late admission is fenced and cancelled');
});

test('a failed admission removes its unverified preview while keeping held raw detail and retry', async () => {
    const ui = browser({ fetch: async () => ({ ok: false, json: async () => ({ error: 'Owned source unavailable' }) }) });
    ui.set('selectedRecord', entry()); ui.set('selectedId', 'pcm-1'); ui.set('selectedResult', { raw: 'held\r\n' });
    await ui.run("inspectJourney(null, 'flowId', 'flow-1')");
    assert.equal(ui.run('searchSession.state'), 'failed');
    assert.equal(ui.run('currentLogs.length'), 0);
    assert.equal(ui.run('selectedResult.raw'), 'held\r\n');
    assert.equal(ui.element('inspection-preview').textContent, '');
    assert.match(ui.element('search-progress').textContent, /Retry retained search/);
});

test('explicit Diagnostics changes reuse inspection scope and never pin an excluded diagnostic record', async () => {
    const ui = browser({ fetch: async (_url, options = {}) => ({ ok: true, json: async () => options.method === 'POST' ? { id: 'query' }
        : { state: 'running', entries: [], nextOffset: null } }) });
    const row = entry({ details: { visibility: 'diagnostic', flowId: 'flow-1' } });
    ui.set('showDiagnosticLogs', true); ui.set('selectedRecord', row);
    await ui.run("inspectJourney(null, 'flowId', 'flow-1')");
    assert.equal(ui.run('currentLogs.length'), 1);
    ui.run('setDiagnosticVisibility(false)'); await settle();
    assert.equal(ui.run('investigation.field'), 'flowId');
    assert.equal(ui.run('currentLogs.length'), 0);
    assert.deepEqual(JSON.parse(ui.requests.filter(request => request.options.method === 'POST').at(-1).options.body), { flowId: 'flow-1', diagnostics: 'false' });
});

test('inspection preserves action focus when the upper workbench is already closed', async () => {
    const ui = browser({ fetch: async (_url, options = {}) => ({ ok: true, json: async () => options.method === 'POST' ? { id: 'query' }
        : { state: 'complete', entries: [entry()], nextOffset: null } }) });
    ui.set('selectedRecord', entry()); ui.set('selectedId', 'pcm-1');
    const action = ui.element('inspection-control'); action.focus();
    await ui.run("inspectJourney(null, 'flowId', 'flow-1')");
    assert.equal(ui.context.document.activeElement, action, 'opening a query must not move focus/help to the selected row');
});

test('saved markup excludes transient help decoration without changing escaped payload or identifier text', () => {
    const ui = browser();
    const body = '<a class="btn explain-target" aria-describedby="pcm-help-tooltip" data-inspect-value="explain-target">explain-target</a><pre>&quot;class=\\&quot;explain-target\\&quot;&quot;\r\n</pre>';
    ui.element('event-metadata-body').innerHTML = body;
    const saved = ui.run("snapshotHtml('event-metadata-body')");
    assert.equal(saved, body.replace('btn explain-target', 'btn').replace(' aria-describedby="pcm-help-tooltip"', ''));
    assert.match(saved, /data-inspect-value="explain-target"/);
    assert.ok(saved.endsWith('<pre>&quot;class=\\&quot;explain-target\\&quot;&quot;\r\n</pre>'));
});


test('Coverage exposes source health in evidence scope and separate later health without overwriting omissions', () => {
    const ui = browser({ search: '?source=ho-a-hapi&role=hapi-import&level=INFO' }); ui.run('loadFilters()');
    ui.context.result = { entries: [], skippedLongLines: 2, failures: [{ component: 'ho-a-hapi' }],
        coverage: { reasons: ['read-budget', 'oversized-records', 'unreadable-streams', 'filtered-view', 'older-page'] },
        sources: [{ componentId: 'ho-a-hapi', role: 'hapi-import', healthOrganizationId: 'ho-a', state: 'error', coverage: 'import-only' },
            { componentId: 'pcm-core', role: 'pcm', state: 'available' }, { componentId: 'unknown-stream', state: 'unknown' }] };
    ui.run('renderPageCoverage(result)');
    assert.match(ui.element('source-summary').textContent, /3.*1 available.*1 unavailable.*1 unknown/);
    assert.match(ui.element('source-list').innerHTML, /general HAPI requests and complete spans are not recorded/);
    assert.match(ui.element('page-coverage').textContent, /continues in bounded pages.*does not mean logging was lost/);
    assert.match(ui.element('page-coverage').textContent, /captured snapshot.*2 oversized records omitted/);
    assert.match(ui.element('page-coverage').textContent, /No matching evidence.*Diagnostics hidden/);
    assert.match(ui.element('page-coverage').textContent, /limited to current files and up to five retained rotations/);
    assert.doesNotMatch(ui.element('page-coverage').textContent, /rotations per source are available/);
    assert.match(ui.element('coverage-active-filters').innerHTML, /Remove source=ho-a-hapi/);
    const before = ui.element('page-coverage').textContent;
    ui.set('latestSourceCheck', { at: 'later', sources: [{ componentId: 'ho-a-hapi', state: 'available' }] }); ui.run('renderSourceCheck()');
    assert.match(ui.element('source-latest-check').textContent, /later.*available.*does not change the loaded snapshot/);
    assert.equal(ui.element('page-coverage').textContent, before);
    assert.match(ui.element('viewer-budgets').textContent, /600 summaries/);
    assert.match(template.slice(template.indexOf('<section id="workbench-panel-tools"')), /id="viewer-diagnostics"/);
    assert.doesNotMatch(template.slice(template.indexOf('<section id="workbench-panel-coverage"'), template.indexOf('<section id="workbench-panel-columns"')), /id="log-status"/);
});

for (const following of [false, true]) test(`Coverage exact source filter preserves combined scope, diagnostics and follow=${following}`, async () => {
    const ui = browser({ search: '?role=adapter&healthOrganizationId=ho-a&method=GET&level=ERROR&diagnostics=false' });
    ui.run('loadFilters()'); ui.set('followingLatest', following);
    ui.set('selectedRecord', entry()); ui.set('selectedId', 'pcm-1'); ui.set('selectedResult', { raw: 'held raw' });
    ui.element('filter-level').value = 'WARN'; // Unapplied edits must not replace the active ERROR scope.
    ui.run("coverageFilter('source', 'ho-a-adapter')");
    const request = new URL(ui.requests.at(-1).url, 'http://localhost');
    for (const [key, value] of Object.entries({ source: 'ho-a-adapter', role: 'adapter', healthOrganizationId: 'ho-a', method: 'GET', level: 'ERROR', diagnostics: 'false' })) {
        assert.equal(request.searchParams.get(key), value); assert.equal(ui.context.window.location.search.includes(encodeURIComponent(value)), true);
    }
    assert.equal(ui.element('search-source').value, 'ho-a-adapter');
    assert.equal(ui.run('followingLatest'), following); assert.equal(ui.run('Object.hasOwn(captureView(), "isPaused")'), false);
    assert.equal(ui.run('selectedResult.raw'), 'held raw');
    ui.pending.shift()({ entries: [] }); await settle();
    ui.run("coverageFilter('source', '')");
    assert.equal(new URL(ui.requests.at(-1).url, 'http://localhost').searchParams.has('source'), false);
    assert.equal(ui.context.window.location.search.includes('role=adapter'), true);
    assert.equal(ui.run('showDiagnosticLogs'), false);
    ui.pending.shift()({ entries: [] }); await settle();
});

test('Coverage search action keeps literal/time/ID scope and diagnostics without claiming across-role inspection', async () => {
    const ui = browser({ search: '?traceId=exact&inspection=traceId&diagnostics=false' });
    ui.set('searchSession', { id: 'old', state: 'complete', filters: { traceId: 'exact', text: 'literal', since: '2026-11-04T00:00Z', diagnostics: 'false' } });
    ui.set('investigation', { field: 'traceId', value: 'exact' });
    const work = ui.run("coverageFilter('role', 'adapter')");
    assert.deepEqual(JSON.parse(ui.requests[0].options.body), { traceId: 'exact', text: 'literal', since: '2026-11-04T00:00Z', diagnostics: 'false', role: 'adapter' });
    assert.equal(ui.run('investigation'), null); assert.equal(ui.context.window.location.search.includes('inspection='), false);
    assert.match(ui.context.window.location.search, /text=literal/);
    ui.pending.shift()({ id: 'new', state: 'running' }); await settle();
    ui.pending.shift()({ state: 'complete', entries: [], sources: [] }); await work;
});


test('Coverage excludes the uncounted selected preview from observed ID groups and exposes actionable continuity failures', () => {
    const ui = browser(); const preview = entry(); ui.set('currentLogs', [preview]);
    ui.set('searchSession', { previewVisible: true, seed: preview });
    ui.context.result = { entries: [preview] }; ui.run('renderPageCoverage(result)');
    assert.match(ui.element('page-coverage').textContent, /0 events plus one selected-event preview, not counted/);
    assert.match(ui.element('journey-summary').textContent, /0 · 0 rows/);
    ui.run('failLiveRead(new Error("source bytes changed"))');
    assert.match(ui.element('coverage-warning').textContent, /source bytes changed.*checkpoint retained.*retry/);
    assert.match(ui.element('viewer-state').textContent, /follow: false/);
});

test('a reset loading placeholder cannot turn held reading into following through a synthetic scroll', () => {
    const ui = browser(); ui.set('followingLatest', false); ui.set('currentResult', null); ui.set('historyDirection', 'newer');
    ui.run('handleLogScroll()'); assert.equal(ui.run('followingLatest'), false);
});

for (const tail of ['top', 'bottom']) test(`status distinguishes requested following, unfinished catch-up, held pending updates and retry in ${tail}`, async () => {
    const ui = browser({ search: '?role=doctor' });
    ui.set('logTailPosition', tail);
    ui.run('updateViewState()');
    assert.equal(ui.element('view-state').textContent, 'Loading updates');
    assert.equal(ui.element('reader-indicator').dataset.state, 'loading');
    ui.context.initial = { entries: [entry()], liveCursor: 'live-0', resumeCursor: 'resume-0' };
    ui.run('applyLogResult(initial, true)');
    assert.equal(ui.element('view-state').textContent, 'Following latest');
    assert.equal(ui.element('state-cue').textContent, '▶');
    const read = ui.run('catchUpLive()');
    assert.equal(ui.element('view-state').textContent, 'Following latest');
    ui.pending[0]({ entries: [entry({ id: 'interval-1' })], previousCursor: 'target-1', liveCursor: 'live-1', resumeCursor: 'resume-1' }); await read;
    assert.equal(ui.element('view-state').textContent, 'Loading updates');
    ui.run('holdReading(); queuedResult = { entries: [{ id: "pending" }] }; updateViewState()');
    assert.equal(ui.element('view-state').textContent, 'Position held');
    assert.equal(ui.element('state-cue').textContent, 'Ⅱ');
    assert.match(ui.element('follow-latest').textContent, /1 new on page/);
    assert.equal(ui.element('follow-latest').getAttribute('aria-pressed'), null);
    ui.run('failLiveRead(new Error("fixture unavailable"))');
    assert.equal(ui.element('reader-indicator').dataset.state, 'failed');
    assert.match(ui.element('view-state').textContent, /unavailable.*Retry with Jump/);
    assert.equal(ui.element('state-cue').textContent, '!');
    ui.run('followLatest()');
    assert.equal(ui.element('view-state').textContent, 'Loading updates');
    ui.pending[1]({ entries: [entry({ id: 'interval-1' })], liveCursor: 'live-1', resumeCursor: 'resume-1' }); await settle();
    const retry = ui.run('catchUpLive()');
    ui.pending[2]({ entries: [], previousCursor: null, liveCursor: 'live-2', resumeCursor: 'resume-2' }); await retry;
    assert.equal(ui.element('view-state').textContent, 'Following latest');
});

test('status exposes concise friendly scope and every exact value independently of Explain', () => {
    const id = 'exact/&?=with+' + 'a'.repeat(180);
    const ui = browser({ search: '?' + new URLSearchParams({ role: 'doctor', correlationId: id, method: 'GET', status: '200' }) });
    ui.run('updateViewState()');
    assert.match(ui.element('filter-summary').textContent, /^Role: doctor · Method: GET · \+2 filters$/);
    assert.ok(ui.element('filter-summary').getAttribute('aria-label').includes(id));
    assert.ok(ui.element('filter-full').textContent.includes('Correlation ID: ' + id));
    assert.equal(ui.element('diagnostic-visibility').textContent, 'Diagnostics hidden');
    ui.run('showDiagnosticLogs = true; updateViewState()');
    assert.equal(ui.element('diagnostic-visibility').textContent, 'Diagnostics shown');
    assert.match(rendered, /<span id="filter-summary" tabindex="0" data-help-key="logs.active-scope"/);
    for (const key of ['logs.reader-state', 'logs.active-scope', 'logs.diagnostics']) assert.ok(rendered.includes(`data-help-key="${key}"`));
    assert.match(rendered, /data-log-order-mode="flow"[^>]*>Group related events/);
});

test('search and exact ID snapshots report truthful loading, partial and failure states', () => {
    const ui = browser();
    for (const [state, text] of [['starting', 'Loading search results'], ['running', 'Loading search results'], ['complete', 'Search snapshot'], ['partial', 'Search partial · Review search status'], ['failed', 'Search unavailable · Retry search']]) {
        ui.set('searchSession', { state, filters: { traceId: 'exact-trace' } });
        ui.run('followingLatest = true; catchingUp = false; updateViewState()');
        assert.equal(ui.element('view-state').textContent, text);
        assert.doesNotMatch(ui.element('view-state').textContent, /Following latest/);
        assert.equal(ui.element('filter-full').textContent, 'Trace ID: exact-trace');
    }
});

test('restoring a legacy in-tab snapshot cannot restore an invisible pause or destination failure', async () => {
    const ui = browser();
    ui.context.result = { entries: [entry()] };
    ui.run('applyLogResult(result); holdReading()');
    ui.context.saved = ui.run('captureView()');
    ui.context.saved.isPaused = true;
    ui.run('latestSourceCheck = { error: "destination failed" }; restoreView(saved)');
    assert.equal(ui.element('view-state').textContent, 'Position held');
    assert.equal(ui.run('Object.hasOwn(captureView(), "isPaused")'), false);
    const read = ui.run('refreshLogs()');
    ui.pending[0]({ entries: [entry({ id: 'new' })] }); await read;
    assert.equal(ui.run('queuedResult.entries[0].id'), 'new');
    assert.equal(ui.run('currentLogs[0].id'), 'pcm-1');
});

test('a first-read failure never claims following and a successful retry clears the failure indication', async () => {
    const ui = browser({ fetch: async () => { throw new Error('offline'); } });
    await ui.run('refreshLogs()');
    assert.match(ui.element('view-state').textContent, /unavailable.*Retry/);
    ui.context.fetch = async () => ({ ok: true, json: async () => ({ entries: [] }) });
    await ui.run('followLatest()'); await settle();
    assert.equal(ui.element('view-state').textContent, 'Following latest');
});


test('a search request failure immediately replaces loading state even without a selected preview', () => {
    const ui = browser();
    ui.set('searchSession', { state: 'running', filters: { correlationId: 'exact-request' } });
    ui.run('updateViewState(); searchFailure(new Error("query expired"))');
    assert.equal(ui.run('searchSession.state'), 'failed');
    assert.equal(ui.element('view-state').textContent, 'Search unavailable · Retry search');
    assert.equal(ui.element('state-cue').textContent, '!');
    assert.match(ui.element('search-progress').textContent, /query expired/);
});


test('Tools opens with a named close action and returns focus without querying or losing selection', () => {
    const ui = browser();
    const trigger = ui.element('tools-trigger');
    ui.run('selectedId = "held-event"; eventDetailOpen = true;');
    ui.context.trigger = trigger;
    ui.run('openWorkbench("tools", trigger)');
    assert.equal(ui.element('close-workbench').textContent, 'Close tools');
    assert.equal(ui.element('close-workbench').getAttribute('aria-label'), 'Close tools');
    assert.equal(ui.context.document.activeElement, ui.element('close-workbench'));
    ui.run('closeWorkbench()');
    assert.equal(ui.context.document.activeElement, trigger);
    assert.equal(ui.run('selectedId'), 'held-event');
    assert.equal(ui.run('eventDetailOpen'), true);
    assert.equal(ui.requests.length, 0);
});
