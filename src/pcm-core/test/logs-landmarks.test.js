'use strict';

/** Structural landmark regressions run with the default Node suite, without a browser. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');

const template = fs.readFileSync(path.join(__dirname, '../src/views/logs.ejs'), 'utf8');
const rendered = ejs.render(template, { teamId: 'landmark-<fixture>' });
const body = rendered.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)[1];

test('one named main landmark contains every authored Logs control and content region', () => {
    assert.equal((body.match(/<main\b/g) || []).length, 1);
    assert.equal((body.match(/<\/main>/g) || []).length, 1);
    const main = body.match(/^\s*<main class="logs-page" aria-labelledby="logs-title">([\s\S]*)<\/main>\s*$/);
    assert.ok(main, 'all non-script body content must belong to main');
    for (const id of ['logs-title', 'log-status', 'page-coverage', 'log-list', 'resizer', 'details-pane']) {
        assert.ok(main[1].includes(`id="${id}"`), `${id} belongs to main`);
    }
    assert.match(main[1], /<h1 id="logs-title"/);
    assert.match(main[1], /landmark-&lt;fixture&gt;/);
});

test('shared help adopts the authored Explain checkbox inside main instead of injecting a body control', () => {
    assert.equal((body.match(/class="explain-toggle"/g) || []).length, 1);
    assert.match(body, /<nav class="sandbox-navigation"[^>]*>[\s\S]*<label class="explain-toggle" data-help-key="common.explain"><input type="checkbox"> Explain this page<\/label>[\s\S]*<\/nav>/);
    // This is the shared controller's existing discovery contract. Browser tests
    // additionally check the initialized DOM, persisted help, and no duplicate toggle.
    const help = fs.readFileSync(path.join(__dirname, '../../shared/ui/help.js'), 'utf8');
    assert.match(help, /document\.querySelector\('\.explain-toggle'\)/);
});

test('main preserves the bounded flex workspace and keyboard-operable list and resizer', () => {
    const styles = template.match(/\.logs-page\s*\{([^}]+)\}/)[1];
    for (const declaration of ['flex: 1 1 auto', 'min-height: 0', 'display: flex', 'flex-direction: column', 'overflow: hidden']) {
        assert.ok(styles.includes(declaration), declaration);
    }
    // The shared tooltip is fixed to the viewport. Do not create a fixed-position
    // containing block on its main ancestor and accidentally clip it to a pane.
    assert.doesNotMatch(styles, /(?:transform|filter|perspective|contain)\s*:/);
    assert.match(body, /id="log-list"[^>]*role="region"[^>]*tabindex="0"/);
    assert.match(body, /id="resizer"[^>]*role="separator"[^>]*tabindex="0"/);
    assert.match(body, /id="details-pane"[^>]*role="region"[^>]*tabindex="0"/);
    assert.match(body, /<details class="log-controls" open><summary/);
});

/** Small initialization-only DOM: exercises the actual help controller's host choice. */
function initializeHelp({ authored = true, inMain = true } = {}) {
    class Element {
        constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = {}; }
        append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
        prepend(node) { node.parentElement = this; this.children.unshift(node); }
        contains(node) { for (let current = node; current; current = current.parentElement) if (current === this) return true; return false; }
        closest(selector) { for (let node = this; node; node = node.parentElement) if (node.tagName?.toLowerCase() === selector) return node; return null; }
        querySelector(selector) {
            const match = node => selector === '.explain-toggle' ? node.className === 'explain-toggle' : node.tagName === 'INPUT' && node.type === 'checkbox';
            for (const child of this.children) { if (match(child)) return child; const nested = child.querySelector?.(selector); if (nested) return nested; }
            return null;
        }
        querySelectorAll() { return []; }
        setAttribute(name, value) { this.attributes = { ...this.attributes, [name]: value }; }
        addEventListener(name, callback) { this.listeners[name] = callback; }
        replaceChildren() { this.children = []; }
    }
    const root = new Element('body');
    root.dataset.helpTeam = 'landmark-fixture';
    const main = new Element('main');
    root.append(main);
    let label;
    if (authored) {
        label = new Element('label'); label.className = 'explain-toggle';
        const input = new Element('input'); input.type = 'checkbox'; label.append(input);
        (inMain ? main : root).append(label);
    }
    let ready;
    const document = { body: root, querySelector: selector => root.querySelector(selector),
        createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }),
        addEventListener: (name, callback) => { if (name === 'DOMContentLoaded') ready = callback; } };
    const context = vm.createContext({ document, window: { PCM_HELP_COPY: {}, addEventListener() {} },
        location: { origin: 'http://fixture.test' }, sessionStorage: { getItem: () => null, setItem() {} },
        MutationObserver: class { disconnect() {} observe() {} }, clearTimeout, setTimeout });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../shared/ui/help.js'), 'utf8'), context);
    ready();
    return { root, main, label: root.querySelector('.explain-toggle') };
}

