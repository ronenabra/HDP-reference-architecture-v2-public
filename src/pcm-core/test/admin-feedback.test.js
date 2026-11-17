'use strict';
/** Plain Admin feedback is shared across server rendering and browser observations. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../../../test-support/team-config').installTestRuntime();
const { operationSummary, requestFailure } = require('../../shared/ui/admin-feedback');
const { DataOperationRegistry } = require('../src/data-operations');

test('unknown, running, failed, checked and cleared results stay distinct', () => {
    assert.match(operationSummary({ phase: 'failed', needsReconciliation: true }), /couldn't confirm/);
    assert.match(operationSummary({ kind: 'reset', needsReconciliation: true }), /whether deletion finished/);
    assert.match(operationSummary({ phase: 'failed' }), /did not finish/);
    assert.match(operationSummary({ currentStage: 'transaction-waiting' }), /in progress/);
    assert.match(operationSummary({ currentStage: 'constructor' }), /still in progress/);
    assert.match(operationSummary({ phase: 'succeeded' }), /Import complete/);
    assert.match(operationSummary({ phase: 'succeeded', reconciliationVerifiedAt: 'now' }), /No file was imported again/);
    // Successful recovery deletion retains the ledger's failed phase for the old import.
    assert.match(operationSummary({ phase: 'failed', resetVerifiedAt: 'now', submittedOutcome: 'resolved-by-target-reset' }), /All data and saved versions were deleted/);
    assert.match(requestFailure('target ho-a is busy; operation UUID', true), /latest result and recovery controls/);
    assert.match(requestFailure('operation worker is still running'), /local operator/);
    assert.match(requestFailure('target-specific reset confirmation is missing or stale'), /Reload Admin/);
});

test('initial recovery markup uses target-bound unchecked boxes and keeps IDs in details', () => {
    const registry = new DataOperationRegistry();
    const operation = registry.create('ho-a', 'import');
    registry.transition(operation.id, 'failed', { mutationSubmitted: true, needsReconciliation: true });
    const html = require('../src/routes/ui')._test.renderAdminHtml({ query: { section: 'sources', source: require('../src/team-config').loadTeamConfig().healthOrganizations[0].dataSourceOrganization.id, view: 'data' } });
    const card = html.split('data-managed-fhir-server="ho-a"')[1].split('data-managed-fhir-server="ho-b"')[0];
    assert.match(card, /couldn&#39;t confirm|couldn't confirm/);
    assert.match(card, /Check this import/);
    assert.match(card, /Clear .* and allow another import/);
    assert.match(card, /type="checkbox"[^>]*name="confirmation"[^>]*value="delete-all:[^"]+:ho-a"[^>]*required/);
    assert.doesNotMatch(card, /Type exact|placeholder="delete-all:|name="confirmation"[^>]*checked/);
    const visible = card.replace(/<details>[\s\S]*?<\/details>/g, '').replace(/<[^>]*>/g, '');
    assert.doesNotMatch(visible, new RegExp(operation.id));
    assert.doesNotMatch(visible, /reconciliation-required|Submitted outcome unknown/);
    const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(match => match[0]);
    for (const action of ['/admin/config/data-sources/remove', '/admin/config/identity-mapping/remove', '/admin/logs/clear', '/admin/reset', '/admin/restore']) {
        for (const form of forms.filter(form => form.includes(`action="${action}"`))) {
            assert.doesNotMatch(form, /data-delete-acknowledgement|type="checkbox"[^>]*name="confirmation"/);
        }
    }
});

test('HTML data-operation errors hide raw errors and confirmation tokens in details', () => {
    let html;
    require('../src/routes/ui')._test.sendAdminError({ path: '/admin/api/data-operations/demo/reset', get: () => 'text/html' },
        { status() {}, send(value) { html = value; } }, 409, 'target-specific reset confirmation is missing or stale', { expectedConfirmation: 'delete-all:demo:ho-a' });
    assert.match(html, /Deletion was not started/);
    assert.doesNotMatch(html, /delete-all:demo:ho-a/);
});

test('authored recovery help matches checkbox controls and keeps non-replay guarantees', () => {
    const { parseCatalog } = require('../../../scripts/generate-ui-help');
    const catalog = parseCatalog(fs.readFileSync(path.join(__dirname, '../../../docs/ui-explanation-catalog.md'), 'utf8'));
    assert.match(catalog['admin.data-confirmation'].body, /saved versions/);
    assert.match(catalog['admin.data-confirmation'].technical, /No confirmation text needs to be typed/);
    assert.match(catalog['admin.recovery-reset'].body, /both.*acknowledgement/);
    assert.match(catalog['admin.recovery-verify'].body, /without uploading the file again/);
});

/** Replacement keeps reset evidence even while its subsequent import is running. */
test('a completed replacement clearing step never hides a running or uncertain import', () => {
    const replacement = { kind: 'replace', resetVerifiedAt: 'now', currentStage: 'transaction-waiting' };
    assert.match(operationSummary({ ...replacement, phase: 'loading' }), /Import in progress/);
    assert.match(operationSummary({ ...replacement, phase: 'failed', needsReconciliation: true }), /couldn't confirm whether the import finished/);
    assert.match(operationSummary({ ...replacement, phase: 'succeeded' }), /Import complete/);
    assert.match(operationSummary({ kind: 'reset', phase: 'failed', resetVerifiedAt: 'now', needsReconciliation: true }), /whether deletion finished/);
});

test('a refused filename gives a concrete correction without implying an uncertain mutation', () => {
    const { requestFailure } = require('../../shared/ui/admin-feedback');
    const message = requestFailure('bundle filename must end in .source.transaction.json');
    assert.match(message, /File rejected before import/);
    assert.match(message, /filename ends in \.source\.transaction\.json/);
    assert.doesNotMatch(message, /missing response|may.*saved/i);
});
