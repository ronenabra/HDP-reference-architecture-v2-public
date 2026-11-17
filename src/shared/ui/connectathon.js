'use strict';

/** Coordinate page navigation across uploads, polling and unsaved forms.
 * begin() returns an idempotent completion callback so overlapping request/poll
 * lifetimes cannot release another action's navigation guard.
 * @param {object} options Navigation, timer and presentation callbacks.
 * @returns {object} Activity, edit and explicit-refresh controls for this page.
 */
function createAdminRefreshCoordinator({ reload, setTimer, clearTimer, onChange = () => {} }) {
    const active = new Set();
    const dirtyForms = new Set();
    let requested = false;
    let needsAttention = false;
    let timer = null;
    const eligible = () => requested && !active.size && !dirtyForms.size && !needsAttention;
    const update = () => {
        if (timer !== null) { clearTimer(timer); timer = null; }
        onChange({ busy: active.size > 0, dirty: dirtyForms.size > 0, needsAttention, requested });
        if (eligible()) timer = setTimer(() => {
            timer = null;
            // Recheck at execution, including a new upload during the grace period.
            if (eligible()) reload();
        }, 500);
    };
    return {
        begin() {
            const token = {};
            active.add(token);
            update();
            return () => { if (active.delete(token)) update(); };
        },
        success() { requested = true; update(); },
        attention() { needsAttention = true; update(); },
        edited(form) { dirtyForms.add(form); update(); },
        submitted(form) { dirtyForms.delete(form); update(); },
        navigationBlocked() { return active.size > 0; },
        refresh() { if (active.size) return false; reload(); return true; }
    };
}