test('help initialization puts the dynamic tooltip with an authored main-contained toggle', () => {
    const { root, main, label } = initializeHelp();
    assert.equal(label.parentElement.className, 'explain-bar');
    assert.deepEqual(label.parentElement.attributes, { role: 'region', 'aria-label': 'Page explanations' });
    assert.equal(label.parentElement.parentElement, root);
    assert.equal(main.children.filter(node => node.id === 'pcm-help-tooltip').length, 1);
    assert.equal(root.children.filter(node => node.id === 'pcm-help-tooltip').length, 0);
    assert.equal(root.children.filter(node => node.className === 'explain-toggle').length, 0);
});

test('help initialization preserves the body fallback for existing default and body-authored controls', () => {
    for (const options of [{ authored: false }, { authored: true, inMain: false }]) {
        const { root, main, label } = initializeHelp(options);
        assert.equal(label.parentElement.className, 'explain-bar');
        assert.equal(label.parentElement.parentElement, root);
        assert.equal(root.children.filter(node => node.id === 'pcm-help-tooltip').length, 1);
        assert.equal(main.children.length, 0);
    }
});


test('workbench and shared explanation use neutral hosts for their explicit ARIA roles', () => {
    assert.match(body, /<div id="workbench" class="workbench" role="complementary"/);
    assert.doesNotMatch(body, /<aside id="workbench"/);
    const { main } = initializeHelp();
    const tooltip = main.children.find(node => node.id === 'pcm-help-tooltip');
    assert.equal(tooltip.tagName, 'DIV');
});


test('Event payload tabs and metadata are independent of the upper sidebar with a horizontal separator', () => {
    assert.match(body, /id="resizer"[^>]*aria-orientation="horizontal"[^>]*aria-controls="main-pane event-detail"/);
    assert.match(body, /id="event-detail"[^>]*aria-label="Event detail"[^>]*hidden/);
    assert.match(body, /<div id="event-metadata" class="event-metadata">/);
    assert.doesNotMatch(body, /<aside id="event-metadata"/);
    assert.match(body, /id="event-metadata-body"[^>]*role="region"[^>]*aria-label="Selected event metadata"/);
    assert.match(body, /id="tab-structured"[^>]*role="tab"[^>]*aria-controls="panel-structured"/);
    assert.match(body, /id="tab-raw"[^>]*role="tab"[^>]*aria-controls="panel-raw"/);
    for (const name of ['structured', 'raw']) assert.match(body, new RegExp(`id="panel-${name}"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-${name}"`));
    assert.doesNotMatch(body, /data-panel="event"|data-panel-tab="event"/);
    assert.match(body, /id="close-event-detail"/);
    assert.match(body, /id="close-workbench"/);
});


test('wrapped shell rows retain their natural height beside the bounded shrinkable workspace', () => {
    assert.match(template, /\.logs-page > header, \.logs-page > nav, \.logs-page > section \{ flex-shrink: 0; \}/);
    assert.match(body, /<header class="workspace-heading sandbox-header"[\s\S]*<nav class="sandbox-navigation"/);
});


test('served shell inventory adopts the shared persistent Explain controller including default and auxiliary hosts', () => {
    const owners = ['../src/views/logs.ejs', '../src/views/dashboard.ejs', '../src/views/consent.ejs', '../src/views/authorize.ejs', '../src/views/authorize-error.ejs', '../src/views/system-authentication.ejs', '../src/views/services.ejs', '../src/views/admin/shell.ejs', '../src/views/admin/auxiliary.ejs', '../../sp-client/src/views/index.ejs', '../../sp-client/src/views/patients.ejs', '../../sp-client/src/views/manage.ejs', '../../sp-client/src/views/logs.ejs', '../../shared/views/browser-page.ejs'];
    for (const owner of owners) {
        const source = fs.readFileSync(path.join(__dirname, owner), 'utf8');
        assert.ok(source.includes('/assets/help.js') || source.includes("include('shell"), owner + ' uses shared help');
        assert.ok(source.includes('data-help-team') || source.includes("include('shell"), owner + ' has the existing team preference context');
    }
    const css = fs.readFileSync(path.join(__dirname, '../../shared/ui/connectathon.css'), 'utf8');
    assert.match(css, /\.explain-bar \{ position: sticky; top: 0;/);
});


test('sidebar tabs retain associated panels and a separate labelled close action', () => {
    for (const name of ['filters', 'coverage', 'columns', 'tools']) {
        assert.ok(body.includes(`id="workbench-tab-${name}" role="tab" aria-controls="workbench-panel-${name}"`));
        assert.ok(body.includes(`id="workbench-panel-${name}" role="tabpanel" aria-labelledby="workbench-tab-${name}"`));
    }
    assert.match(body, /<\/nav>\s*<button id="close-workbench"[^>]+aria-label="Close tools">Close tools/);
});
