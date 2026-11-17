'use strict';
/** Markup contract regressions: CSS-only reflow must retain the actual form actions. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const template = fs.readFileSync(path.join(__dirname, '../src/views/logs.ejs'), 'utf8');
const html = ejs.render(template, { teamId: 'filters-<test>' });
const form = html.match(/<form class="log-filters"[^>]*>([\s\S]*?)<\/form>/)[0];

test('all fifteen labelled controls stay in one semantic form and out of the action groups', () => {
    assert.match(form, /onsubmit="applyFilters\(event\)" aria-label="Exact event filters"/);
    const grid = form.split('<div class="filter-fields">')[1].split('<div class="filter-actions"')[0];
    assert.doesNotMatch(grid, /<button\b/);
    const ids = ['filter-role', 'filter-healthOrganizationId', 'filter-level', 'filter-method', 'filter-operationId', 'filter-sourceId', 'filter-correlationId', 'filter-flowId', 'filter-traceId', 'filter-path', 'filter-status', 'search-text', 'search-source', 'search-since', 'search-until'];
    assert.deepEqual([...grid.matchAll(/<(?:input|select)\b[^>]*id="([^"]+)"/g)].map(match => match[1]), ids);
    for (const id of ids) {
        assert.equal((grid.match(new RegExp(`for="${id}"`, 'g')) || []).length, 1, `${id} has exactly one label`);
        assert.match(grid, new RegExp(`id="${id}"[^>]*data-help-key="logs\\.[^"]+"`));
    }
    assert.doesNotMatch(form, /tabindex=|onkeydown=|onkeypress=/, 'native tab order and Enter submission remain intact');
});

test('browse submit/reset share a named action group; retained search remains a separate non-submit action', () => {
    const actions = form.match(/<div class="filter-actions" role="group" aria-label="Browse filters">([\s\S]*?)<\/div>/)[1];
    assert.equal((actions.match(/<button\b/g) || []).length, 2);
    assert.match(actions, /type="submit" class="btn filter-apply">Apply filters/);
    assert.match(actions, /type="button"[^>]*onclick="applyFilters\(event, true\)">Reset filters/);
    const search = form.match(/<div class="filter-search-actions">([\s\S]*?)<\/div>/)[1];
    assert.match(search, /id="search-start"[^>]*type="button"[^>]*onclick="startSearch\(\)"/);
    assert.match(search, /Progress and result controls appear above the event list/);
    assert.deepEqual([...form.matchAll(/<button\b[^>]*>([^<]+)<\/button>/g)].map(match => match[1]), ['Apply filters', 'Reset filters', 'Search retained files']);
});

test('Diagnostics remains independent of form submission and has its own wrapping, touchable label', () => {
    assert.doesNotMatch(form, /diagnosticsSwitch/);
    assert.match(html, /<\/form>\s*<div class="filter-diagnostics">\s*<label class="diagnostic-control"><input type="checkbox" id="diagnosticsSwitch" onchange="setDiagnosticVisibility\(this.checked\)" data-help-key="logs.diagnostics" data-help-proxy> Diagnostics<\/label>/);
    assert.match(template, /\.filter-diagnostics \.diagnostic-control \{[^}]*min-height: 44px[^}]*white-space: normal/);
});

test('width and text drive field reflow while exact IDs, sources, literal text and UTC retain whole rows', () => {
    assert.match(template, /grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 11rem\), 1fr\)\)/);
    for (const id of ['filter-correlationId', 'filter-flowId', 'filter-traceId', 'search-text', 'search-source', 'search-since', 'search-until']) assert.match(form, new RegExp(`<div class="filter-field-wide"><label for="${id}"`));
    assert.match(template, /\.filter-fields label \{[^}]*flex: 1[^}]*overflow-wrap: anywhere/);
    assert.match(template, /\.filter-fields input, \.filter-fields select \{[^}]*min-width: 0[^}]*min-height: 44px/);
    assert.match(template, /\.log-filters \.btn \{[^}]*min-height: 44px[^}]*white-space: normal/);
    assert.match(template, /\.filter-fields :is\(input, select\):focus-visible/);
});

/** Execute the actual shared capturing-scroll callback without duplicating its rule. */
function scrollController() {
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(__dirname, '../../shared/ui/help.js'), 'utf8');
    const callback = source.match(/function repositionAfterScroll\(event\) \{[\s\S]*?\n    \}/)[0];
    assert.match(source, /window\.addEventListener\('scroll', repositionAfterScroll, true\)/);
    const tooltip = {};
    let positions = 0;
    const context = vm.createContext({ tooltip, position() { positions++; } });
    vm.runInContext(callback, context);
    return { tooltip, scroll: target => context.repositionAfterScroll({ target }), positions: () => positions };
}

test('scrolling a clipped explanation or its descendants never resets popup geometry or reading position', () => {
    const controller = scrollController();
    controller.scroll(controller.tooltip);
    controller.scroll({ closest: selector => selector === '#pcm-help-tooltip' ? controller.tooltip : null });
    assert.equal(controller.positions(), 0);
});

test('sidebar, document and viewport scrolling still reposition the explanation at its control', () => {
    const controller = scrollController();
    controller.scroll({ closest: () => null }); // Sidebar element.
    controller.scroll({}); // Document and Window do not provide Element.closest.
    controller.scroll({});
    assert.equal(controller.positions(), 3);
});
