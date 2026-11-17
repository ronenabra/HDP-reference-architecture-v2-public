'use strict';

/** Focused renderer regression for deadlines on persisted import stages. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../shared/ui/admin-feedback.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '../../shared/ui/connectathon.js'), 'utf8');

/** Render a server observation without starting browser polling. */
function render(operation) {
    const output = { hidden: true, style: {}, children: [], dataset: { helpKey: 'common.working' }, textContent: '',
        replaceChildren(...nodes) { this.textContent = nodes.map(node => node.textContent).join('\n'); } };
    vm.runInNewContext(`${source}\nrenderDataOperation(output, operation);`, {
        window: {}, document: { addEventListener() {}, createElement(tagName) { return { tagName, dataset: {}, style: {}, textContent: '',
            append(...nodes) { this.textContent += nodes.map(node => node.textContent).join('\n'); },
            replaceChildren(...nodes) { this.textContent = nodes.map(node => node.textContent).join('\n'); } }; } }, output, operation
    });
    assert.equal(output.dataset.helpKey, 'admin.operation-status');
    return output.textContent;
}

test('accepted response clears its expired deadline while verification uses its own budget', () => {
    const start = '2026-09-29T00:00:00.000Z';
    const response = '2026-09-29T00:00:09.000Z';
    const operation = {
        serverId: 'ho-a', phase: 'loading', status: 'running', currentStage: 'transaction-waiting',
        observedAt: '2026-09-29T00:00:12.000Z', transactionDeadlineAt: '2026-09-29T00:00:10.000Z',
        waitMilliseconds: 12000, elapsedMilliseconds: 12000, stageElapsedMilliseconds: 12000,
        stageTimestamps: { 'transaction-waiting': start }, deadlines: { verificationMs: 5000 }
    };
    assert.match(render(operation), /response deadline passed/);

    operation.phase = 'verifying';
    operation.currentStage = 'verification-started';
    operation.waitMilliseconds = 9000;
    operation.stageTimestamps['response-received'] = response;
    operation.stageTimestamps['transaction-accepted'] = response;
    operation.stageTimestamps['verification-started'] = response;
    assert.match(render(operation), /Checking saved source and dataset counts/);
    assert.match(render(operation), /HAPI transaction response accepted/);
    assert.match(render(operation), /Read-only verification · latest deadline/);
    assert.doesNotMatch(render(operation), /response deadline passed|Recorded stage may be stale/);

    operation.observedAt = '2026-09-29T00:00:15.000Z';
    assert.match(render(operation), /read-only verification deadline passed/);
    assert.doesNotMatch(render(operation), /response deadline passed/);

    operation.result = 'verified';
    assert.doesNotMatch(render(operation), /Recorded stage may be stale|latest deadline/);

    operation.phase = 'succeeded';
    operation.currentStage = 'completed';
    assert.doesNotMatch(render(operation), /Recorded stage may be stale/);
});

/** Sizes retain exact bytes and timing retains seconds alongside readable larger units. */
test('import observations show decimal MB and minutes with exact base units', () => {
    const base = { serverId: 'ho-c', phase: 'failed', status: 'reconciliation-required',
        currentStage: 'reconciliation-required', bytes: 539912306, entries: 117447,
        elapsedMilliseconds: 166905, stageElapsedMilliseconds: 0, waitMilliseconds: 93284,
        stageTimestamps: { 'transaction-waiting': '2026-10-08T15:19:33Z' } };
    const text = render(base);
    assert.match(text, /539\.9 MB \(539912306 bytes\)/);
    assert.match(text, /elapsed 2\.78 minutes \(166\.9 seconds\)/);
    assert.match(text, /stage 0 minutes \(0 seconds\)/);
    assert.match(text, /HAPI response wait 1\.55 minutes \(93\.3 seconds\)/);
    assert.match(render({ ...base, elapsedMilliseconds: 3600000 }), /60 minutes \(3600 seconds\)/);
});

test('import formatting preserves small and zero sizes and unknown durations', () => {
    const base = { serverId: 'ho-c', phase: 'loading', status: 'running' };
    assert.match(render({ ...base, bytes: 512 }), /0\.000512 MB \(512 bytes\)/);
    assert.match(render({ ...base, bytes: 0 }), /0 MB \(0 bytes\)/);
    assert.match(render(base), /elapsed unknown · stage unknown/);
    assert.doesNotMatch(render(base), /NaN|undefined bytes| MB/);
});
