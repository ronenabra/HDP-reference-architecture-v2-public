'use strict';
/** Structured panel projection and target acknowledgement API regressions. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
require('../../../test-support/team-config').installTestRuntime();

/** Minimal text-safe DOM with inspectable semantic children, rather than string-only stubs. */
function element(tagName) {
    return { tagName, dataset: {}, children: [], ownText: '',
        get textContent() { return this.ownText + this.children.map(child => child.textContent).join(' '); },
        set textContent(text) { this.ownText = String(text); this.children = []; },
        append(...children) { this.children.push(...children); },
        querySelector(tag) { return this.children.find(child => child.tagName === tag) || null; },
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
        insertBefore(child, reference) { this.children.splice(this.children.indexOf(reference), 0, child); },
        replaceChildren(...children) { this.ownText = ''; this.children = children; } };
}
const source = fs.readFileSync(path.join(__dirname, '../../shared/ui/admin-feedback.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '../../shared/ui/connectathon.js'), 'utf8');
function project(expression, data) {
    const output = element('section'); output.dataset.target = 'ho-a';
    vm.runInNewContext(`${source}\n${expression}(output, data)`, {
        window: {}, document: { addEventListener() {}, createElement: element }, output, data
    });
    return output;
}

test('counts panels use a heading and table, retain exact zeros and label unavailable values', () => {
    const output = project('renderTargetCounts', { state: 'loaded', actualResourceCount: 12, hasHistory: true,
        actualCounts: { Patient: 12, Observation: 0, '<script>unknown</script>': undefined } });
    assert.equal(output.children[0].tagName, 'h4');
    assert.match(output.children[0].textContent, /ho-a/);
    assert.equal(output.children[2].tagName, 'table');
    assert.match(output.textContent, /Observation 0/);
    assert.match(output.textContent, /<script>unknown<\/script> unavailable/);
    const unavailable = project('renderTargetCounts', {});
    assert.match(unavailable.textContent, /unavailable current resources.*history unavailable/);
    assert.doesNotMatch(unavailable.textContent, /0 current resources/);
});

test('operation polls retain disclosure identity and the user-selected open or closed state', () => {
    const output = element('section');
    const context = { window: {}, document: { addEventListener() {}, createElement: element } };
    vm.runInNewContext(source, context);
    const operation = { id: 'polling', serverId: 'ho-a', phase: 'loading', currentStage: 'transaction-waiting' };
    context.renderDataOperation(output, operation);
    const detail = output.querySelector('details'), summary = detail.querySelector('summary');
    detail.open = true;
    context.renderDataOperation(output, { ...operation, phase: 'verifying', currentStage: 'verification-started', verifiedTypes: [{ type: 'Patient', count: 12 }] });
    assert.equal(output.querySelector('details'), detail);
    assert.equal(detail.querySelector('summary'), summary);
    assert.equal(detail.open, true);
    assert.match(detail.textContent, /Patient 12/);
    detail.open = false;
    context.renderDataOperation(output, operation);
    assert.equal(output.querySelector('details'), detail);
    assert.equal(detail.querySelector('summary'), summary);
    assert.equal(detail.open, false);
    assert.equal(detail.querySelector('table'), null);
});

test('operation panels preserve milestones, verification, diagnostics and visible uncertain outcomes', () => {
    const output = project('renderDataOperation', { id: 'operation-a', serverId: 'ho-a', kind: 'import',
        phase: 'failed', status: 'uncertain', currentStage: 'failed', needsReconciliation: true,
        bundleName: '<img>fabricated.source.transaction.json', entries: 12, elapsedMilliseconds: 3000,
        progressEvents: [{ event: 'transaction-waiting', at: '2026-10-04T00:00:00Z' }],
        verifiedTypes: [{ type: 'Patient', count: 12 }], diagnostics: ['synthetic error'] });
    assert.equal(output.children[0].tagName, 'h4');
    const detail = output.children.find(child => child.tagName === 'details');
    assert.ok(detail.children.some(child => child.tagName === 'ol'));
    assert.ok(detail.children.some(child => child.tagName === 'table'));
    assert.match(detail.textContent, /synthetic error/);
    assert.ok(output.children.some(child => child.dataset.helpKey === 'admin.operation-uncertain'));
    assert.match(output.textContent, /We couldn't confirm whether the import finished/);
    assert.match(output.textContent, /<img>fabricated/);
    assert.doesNotMatch(output.textContent, /\d+%/);
});

test('verified recovery and recovery reset retain their own action names', () => {
    const base = { id: 'recovered', serverId: 'ho-a', kind: 'import', phase: 'succeeded', currentStage: 'completed' };
    assert.match(project('renderDataOperation', { ...base, reconciliationVerifiedAt: '2026-10-04' }).children[0].textContent, /^Check this import/);
    assert.match(project('renderDataOperation', { ...base, resetVerifiedAt: '2026-10-04', submittedOutcome: 'resolved-by-target-reset', phase: 'failed', currentStage: 'failed' }).children[0].textContent, /^Clear server/);
});

test('cancelled recovery does not disable controls; accepted work stays attributed to its action', () => {
    const listeners = [];
    const button = { disabled: false };
    const output = element('section'); output.hidden = true;
    const form = { dataset: { progress: 'recovery', progressLabel: 'Verify stopped import · ho-a' },
        addEventListener(_event, handler) { listeners.push(handler); }, querySelectorAll() { return [button]; } };
    vm.runInNewContext(source, { window: {}, document: { addEventListener(event, ready) { if (event === 'DOMContentLoaded') ready(); },
        getElementById() { return output; }, querySelector() { return null; },
        querySelectorAll(selector) { return selector === 'form[data-progress]:not([data-async-operation])' ? [form] : []; } } });
    listeners[0]({ defaultPrevented: true });
    assert.equal(button.disabled, false);
    assert.equal(output.hidden, true);
    listeners[0]({ defaultPrevented: false });
    assert.equal(button.disabled, true);
    assert.match(output.textContent, /^Verify stopped import · ho-a · Working/);
});

test('absent, stale and cross-target checkbox tokens fail before maintenance is queued', async t => {
    const { createUiApp } = require('../src/index');
    const app = createUiApp();
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const config = require('../src/team-config').loadTeamConfig();
    const render = index => require('../src/routes/ui')._test.renderAdminHtml({ query: {
        section: 'sources', source: config.healthOrganizations[index].dataSourceOrganization.id, view: 'data' } });
    const html = render(0);
    assert.match(html, /name="confirmation" value="[^"]+" required autocomplete="off" data-delete-acknowledgement/);
    assert.match(html, /data-help-key="admin.data-delete">Delete all data/);
    const tokenB = render(1).match(/id="delete-ho-b" name="confirmation" value="([^"]+)"/)[1];
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const confirmation of [undefined, '', 'stale-team:ho-a', tokenB]) {
        const response = await fetch(`${base}/admin/api/fhir-servers/ho-a/data`, { method: 'DELETE',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ confirmation }) });
        assert.equal(response.status, 409);
        assert.match((await response.json()).error, /missing or stale/);
    }
});

test('operation diagnostics navigation retains the page mount and exact operation filter', () => {
    const output = element('section'), link = element('a');
    output.ownerDocument = { body: { dataset: { browserBase: '/pcm' } } };
    output.closest = () => ({ dataset: {}, querySelector: () => link });
    const context = { window: {}, document: { addEventListener() {}, createElement: element } };
    vm.runInNewContext(source, context);
    context.renderDataOperation(output, { id: 'owned operation', serverId: 'ho-a', phase: 'loading', currentStage: 'transaction-waiting' });
    assert.equal(link.href, '/pcm/admin/logs/view?operationId=owned%20operation');
    assert.equal(link.hidden, false);
});
