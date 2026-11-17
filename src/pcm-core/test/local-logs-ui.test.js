'use strict';
/** Execute both local templates with hostile text, paused reads and native Tools keys. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ejs = require('ejs');
const catalog = require('../../../scripts/generate-ui-help').parseCatalog(fs.readFileSync(path.join(__dirname, '../../../docs/ui-explanation-catalog.md'), 'utf8'));
for (const file of ['sp-client/src/views/logs.ejs', 'ds-fhir-server/src/logs.ejs']) {
    test(`${file}: interactive and dynamically revealed controls have authored Help`, () => {
        const html = ejs.render(fs.readFileSync(path.join(__dirname, '../../', file), 'utf8'), {
            serviceName: 'Owned service', teamId: 'owned', browserBase: '/doctor', publicUrls: { spClient: '/doctor', pcmUi: '/pcm' }
        });
        for (const control of html.match(/<(?:a|button|input|select|textarea)\b[^>]*>/g)) {
            if (control === '<input type="checkbox">') continue; // Explain is bound by its parent label.
            const key = control.match(/data-help-key="([^"]+)"/)?.[1];
            assert.ok(key, `Missing explanation for ${control}`);
            assert.ok(catalog[key]?.title && catalog[key]?.body, `Unknown authored explanation ${key}`);
        }
    });
    test(`${file}: scoped shell, exact text selection, Tools and paused/error reads`, async () => {
        const html = ejs.render(fs.readFileSync(path.join(__dirname, '../../', file), 'utf8'), {
            serviceName: 'Owned <service>', teamId: 'owned', browserBase: '/doctor',
            publicUrls: { spClient: '/doctor', pcmUi: '/pcm' }
        });
        assert.match(html, /href="\/pcm\/admin\/services"/);
        assert.match(html, /aria-current="page"/);
        assert.doesNotMatch(html, /localhost:|cdn\.jsdelivr|innerHTML/);
        assert.match(html, /Owned &lt;service&gt;/);
        const nodes = new Map(), listeners = {}, requests = [];
        const node = id => {
            if (!nodes.has(id)) nodes.set(id, { id, hidden: id === 'local-tools' || id === 'pcm-help-tooltip', dataset: {},
                setAttribute(name, value) { this[name] = value; }, focus() { document.activeElement = this; },
                replaceChildren(...children) { this.children = children; }, addEventListener() {} });
            return nodes.get(id);
        };
        const document = { body: { dataset: { browserBase: '/doctor', serviceName: 'Owned service' } },
            getElementById: node, createElement: tag => ({ tag, dataset: {} }), querySelectorAll: () => [],
            addEventListener: (name, callback) => { listeners[name] = callback; } };
        const record = { id: 'exact', level: 'INFO', timestamp: '2026-11-14T00:00:00Z', message: '<img src=x>', details: { token: 'complete <value>' } };
        let fail = false, copied;
        const context = vm.createContext({ document, window: { PCM_LOG_CLIPBOARD: { create: () => ({ copy: text => { copied = text; } }) } }, navigator: {}, setInterval() {},
            fetch: async url => { requests.push(url); return { ok: !fail, status: 503, headers: { get: () => null }, json: async () => [record] }; } });
        vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
        vm.runInContext('toggleLocalTools()', context);
        assert.equal(node('local-tools').hidden, false);
        assert.equal(document.activeElement, node('close-local-tools'));
        assert.equal(requests.length, 0);
        node('pcm-help-tooltip').hidden = false;
        listeners.keydown({ key: 'Escape' });
        assert.equal(node('local-tools').hidden, false, 'Explain Escape preserves Tools');
        node('pcm-help-tooltip').hidden = true;
        listeners.keydown({ key: 'Escape', preventDefault() {} });
        assert.equal(node('local-tools').hidden, true);
        assert.equal(document.activeElement, node('local-tools-button'));
        await vm.runInContext('refreshLogs()', context);
        assert.deepEqual(requests, ['/doctor/api/logs']);
        vm.runInContext('selectLog("exact"); copyLocalRecord()', context);
        assert.equal(node('details-pane').children[1].textContent.includes('<img src=x>'), true);
        assert.equal(node('details-pane').children[2].textContent, JSON.stringify(record.details, null, 2));
        assert.equal(copied, JSON.stringify(record, null, 2));
        vm.runInContext('isPaused = true', context); await vm.runInContext('refreshLogs()', context);
        assert.equal(requests.length, 1);
        vm.runInContext('isPaused = false', context); fail = true; await vm.runInContext('refreshLogs()', context);
        assert.match(node('local-log-status').textContent, /503.*last successful result/);
        assert.equal(node('details-pane').children[2].textContent, JSON.stringify(record.details, null, 2));
    });
}
