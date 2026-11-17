'use strict';

/** Reflect the exact submitted address without inventing a discovered source.
 * @param {HTMLSelectElement} picker This Consent card's named source control.
 * @param {HTMLInputElement} target Its existing exact audience/target input.
 * @returns {void}
 */
function reconcileSourceChoice(picker, target) {
    for (const option of [...picker.options]) if (option.dataset.customSourceTarget !== undefined) option.remove();
    if (![...picker.options].some(option => option.value === target.value)) {
        const option = picker.ownerDocument.createElement('option');
        option.value = target.value;
        option.textContent = 'Advanced target (not a discovered source)';
        option.dataset.customSourceTarget = 'true';
        picker.append(option);
    }
    picker.value = target.value;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { reconcileSourceChoice };

/** Fence visible results immediately, and serialize selection updates before form submission. */
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
    const request = document.querySelector('form[action$="/create-consent"]');
    if (!request) return;
    let pending = Promise.resolve(), generation = 0, patientError = '', retainDraft = true;
    const value = request.elements.patientId, system = request.elements.patientSystem;
    const systemPicker = document.querySelector('#patient-system'), systemPanel = document.querySelector('[data-manual-system]');
    const systemFeedback = document.querySelector('#patient-system-feedback'), resolved = document.querySelector('#patient-resolved');
    let manualSystem = systemPicker.value === '__manual__', rejectedField = value;
    /** Keep the presentation aligned to the exact pair; full-token parsing follows the shared server parser. */
    const reconcilePatient = () => {
        if (value.value.includes('|')) {
            const split = value.value.indexOf('|');
            system.value = value.value.slice(0, split).trim() || system.value.trim();
            value.value = value.value.slice(split + 1).trim();
        }
        const known = [...systemPicker.options].some(option => option.value === system.value && option.value !== '__manual__');
        if (!known) manualSystem = true;
        systemPicker.value = manualSystem ? '__manual__' : system.value;
        systemPanel.hidden = !manualSystem;
        system.required = manualSystem;
        resolved.textContent = `Resolved identifier: ${system.value.trim()}|${value.value.trim()}`;
    };
    const clearPatientError = () => {
        patientError = ''; systemFeedback.textContent = '';
        for (const field of [system, value]) { field.setCustomValidity(''); field.setAttribute('aria-invalid', 'false'); }
    };
    const choice = document.querySelector('#configured-patient'), feedback = document.querySelector('#patient-feedback'), name = document.querySelector('#patient-name');
    const draftKey = `pcm-doctor-draft:${document.body.dataset.browserBase || ''}:${request.identity.value}`;
    const mode = selected => {
        document.querySelectorAll('[data-patient-mode]').forEach(button => {
            const active = button.dataset.patientMode === selected;
            button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
        });
        document.querySelector('[data-patient-choices]').hidden = selected !== 'choose';
        document.querySelector('[data-patient-manual]').hidden = selected !== 'manual';
    };
    const token = () => value.value.includes('|') ? value.value.trim() : `${system.value}|${value.value.trim()}`;
    const identify = () => {
        const option = [...choice.options].find(option => option.value === token());
        choice.value = option?.value || '';
        name.textContent = !value.value.trim() ? 'No patient selected.' : option?.dataset.patientName || 'Name unknown for this identifier.';
    };
    const draftFields = () => [...document.querySelectorAll('[data-request-suggestion], #manual-testing input:not([type="hidden"]), input[name="endpointUrl"], input[name="requestedScope"], input[name="consentId"], input[name="fhirGetRequest"]')];
    const saveDraft = () => {
        if (!retainDraft) return;
        try { sessionStorage.setItem(draftKey, JSON.stringify({ patientId: value.value, patientSystem: system.value, serviceId: request.serviceId.value,
            manualSystem, mode: document.querySelector('[data-patient-mode][aria-selected="true"]')?.dataset.patientMode,
            sourceMemberships: Object.fromEntries([...document.querySelectorAll('[data-consent-card]')].filter(card => card.dataset.sourceMembership)
                .map(card => [card.dataset.consentCard, card.dataset.sourceMembership])),
            fields: Object.fromEntries(draftFields().filter(input => input.id).map(input => [input.id, input.value])) })); } catch (_) { /* Optional tab-local convenience. */ }
    };
    /** Compare submitted context, excluding presentation-only patient mode and disabled fields. */
    const draftContext = () => JSON.stringify([token(), request.serviceId.value,
        draftFields().filter(input => input.id && !input.disabled).map(input => [input.id, input.value])]);
    const renderedDraftContext = draftContext();
    // Non-secret drafts stay within this tab, mount and application; creation/reset clear them.
    let restored = false;
    try {
        const draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
        if (draft) {
            value.value = draft.selectedPatient || draft.patientId;
            system.value = draft.patientSystem; manualSystem = Boolean(draft.manualSystem);
            if ([...request.serviceId.options].some(option => option.value === draft.serviceId && !option.disabled)) request.serviceId.value = draft.serviceId;
            for (const input of draftFields()) if (Object.hasOwn(draft.fields || {}, input.id) && !input.disabled) {
                const card = input.closest?.('[data-consent-card]');
                const currentSources = card?.dataset.sourceMembership;
                const previousSources = draft.sourceMemberships?.[card?.dataset.consentCard];
                // Public source changes invalidate the old target draft, including legacy zero-source returns.
                // This is a restoration hint only; PCM still decides every token's current authority.
                if (input.name === 'endpointUrl' && currentSources && ((typeof previousSources === 'string' && previousSources && previousSources !== currentSources)
                    || currentSources === '[]' && !input.value && !previousSources)) continue;
                // A successful fetch can resolve an initially empty source on the server.
                // Keep that card's returned source/results; later deliberate edits still invalidate normally.
                const resolvedSource = input.name === 'endpointUrl' && draft.fields[input.id] === '' && input.value
                    && input.closest?.('[data-consent-card]')?.querySelector('[aria-label="Fetched FHIR data"]');
                if (!resolvedSource) input.value = draft.fields[input.id];
            }
            mode(draft.selectedPatient ? 'choose' : draft.mode || 'manual');
            if (draft.selectedPatient) { manualSystem = false; delete draft.selectedPatient; sessionStorage.setItem(draftKey, JSON.stringify(draft)); }
            restored = true;
        }
    } catch (_) { /* Storage denial or invalid data cannot block ordinary forms. */ }
    reconcilePatient(); identify();
    if (!restored) mode(choice.value || !value.value.trim() ? 'choose' : 'manual');
    document.querySelectorAll('[data-patient-mode]').forEach(button => button.addEventListener('click', () => { mode(button.dataset.patientMode); saveDraft(); }));
    document.querySelector('.patient-modes').addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = [...document.querySelectorAll('[data-patient-mode]')], index = tabs.indexOf(event.target);
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].click(); tabs[next].focus();
    });
    // Native validation runs before submit. Reveal the editable identifier first
    // so an empty choice can receive focus instead of blocking an invisible field.
    for (const field of [value, system]) field.addEventListener('invalid', () => mode('manual'));
    window.addEventListener('pagehide', saveDraft);
    document.querySelector('form[action$="/reset"]')?.addEventListener('submit', event => {
        if (!event.defaultPrevented) { retainDraft = false; window.removeEventListener('pagehide', saveDraft); }
    });
    document.querySelector('[data-patient-library]')?.addEventListener('click', saveDraft);
    document.querySelector('[data-help-key="doctor.services-manage"]')?.addEventListener('click', saveDraft);
    document.querySelectorAll('#refresh-services, #next-services').forEach(form => form.addEventListener('submit', saveDraft));
    const clear = consentId => {
        const roots = consentId ? [...document.querySelectorAll('[data-consent-card]')].filter(node => node.dataset.consentCard === consentId) : [document];
        for (const root of roots) {
            root.querySelectorAll('[aria-label="Fetched FHIR data"]').forEach(node => node.remove());
            root.querySelectorAll('[data-token-details]').forEach(node => { node.textContent = 'Granted permissions not yet obtained for the changed context.'; });
            root.querySelectorAll('[data-token-status]').forEach(node => { node.textContent = 'Token status not checked for the changed context.'; });
        }
    };
    const notify = consentId => {
        clear(typeof consentId === 'string' ? consentId : undefined);
        try { localStorage.setItem('pcm-doctor-selection', JSON.stringify({ identity: request.identity.value, revision: Date.now() })); } catch (_) { /* Storage is optional. */ }
    };
    const update = body => {
        const own = ++generation;
        notify(body.sourceConsentId);
        pending = pending.catch(() => {}).then(async () => {
            const response = await fetch(`${document.body.dataset.browserBase || ''}/selection`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!response.ok) throw new Error('Selection could not be saved. Refresh and retry.');
            const payload = await response.json();
            if (body.sourceConsentId && body.requestedScope !== undefined) {
                const form = [...document.forms].find(form => form.elements.consentId?.value === body.sourceConsentId);
                const summary = form?.closest('[data-consent-card]')?.querySelector('[data-query-summary]');
                if (summary && own === generation) {
                    summary.textContent = payload.queryError || `${payload.queryPlan?.searches?.length || 0} searchable types`;
                }
            }
            if (own === generation && !body.sourceConsentId && !body.identityExit) {
                patientError = payload.patientError || '';
                rejectedField = payload.patientField === 'system' ? system : value;
                for (const field of [value, system]) { field.setCustomValidity(field === rejectedField ? patientError : ''); field.setAttribute('aria-invalid', String(Boolean(patientError) && field === rejectedField)); }
                systemFeedback.textContent = payload.patientField === 'system' ? patientError : '';
                feedback.textContent = (patientError && payload.patientField === 'system' ? 'Correct the System URI before creating a request.' : patientError) || (payload.patient?.automaticTestApproval
                    ? 'This exact standard synthetic test identifier receives automatic test approval without a patient decision.'
                    : 'Ordinary identifiers require explicit Consent review. Selection does not prove source records or authenticate the patient.');
                if (payload.patient) { system.value = payload.patient.system; value.value = payload.patient.value; }
                reconcilePatient(); identify(); saveDraft();
            }
        });
    };
    document.querySelector('#doctor-identity')?.addEventListener('change', async event => {
        const form = event.target.form;
        update({ identity: request.identity.value, identityExit: true });
        try { await pending; form.requestSubmit(); }
        catch (error) { window.alert(error.message); }
    });
    const picker = request.elements.serviceId;
    const updateReadiness = () => {
        const option = picker?.selectedOptions?.[0];
        const submit = request.querySelector('[data-request-consent]');
        if (request.elements.serviceStamp) request.elements.serviceStamp.value = option?.dataset.serviceStamp || '';
        if (submit) submit.disabled = !option?.value || option.disabled;
    };
    /** Replace one public summary in place; changing service closes its secondary facts. */
    const showPermissions = () => {
        const panel = document.querySelector('[data-selected-service-summary]');
        if (!panel) return;
        const option = picker?.selectedOptions?.[0];
        let facts = {};
        try { facts = JSON.parse(option?.dataset.serviceSummary || '{}'); } catch (_) { /* Unknown facts remain explicit. */ }
        panel.hidden = !option?.value || !facts.name;
        panel.querySelectorAll('[data-service-fact]').forEach(node => { node.textContent = facts[node.dataset.serviceFact] || 'Not provided by PCM'; });
        const details = panel.querySelector('[data-service-details]');
        if (details) details.open = false;
        const status = document.querySelector('#service-selection-status');
        if (status) status.textContent = option?.value ? (option.disabled ? option.textContent : facts.readiness || 'Review the selected service before creating a request.') : 'Choose a connected service and review its details.';
    };
    picker?.addEventListener('change', showPermissions);
    showPermissions();
    picker?.addEventListener('change', updateReadiness);
    updateReadiness();
    document.querySelectorAll('[data-service-refresh]').forEach(button => button.addEventListener('click', notify));
    document.querySelectorAll('#refresh-services, #next-services').forEach(form => form.addEventListener('submit', () => {
        const status = document.querySelector('#service-list-status');
        if (status) status.textContent = 'Loading services — checking current registrations. Existing assignments are not presumed removed.';
        const submit = request.querySelector('[data-request-consent]');
        if (submit) submit.disabled = true;
        if (picker) picker.disabled = true;
        form.setAttribute('aria-busy', 'true');
    }));
    const selection = () => update({ identity: request.identity.value, patientId: value.value, patientSystem: system.value, serviceId: request.serviceId.value });
    const edit = () => { clearPatientError(); reconcilePatient(); choice.value = ''; name.textContent = value.value.trim() ? 'Name unknown for this identifier.' : 'No patient selected.'; saveDraft(); selection(); };
    value.addEventListener('input', edit); system.addEventListener('input', edit);
    systemPicker.addEventListener('change', () => {
        manualSystem = systemPicker.value === '__manual__';
        if (!manualSystem) system.value = systemPicker.value;
        edit();
        if (manualSystem) system.focus();
    });
    request.serviceId?.addEventListener('input', selection);
    choice.addEventListener('change', () => {
        if (!choice.value) { value.value = ''; name.textContent = 'No patient selected.'; mode('manual'); clearPatientError(); reconcilePatient(); saveDraft(); selection(); return; }
        const split = choice.value.indexOf('|'); system.value = choice.value.slice(0, split); value.value = choice.value.slice(split + 1);
        manualSystem = false; clearPatientError(); reconcilePatient(); identify(); saveDraft(); selection();
    });
    // An identical return-page draft must not erase freshly fetched data or token facts.
    if (restored && draftContext() !== renderedDraftContext) selection();
    document.querySelectorAll('[data-source-choice]').forEach(picker => {
        // Draft restoration and server renders both use the exact submitted field.
        reconcileSourceChoice(picker, picker.form.endpointUrl);
        picker.addEventListener('change', () => {
            picker.form.endpointUrl.value = picker.value; picker.form.endpointUrl.dispatchEvent(new Event('input', { bubbles: true }));
        });
    });
    document.querySelectorAll('input[name="endpointUrl"], input[name="requestedScope"], input[name="consentId"], input[name="fhirGetRequest"]').forEach(input => input.addEventListener('input', () => {
        if (input.name === 'endpointUrl') {
            const picker = input.form.querySelector('[data-source-choice]');
            if (picker) reconcileSourceChoice(picker, input);
        }
        update({ identity: request.identity.value, sourceConsentId: input.form.dataset.sourceConsentId || input.form.consentId.value, ...(input.name === 'endpointUrl' ? { endpointUrl: input.value } : {}), ...(input.name === 'requestedScope' ? { requestedScope: input.value } : {}), ...(input.name === 'fhirGetRequest' ? { fhirGetRequest: input.value } : {}) });
    }));
    document.querySelectorAll('[data-endpoint]').forEach(button => button.addEventListener('click', () => {
        const input = button.form.endpointUrl;
        input.value = button.dataset.endpoint;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }));
    const busyRequests = new Map();
    /** Rotate a real indicator independently of CSS animations during native submission.
     * @param {HTMLButtonElement} button Button whose request is pending.
     * @returns {Function} Cancel the animation and remove its presentation-only indicator.
     */
    function startRequestSpinner(button) {
        const spinner = document.createElement('span');
        spinner.className = 'doctor-request-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        button.prepend(spinner);
        const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const startedAt = performance.now();
        let frame;
        const rotate = timestamp => {
            // Reduced motion slows the requested busy indication instead of freezing it.
            const duration = motion.matches ? 2400 : 800;
            spinner.style.transform = `rotate(${((timestamp - startedAt) / duration * 360) % 360}deg)`;
            frame = window.requestAnimationFrame(rotate);
        };
        frame = window.requestAnimationFrame(rotate);
        return () => { window.cancelAnimationFrame(frame); spinner.remove(); };
    }
    /** Show local request feedback and return a cleanup callback for failed/restored submissions.
     * @param {HTMLFormElement} form Existing form whose submission is being prepared.
     * @param {HTMLButtonElement|null} submitter Original button, including its native formaction.
     * @returns {Function} Restore the original labels and accessibility attributes.
     */
    function showRequestBusy(form, submitter) {
        const label = submitter?.querySelector('[data-request-label]');
        if (!submitter?.dataset.doctorRequest || !label) return () => {};
        const originalLabel = label.textContent;
        const controls = [...form.querySelectorAll('[data-doctor-request]')];
        form.setAttribute('aria-busy', 'true');
        submitter.setAttribute('aria-busy', 'true');
        label.textContent = submitter.dataset.doctorRequest;
        const stopSpinner = startRequestSpinner(submitter);
        // Keep native controls enabled so requestSubmit retains the exact action and fields.
        controls.forEach(button => button.setAttribute('aria-disabled', 'true'));
        const restore = () => {
            stopSpinner();
            label.textContent = originalLabel;
            submitter.removeAttribute('aria-busy');
            form.removeAttribute('aria-busy');
            controls.forEach(button => button.removeAttribute('aria-disabled'));
            busyRequests.delete(form);
        };
        busyRequests.set(form, restore);
        return restore;
    }
    // Validation can fail again after an asynchronous selection save.
    document.addEventListener('invalid', event => busyRequests.get(event.target.form)?.(), true);
    document.querySelectorAll('form[method="POST"]').forEach(form => form.addEventListener('submit', async event => {
        if (form !== request && !form.querySelector('button[formaction$="/fetch-data"]')) return;
        if (event.defaultPrevented || form.dataset.selectionReady) return;
        event.preventDefault();
        if (busyRequests.has(form)) return;
        const submitter = event.submitter;
        const restoreBusy = showRequestBusy(form, submitter);
        try {
            let saving;
            do { saving = pending; await saving; } while (saving !== pending);
            if (form === request && patientError) { mode('manual'); rejectedField.focus(); rejectedField.reportValidity(); return; }
            // A resolved promise can resume while the browser still dispatches submit.
            // Defer to a new task so native reentrancy protection cannot swallow submission.
            window.setTimeout(() => {
                // An edit in the task gap must await its own save, never submit the previous pair.
                if (saving !== pending) { restoreBusy(); form.requestSubmit(submitter); return; }
                if (form === request) {
                    if (patientError) { mode('manual'); rejectedField.focus(); rejectedField.reportValidity(); return; }
                    retainDraft = false;
                    try { sessionStorage.removeItem(draftKey); } catch (_) { /* Optional storage. */ }
                    window.removeEventListener('pagehide', saveDraft);
                }
                form.dataset.selectionReady = 'true';
                try { form.requestSubmit(submitter); }
                catch (error) { restoreBusy(); window.alert(error.message); }
                finally { delete form.dataset.selectionReady; }
            }, 0);
        }
        catch (error) { restoreBusy(); window.alert(error.message); }
    }));
    window.addEventListener('pagehide', () => { for (const restore of busyRequests.values()) restore(); });
    window.addEventListener('pageshow', () => { for (const restore of busyRequests.values()) restore(); });
    window.addEventListener('storage', event => { if (event.key === 'pcm-doctor-selection') clear(); });
    window.addEventListener('pageshow', event => { if (event.persisted) { retainDraft = false; clear(); location.reload(); } });
});