/** Render only server-recorded import milestones; a transaction has no entry progress. */
function renderDataOperation(output, operation, interrupted = false) {
    const diagnosticLink = output.closest?.('[data-managed-fhir-server]')?.querySelector('[data-import-log-link]');
    if (diagnosticLink && operation.id && operation.serverId) {
        diagnosticLink.href = `${output.ownerDocument?.body?.dataset?.browserBase || ''}/admin/logs/view?operationId=${encodeURIComponent(operation.id)}`;
        diagnosticLink.hidden = false;
    }
    const labels = {
        'upload-received': 'Upload received', 'reset-request-received': 'Reset request received',
        'bundle-check-started': 'Checking bundle contract',
        'bundle-check-complete': 'Bundle contract checked', 'target-preflight-started': 'Checking target',
        'target-preflight-complete': 'Target preflight complete', 'reset-started': 'Resetting target',
        'reset-complete': 'Target reset verified', 'transaction-waiting': 'Waiting for HAPI transaction response',
        'response-received': 'HAPI response received', 'transaction-accepted': 'HAPI transaction response accepted',
        'verification-started': 'Checking persisted resources by type',
        'type-verified': 'Resource type verified', 'inventory-publication-started': 'Publishing verified inventory',
        completed: 'Completed', 'reconciliation-required': 'Reconciliation required', failed: 'Failed'
    };
    const duration = milliseconds => milliseconds == null ? 'unknown'
        : `${Number((milliseconds / 60000).toFixed(2))} minutes (${Number((milliseconds / 1000).toFixed(1))} seconds)`;
    const stage = labels[operation.currentStage] || operation.phase;
    const target = output.closest?.('[data-managed-fhir-server]')?.dataset.serverName || operation.serverId || 'This server';
    const summaryText = PCM_ADMIN_FEEDBACK.operationSummary(operation);
    const lines = [];
    const addLine = (key, text) => lines.push({ key, text });
    addLine('admin.operation-time', `Last recorded: ${stage} · ledger ${operation.status} · elapsed ${duration(operation.elapsedMilliseconds)} · stage ${duration(operation.stageElapsedMilliseconds)}`);
    const details = [`Target ${operation.serverId}`];
    if (operation.bundleName) details.push(`bundle ${operation.bundleName}`);
    if (Number.isSafeInteger(operation.entries)) details.push(`${operation.entries} entries`);
    if (Number.isSafeInteger(operation.bytes)) details.push(`${Number((operation.bytes / 1000000).toPrecision(4))} MB (${operation.bytes} bytes)`);
    addLine('admin.operation-bundle', details.join(' · '));
    const responseReceived = Boolean(operation.stageTimestamps?.['response-received'] || operation.stageTimestamps?.['transaction-accepted']);
    if (operation.stageTimestamps?.['transaction-waiting']) {
        const wait = `HAPI response wait ${duration(operation.waitMilliseconds)}`;
        addLine('admin.operation-time', responseReceived ? wait : `${wait} · latest deadline ${operation.transactionDeadlineAt ? new Date(operation.transactionDeadlineAt).toLocaleString() : 'unknown'}`);
    }
    if (operation.stageTimestamps?.['transaction-accepted']) {
        addLine('admin.operation-verification', 'HAPI transaction response accepted; post-load verification is separate.');
    }
    const verifyingSince = operation.stageTimestamps?.['verification-started'];
    const verificationMs = operation.deadlines?.verificationMs;
    const verificationPending = operation.currentStage === 'verification-started' && operation.result !== 'verified' &&
        verifyingSince && Number.isSafeInteger(verificationMs) && verificationMs > 0;
    const verificationDeadlineAt = verificationPending ? Date.parse(verifyingSince) + verificationMs : null;
    if (Number.isFinite(verificationDeadlineAt)) {
        addLine('admin.operation-verification', `Read-only verification · latest deadline ${new Date(verificationDeadlineAt).toLocaleString()}`);
    }
    if (operation.verifiedTypes?.length) {
        const types = operation.verifiedTypes.filter(item => item.count > 0).map(item => `${item.type} ${item.count}`);
        addLine('admin.operation-verification', `Post-load type checks ${operation.verifiedTypes.length}/${operation.verificationTypeTotal || '?'}${types.length ? ` · ${types.join(', ')}` : ''}`);
    }
    const events = (operation.progressEvents || []).slice(-6).map(item => `${labels[item.event] || item.event} ${new Date(item.at).toLocaleTimeString()}`);
    if (events.length) addLine('admin.operation-events', `Recorded stages: ${events.join(' → ')}`);
    if (operation.phase === 'failed') {
        addLine('admin.operation-events', `Last completed: ${labels[operation.lastCompletedStage] || 'unknown'}`);
        if (operation.needsReconciliation) addLine('admin.operation-uncertain', operation.kind === 'reset'
            ? "We couldn't confirm whether deletion finished. Ask the local operator to confirm the earlier request and database work have stopped before clearing this server again."
            : "We couldn't confirm whether the import finished. Ask the local operator to confirm the import process and database transaction have stopped, then use Check this import before trying again.");
        if (operation.failureStage) addLine('admin.operation-uncertain', 'Review the technical details and import diagnostics before trying again.');
    } else if (!['succeeded', 'failed'].includes(operation.phase)) {
        if (Number.isFinite(verificationDeadlineAt) && Date.parse(operation.observedAt) > verificationDeadlineAt) {
            addLine('admin.operation-uncertain', 'The read-only verification deadline passed. The result may be out of date. Ask the local operator to check whether the import has stopped before recovery.');
        } else if (operation.currentStage === 'transaction-waiting' && !responseReceived &&
            operation.transactionDeadlineAt && Date.parse(operation.observedAt) > Date.parse(operation.transactionDeadlineAt)) {
            addLine('admin.operation-uncertain', 'The response deadline passed. The import may still be running. Ask the local operator to check before recovery.');
        }
    }
    if (interrupted) addLine('admin.operation-uncertain', 'Status updates were interrupted. This is the last confirmed result; reconnecting. The import may still be running.');
    output.hidden = false;
    output.dataset.helpKey = 'admin.operation-status';
    const node = (tag, text, key) => {
        const element = document.createElement(tag);
        element.textContent = text;
        if (key) element.dataset.helpKey = key;
        return element;
    };
    const recoveredByClearing = operation.resetVerifiedAt && operation.submittedOutcome === 'resolved-by-target-reset' && !operation.needsReconciliation;
    const action = recoveredByClearing ? 'Clear server'
        : operation.reconciliationVerifiedAt ? 'Check this import'
            : operation.kind === 'reset' ? 'Delete all data' : 'Check bundle and import';
    const heading = node('h4', `${action} · ${target}`, 'admin.operation-status');
    const summary = [node('p', summaryText, 'admin.operation-status'),
        node('p', `Last observed stage: ${stage} · recorded ${operation.updatedAt || 'unavailable'} · observed ${operation.observedAt || 'unavailable'}`, 'admin.operation-time')];
    // Polls can arrive between pointer-down and activation. Keep the actual
    // disclosure controls, rather than replacing the user's interaction target.
    const detail = output.querySelector?.('details') || document.createElement('details');
    const disclosure = detail.querySelector?.('summary');
    if (disclosure) {
        for (const child of Array.from(detail.children)) if (child !== disclosure) detail.removeChild(child);
    } else detail.append(node('summary', 'Technical details', 'common.details'));
    detail.append(node('p', `Operation ${operation.id || 'unknown'} · target ${operation.serverId} · ${stage}`, 'admin.operation-events'));
    detail.append(...lines.map(({ key, text }) => node('p', text, key)));
    const milestones = document.createElement('ol');
    for (const item of operation.progressEvents || []) {
        milestones.append(node('li', `${labels[item.event] || item.event} · ${new Date(item.at).toLocaleString()}`, 'admin.operation-events'));
    }
    detail.append(milestones);
    if (operation.id) {
        const raw = node('a', 'Raw saved operation JSON');
        raw.href = `${output.ownerDocument?.body?.dataset?.browserBase || ''}/admin/api/data-operations/${encodeURIComponent(operation.id)}`;
        detail.append(raw);
    }
    if (operation.verifiedTypes?.length) {
        const table = document.createElement('table');
        table.className = 'table table-sm';
        const caption = node('caption', 'Post-load resource verification', 'admin.operation-verification');
        const head = document.createElement('tr');
        head.append(node('th', 'Resource type'), node('th', 'Verified count'));
        const body = document.createElement('tbody');
        for (const item of operation.verifiedTypes) {
            const row = document.createElement('tr');
            row.append(node('td', item.type), node('td', String(item.count)));
            body.append(row);
        }
        table.append(caption, head, body);
        detail.append(table);
    }
    if (operation.diagnostics?.length) detail.append(node('pre', JSON.stringify(operation.diagnostics, null, 2)));
    const children = [heading, ...summary, detail];
    if (operation.id && operation.serverId) {
        const link = node('a', 'Open related diagnostics', 'admin.operation-logs');
        link.href = `${link.ownerDocument?.body?.dataset?.browserBase || ''}/admin/logs/view?operationId=${encodeURIComponent(operation.id)}`;
        children.push(link);
    }
    // Keep uncertain/failure warnings visible without opening the detail section.
    children.push(...lines.filter(line => line.key === 'admin.operation-uncertain').map(({ key, text }) => node('p', text, key)));
    if (Array.from(output.children).includes(detail)) {
        // Even detaching and reinserting the same summary loses a pending native
        // click in Chromium/Firefox. Refresh its siblings without disconnecting it.
        for (const child of Array.from(output.children)) if (child !== detail) output.removeChild(child);
        const boundary = children.indexOf(detail);
        for (const child of children.slice(0, boundary)) output.insertBefore(child, detail);
        for (const child of children.slice(boundary + 1)) output.append(child);
    } else output.replaceChildren(...children);
}

/** Render exact counts separately from tagged bundle verification; missing is never zero. */
function renderTargetCounts(output, result) {
    const heading = document.createElement('h4');
    heading.textContent = `Server counts · ${output.dataset.target}`;
    const summary = document.createElement('p');
    const states = { empty: 'This server is empty', loaded: 'Imported data is available', unreconciled: 'Data is present but has not been verified', populated: 'Data is present' };
    summary.textContent = `${Object.hasOwn(states, result.state) ? states[result.state] : 'An import or deletion may still need attention'} · ${Number.isSafeInteger(result.actualResourceCount) ? result.actualResourceCount : 'unavailable'} current resources · history ${typeof result.hasHistory === 'boolean' ? (result.hasHistory ? 'present' : 'absent') : 'unavailable'}`;
    const table = document.createElement('table');
    table.className = 'table table-sm';
    const header = document.createElement('tr');
    for (const text of ['Resource type', 'Current count']) {
        const cell = document.createElement('th'); cell.textContent = text; header.append(cell);
    }
    const body = document.createElement('tbody');
    for (const [type, count] of Object.entries(result.actualCounts || {})) {
        const row = document.createElement('tr');
        for (const value of [type, Number.isSafeInteger(count) ? count : 'unavailable']) {
            const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell);
        }
        body.append(row);
    }
    table.append(header, body);
    output.replaceChildren(heading, summary, table);
}

document.addEventListener('DOMContentLoaded', () => {
    // Expand only the rendered explanation for this Consent; no request or state change.
    document.querySelectorAll('[data-consent-status-toggle]').forEach(button => {
        const row = document.getElementById(button.getAttribute('aria-controls'));
        if (!row) return;
        button.addEventListener('click', () => {
            row.hidden = !row.hidden;
            const label = row.hidden ? 'Show status details' : 'Hide status details';
            button.textContent = label;
            button.setAttribute('aria-expanded', String(!row.hidden));
            button.setAttribute('aria-label', `${label} for Consent ${button.dataset.statusConsent}`);
        });
        button.hidden = false;
    });
    const refreshButton = document.querySelector('[data-admin-refresh]');
    const refreshStatus = document.querySelector('[data-admin-refresh-status]');
    const refresh = createAdminRefreshCoordinator({
        // A failed form is rendered on its POST URL. Explicit refresh returns to
        // the exact source GET workspace rather than replaying that request.
        reload: () => refreshButton?.dataset.adminRefreshUrl
            ? window.location.assign(refreshButton.dataset.adminRefreshUrl) : window.location.reload(),
        setTimer: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
        clearTimer: timer => window.clearTimeout(timer),
        onChange({ busy, dirty, needsAttention, requested }) {
            if (refreshButton) refreshButton.disabled = busy;
            if (refreshStatus) refreshStatus.textContent = busy
                ? 'Refresh waits while requests or status checks are in progress on any server.'
                : needsAttention ? 'A request needs attention. Review its result, then refresh to see saved server details and recovery controls.'
                    : dirty ? 'Unsaved form changes are kept. Refresh when ready to discard them and see saved server details.'
                        : requested ? 'All requests finished. Refreshing saved server details…'
                            : 'Refresh to see saved server details and recovery controls. Unsaved form changes will be discarded.';
        }
    });
    refreshButton?.addEventListener('click', () => refresh.refresh());
    // Section/source/app navigation shares the same upload and poll lifetimes.
    // A second request finishing cannot release an earlier active operation.
    document.addEventListener('click', event => {
        if (!event.target?.closest?.('a[href]') || !refresh.navigationBlocked()) return;
        event.preventDefault();
        const status = document.querySelector('[data-admin-navigation-status]');
        if (status) status.textContent = 'Stay on this Admin page while an upload or status check is in progress. Its saved result remains bound to this server.';
    }, true);
    window.addEventListener?.('beforeunload', event => {
        if (!refresh.navigationBlocked()) return;
        event.preventDefault(); event.returnValue = '';
    });
    for (const form of document.querySelectorAll('form')) {
        // Includes file selection and unrelated config edits that a reload would discard.
        for (const eventName of ['input', 'change']) form.addEventListener(eventName, () => refresh.edited(form));
    }
    /** Acknowledgements belong to one submission and are never restored from browser history. */
    function clearAcknowledgements(form) {
        for (const input of form.querySelectorAll('[data-delete-acknowledgement], [name="workersStopped"]')) input.checked = false;
        const acknowledgement = form.querySelector('[data-delete-acknowledgement]');
        if (acknowledgement) form.querySelector('button').disabled = true;
    }
    for (const acknowledgement of document.querySelectorAll('[data-delete-acknowledgement]')) {
        const button = acknowledgement.form.querySelector('button');
        acknowledgement.checked = false;
        button.disabled = true;
        acknowledgement.addEventListener('change', () => { button.disabled = !acknowledgement.checked || acknowledgement.form.dataset.operationBusy === 'true'; });
        acknowledgement.form.addEventListener('formdata', () => clearAcknowledgements(acknowledgement.form));
    }
    window.addEventListener?.('pageshow', () => {
        for (const form of document.querySelectorAll('form')) clearAcknowledgements(form);
    });
    for (const link of document.querySelectorAll('[data-target-counts]')) {
        let active = null;
        link.addEventListener('click', async event => {
            event.preventDefault();
            if (active) { active.abort(); return; }
            const controller = new AbortController();
            active = controller;
            const output = link.closest('[data-managed-fhir-server]').querySelector('[data-target-count-output]');
            output.hidden = false;
            output.textContent = 'Checking exact target counts and history… select again to cancel; 2.92 minutes (175 seconds) server deadline.';
            const timer = setTimeout(() => controller.abort(), 180000);
            try {
                const response = await fetch(link.href, { headers: { Accept: 'application/json' }, signal: controller.signal });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
                renderTargetCounts(output, result);
            } catch (error) {
                output.textContent = `Target state unavailable: ${error.name === 'AbortError' ? 'request cancelled or timed out' : error.message}. No zero count or empty state is inferred.`;
            } finally {
                clearTimeout(timer);
                active = null;
            }
        });
    }

    const simulationForm = document.querySelector('[data-simulation-form]');
    if (simulationForm) {
        const state = simulationForm.querySelector('[data-simulation-state]');
        const preset = simulationForm.elements.namedItem('preset');
        const defaultsNode = simulationForm.querySelector('[data-simulation-defaults]');
        const reset = simulationForm.elements.namedItem('resetDefaults');
        simulationForm.addEventListener('input', () => { state.textContent = 'Unsaved draft. Saved effective values above remain unchanged until Save; runtime adoption is not checked.'; });
        if (defaultsNode) {
            const defaults = JSON.parse(defaultsNode.textContent);
            const saved = JSON.parse(simulationForm.querySelector('[data-simulation-saved]').textContent);
            const preview = simulationForm.querySelector('[data-preset-preview]');
            const changes = simulationForm.querySelector('[data-preset-changes]');
            const use = simulationForm.querySelector('[data-preset-use]');
            const save = simulationForm.querySelector('[data-simulation-save]');
            const consequence = simulationForm.querySelector('[data-preset-consequence]');
            const showPreview = () => {
                changes.replaceChildren();
                const list = document.createElement('ul');
                for (const [name, value] of Object.entries(defaults[preset.value].controls)) {
                    const row = document.createElement('li');
                    row.textContent = `${saved.labels[name]}: saved ${saved.controls[name] ? 'On' : 'Off'} → ${value ? 'On' : 'Off'}`;
                    list.appendChild(row);
                }
                for (const [id, controls] of Object.entries(saved.perSource)) for (const [name, value] of Object.entries(controls)) {
                    const row = document.createElement('li');
                    row.textContent = `${id} · ${saved.labels[name]}: explicit ${value ? 'On' : 'Off'} → Inherit`;
                    list.appendChild(row);
                }
                if (!Object.keys(saved.perSource).length) { const row = document.createElement('li'); row.textContent = 'No saved source overrides to remove.'; list.appendChild(row); }
                changes.appendChild(list); preview.hidden = false;
                const restart = (preset.value === 'strict' ? 'strict' : 'connectathon') !== simulationForm.dataset.savedMode;
                consequence.textContent = restart ? 'Controlled team recreation required before this transition. Save is blocked; no saved settings will change. Use reconfigure-local-team.js with this team and preset.' : 'Defaults replace all six global values and all saved source overrides. Review the preview, then use it to update this draft.';
                use.disabled = restart || preset.value === 'strict';
                use.dataset.helpDisabledKey = restart ? 'admin.simulation-preset' : 'admin.simulation-locked';
                save.dataset.helpDisabledKey = restart ? 'admin.simulation-preset' : preset.value === 'strict' ? 'admin.simulation-locked' : 'admin.simulation-defaults';
                state.textContent = 'Preset preview only. The control draft and saved configuration have not changed.';
                save.disabled = restart || preset.value === 'strict' || preset.value !== simulationForm.dataset.savedPreset;
            };
            preset.addEventListener('change', () => { reset.value = 'false'; showPreview(); });
            simulationForm.querySelector('[data-preset-defaults]').addEventListener('click', showPreview);
            use.addEventListener('click', () => {
                for (const [name, value] of Object.entries(defaults[preset.value].controls)) simulationForm.elements.namedItem(`control.${name}`).checked = value;
                reset.value = 'true'; save.disabled = false; delete save.dataset.helpDisabledKey;
                state.textContent = 'Unsaved preset defaults. Save replaces globals and removes the source overrides shown in the preview. Saved effective values above are unchanged.';
            });
        }
    }
    const tokenDuration = document.querySelector('[data-token-duration-form]');
    tokenDuration?.addEventListener('input', () => { tokenDuration.querySelector('[data-token-duration-state]').textContent = 'Unsaved duration draft. Applies only to future issuance after Save; existing tokens and first-use clocks remain unchanged.'; });

    for (const form of document.querySelectorAll('form[data-confirm]:not([data-async-operation])')) {
        form.addEventListener('submit', event => {
            if (!window.confirm(form.dataset.confirm)) { event.preventDefault(); clearAcknowledgements(form); }
        });
    }
    for (const form of document.querySelectorAll('form[data-progress]:not([data-async-operation])')) {
        form.addEventListener('submit', event => {
            if (event.defaultPrevented) return;
            const output = document.getElementById(form.dataset.progress);
            if (output) {
                output.hidden = false;
                output.dataset.helpKey = 'common.working';
                output.textContent = form.dataset.progressLabel ? `${form.dataset.progressLabel} · Working…` : 'Working…';
            }
            for (const button of form.querySelectorAll('button[type="submit"],button:not([type])')) button.disabled = true;
        });
    }

    /** Poll a saved operation after submission or page reload, retrying transient status failures. */
    async function pollOperation(output, id, reloadOnSuccess = false, initial = null) {
        output.dataset.operationId = id;
        const buttons = [...(output.closest('[data-managed-fhir-server]') || document).querySelectorAll('form[data-async-operation]')]
            .flatMap(form => [...form.querySelectorAll('button[type="submit"],button:not([type])')]);
        let operation = initial;
        let lastConfirmed = initial;
        const finished = refresh.begin();
        try {
            while (output.dataset.operationId === id) {
                try {
                    if (!operation) {
                        const response = await fetch(`${document.body.dataset.browserBase || ''}/admin/api/data-operations/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        operation = await response.json();
                    }
                    lastConfirmed = operation;
                    const terminal = ['succeeded', 'failed'].includes(operation.phase);
                    buttons.forEach(button => {
                        button.form.dataset.operationBusy = terminal ? 'false' : 'true';
                        const acknowledgement = button.form.querySelector('[data-delete-acknowledgement]');
                        if (terminal && acknowledgement) acknowledgement.checked = false;
                        button.disabled = !terminal || Boolean(acknowledgement && !acknowledgement.checked);
                    });
                    renderDataOperation(output, operation);
                    if (terminal) {
                        if (operation.phase === 'failed' || operation.needsReconciliation) refresh.attention();
                        else if (reloadOnSuccess) refresh.success();
                        return;
                    }
                } catch (_) {
                    if (lastConfirmed) renderDataOperation(output, lastConfirmed, true);
                    else { output.hidden = false; output.dataset.helpKey = 'admin.operation-uncertain'; output.textContent = 'Status updates are unavailable. Reconnecting to the saved result; the import may still be running.'; }
                }
                await new Promise(resolve => window.setTimeout(resolve, 750));
                operation = null;
            }
        } finally { finished(); }
    }

    for (const output of document.querySelectorAll('[data-operation-id]')) {
        if (output.dataset.operationId) pollOperation(output, output.dataset.operationId);
    }
    for (const form of document.querySelectorAll('form[data-async-operation]')) {
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (form.dataset.operationBusy === 'true' || !form.reportValidity()) return;
            if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) { clearAcknowledgements(form); return; }
            const submitted = refresh.begin();
            form.dataset.operationBusy = 'true';
            const output = document.getElementById(form.dataset.progress);
            const buttons = [...form.querySelectorAll('button[type="submit"],button:not([type])')];
            buttons.forEach(button => { button.disabled = true; });
            if (output) { output.hidden = false; output.dataset.helpKey = 'common.working'; output.textContent = 'Sending this request. Wait for the server to confirm it was received.'; }
            try {
                const method = form.dataset.method || form.method || 'POST';
                const data = new FormData(form);
                refresh.submitted(form);
                const request = method.toUpperCase() === 'DELETE'
                    ? { method: 'DELETE', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(Object.fromEntries(data.entries())) }
                    : { method, headers: { Accept: 'application/json' }, body: data };
                const accepted = await fetch(form.action, request);
                const operation = await accepted.json();
                if (!accepted.ok) throw Object.assign(new Error(operation.error || `HTTP ${accepted.status}`), { activeOperationId: operation.activeOperationId });
                if (output) await pollOperation(output, operation.id, true, operation);
            } catch (error) {
                refresh.attention();
                if (output) {
                    output.dataset.helpKey = 'admin.operation-uncertain';
                    const message = document.createElement('p');
                    message.textContent = PCM_ADMIN_FEEDBACK.requestFailure(error.message, Boolean(error.activeOperationId));
                    const details = document.createElement('details');
                    const summary = document.createElement('summary'); summary.textContent = 'Technical details'; summary.dataset.helpKey = 'common.details';
                    const raw = document.createElement('pre'); raw.textContent = error.message;
                    details.append(summary, raw);
                    const link = document.createElement('a'); link.textContent = 'Review this server and recovery controls';
                    link.href = `#server-${encodeURIComponent(form.closest('[data-managed-fhir-server]').dataset.managedFhirServer)}`;
                    link.dataset.helpKey = 'admin.operation-uncertain';
                    output.replaceChildren(message, details, link);
                }
                form.dataset.operationBusy = 'false';
                buttons.forEach(button => {
                    const acknowledgement = form.querySelector('[data-delete-acknowledgement]');
                    if (acknowledgement) acknowledgement.checked = false;
                    button.disabled = Boolean(acknowledgement);
                });
            } finally { submitted(); }
        });
    }
});
