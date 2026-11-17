'use strict';
/** Local list browsing and fenced explicit sampling; untrusted facts are always text. */
(() => {
    const form = document.querySelector('#patient-load'); if (!form) return;
    const base = document.body.dataset.browserBase || '', identity = form.elements.identity.value;
    const draftKey = `pcm-doctor-draft:${base}:${identity}`;
    const feedback = document.querySelector('#library-selection-state');
    // Server acceptance must still belong to this source, row and latest UI action on delivery.
    document.addEventListener('submit', async event => {
        if (!event.target.action?.endsWith('/patients/select')) return;
        event.preventDefault();
        const selection = event.target, button = selection.querySelector('button');
        const own = generation, selected = source.value, attempt = ++selectionAttempt, patientId = selection.elements.patientId.value;
        const current = () => generation === own && source.value === selected && selectionAttempt === attempt && selection.isConnected
            && selection.elements.identity.value === identity && selection.elements.patientId.value === patientId;
        button.disabled = true; feedback.textContent = 'Selecting patient…';
        try {
            const response = await fetch(selection.action, { method: 'POST', headers: { accept: 'application/json' }, body: new URLSearchParams(new FormData(selection)) });
            if (!response.ok) throw new Error(await response.text());
            const payload = await response.json();
            if (!current()) return;
            try { const draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null'); if (draft) { draft.selectedPatient = patientId; sessionStorage.setItem(draftKey, JSON.stringify(draft)); } } catch (_) { /* Optional storage. */ }
            window.location.assign(payload.location);
        } catch (error) { if (current()) feedback.textContent = `Patient not selected: ${error.message}`; }
        finally { button.disabled = false; if (selectionAttempt === attempt && !current()) feedback.textContent = ''; }
    });
    const source = document.querySelector('#sample-source'), status = document.querySelector('#sample-state');
    const results = document.querySelector('#sample-results'), load = document.querySelector('#sample-load'), cancel = document.querySelector('#sample-cancel');
    const find = document.querySelector('#library-find'), groups = [...document.querySelectorAll('[data-library-group]')];
    let generation = 0, selectionAttempt = 0, controller, sourceChange = Promise.resolve(), state = form.dataset.state;
    let refreshedAt = form.dataset.refreshedAt, rejected = Number(form.dataset.rejected), failure = form.dataset.error;

    /** Retain one visible query across groups; filter existing DOM without a source request. */
    function filter() {
        const query = find.value.trim().toLocaleLowerCase();
        for (const group of groups) {
            const rows = [...group.querySelectorAll('[data-patient-row]')]; let matches = 0;
            for (const row of rows) {
                const text = [row.querySelector('[data-patient-name]').textContent, row.querySelector('[data-patient-value]').textContent,
                    row.querySelector('[name="patientId"]').value].join(' ').toLocaleLowerCase();
                row.hidden = !text.includes(query); if (!row.hidden) matches++;
                if (row.hidden) row.querySelector('details').open = false;
            }
            document.querySelector(`[data-library-count="${group.dataset.libraryGroup}"]`).textContent = rows.length;
            group.querySelector('[data-library-filter-status]').textContent = `${matches} of ${rows.length} patients${query ? ` matching “${find.value.trim()}”` : ''}`;
            group.querySelector('[data-library-empty]').hidden = matches > 0;
            group.querySelector('table').hidden = matches === 0;
        }
    }
    find.addEventListener('input', filter);
    document.querySelector('#library-clear-filter').addEventListener('click', () => { find.value = ''; filter(); find.focus(); });
    for (const button of document.querySelectorAll('[data-library-view]')) button.addEventListener('click', () => {
        for (const peer of document.querySelectorAll('[data-library-view]')) { peer.setAttribute('aria-selected', String(peer === button)); peer.tabIndex = peer === button ? 0 : -1; }
        for (const group of groups) { group.hidden = group.dataset.libraryGroup !== button.dataset.libraryView; if (group.hidden) for (const details of group.querySelectorAll('details')) details.open = false; }
        filter();
    });

    document.querySelector('.library-views').addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = [...document.querySelectorAll('[data-library-view]')], index = tabs.indexOf(event.target);
        if (index < 0) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].click(); tabs[next].focus();
    });

    /** Describe actual source result and keep cancellation exclusive to a running request. */
    function showState() {
        const loading = state === 'loading'; cancel.hidden = !loading; load.disabled = loading || !source.options.length;
        load.textContent = refreshedAt ? 'Refresh sample' : 'Load sample';
        if (!source.options.length) return; // Server owns the precise Strict/no-source reason.
        const name = source.selectedOptions[0]?.textContent || source.value;
        const count = results.querySelectorAll('[data-patient-row]').length;
        const labels = { unloaded: 'Not loaded', loading: 'Loading', loaded: 'Loaded', partial: 'Partial', empty: 'Empty', failed: 'Failed', cancelled: 'Cancelled' };
        status.textContent = `${labels[state] || state} — ${name} — ${count} candidates${refreshedAt ? ` — refreshed ${refreshedAt}` : ''}${rejected ? ` — ${rejected} invalid, duplicate or untagged rows skipped` : ''}${failure ? ` — ${failure}. Check the selected source and try Load sample again.` : ''}`;
        filter();
    }
    /** Invalidate locally first, then serialize the existing server invalidations before loading. */
    function invalidate(cancelled) {
        feedback.textContent = '';
        generation++; controller?.abort(); results.replaceChildren(); refreshedAt = ''; rejected = 0; failure = ''; state = cancelled ? 'cancelled' : 'unloaded'; showState();
        const selected = source.value, own = generation;
        sourceChange = sourceChange.catch(() => {}).then(async () => {
            const response = await fetch(`${base}/patients/source`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity, sourceId: selected, cancelled }) });
            if (!response.ok) throw new Error('Source change was not saved. Refresh the library before selecting a sample.');
        });
        sourceChange.catch(error => { if (generation === own) { state = 'failed'; failure = error.message; showState(); } });
    }
    source.addEventListener('change', () => invalidate(false));
    cancel.addEventListener('click', () => invalidate(true));

    /** Build the same labelled semantic row as the initial server-rendered sample. */
    function row(patient, sampleGeneration) {
        const tr = document.createElement('tr'); tr.dataset.patientRow = '';
        for (const [label, value, key] of [['Name', patient.display || 'Name unknown', 'patientName'], ['Date of birth', patient.birthDate || 'Not provided', ''], ['Identifier', patient.idValue, 'patientValue']]) {
            const cell = document.createElement('td'); cell.dataset.label = label; cell.textContent = value; if (key) cell.dataset[key] = ''; tr.append(cell);
        }
        const actions = document.createElement('td'); actions.dataset.label = 'Actions';
        const selection = document.createElement('form'); selection.method = 'POST'; selection.action = `${base}/patients/select`;
        for (const [name, value] of Object.entries({ identity, patientId: `${patient.idSystem}|${patient.idValue}`, sampleGeneration })) { const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; selection.append(input); }
        const use = document.createElement('button'); use.className = 'btn btn-outline-primary'; use.dataset.helpKey = 'doctor.patient-picker'; use.dataset.helpProxy = ''; use.textContent = 'Use patient'; selection.append(use); actions.append(selection);
        const details = document.createElement('details'); details.dataset.identifierDetails = '';
        const summary = document.createElement('summary'); summary.dataset.helpKey = 'demo.patient-details'; summary.textContent = 'Patient details'; details.append(summary);
        const facts = document.createElement('dl');
        for (const [label, value] of [['Name', patient.display || 'Name unknown'], ['Date of birth', patient.birthDate || 'Not provided'], ['Source', source.selectedOptions[0]?.textContent || source.value], ['Identifier type', patient.identifierType], ['Review', patient.review], ['System URI', patient.idSystem], ['Full identifier', `${patient.idSystem}|${patient.idValue}`]]) {
            const term = document.createElement('dt'), definition = document.createElement('dd'), code = document.createElement('code'); term.textContent = label;
            if (['System URI', 'Full identifier'].includes(label)) { code.textContent = value; definition.append(code); }
            else definition.textContent = value;
            facts.append(term, definition);
        }
        details.append(facts); actions.append(details); tr.append(actions); return tr;
    }
    form.addEventListener('submit', async event => {
        event.preventDefault(); if (!source.options.length || state === 'loading') return;
        feedback.textContent = '';
        controller?.abort(); controller = new AbortController(); const ownController = controller, own = ++generation, selected = source.value;
        results.replaceChildren(); refreshedAt = ''; rejected = 0; failure = ''; state = 'loading'; showState();
        try {
            await sourceChange;
            if (generation !== own) return;
            const response = await fetch(`${base}/patients/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity, sourceId: selected }), signal: ownController.signal });
            const payload = await response.json(); if (generation !== own || source.value !== selected) return;
            if (!response.ok) throw new Error(payload.error || 'Sample unavailable');
            state = payload.state; refreshedAt = payload.refreshedAt; rejected = payload.rejected;
            results.replaceChildren(...payload.patients.map(patient => row(patient, payload.generation))); showState();
        } catch (error) { if (generation === own) { state = error.name === 'AbortError' ? 'cancelled' : 'failed'; failure = error.name === 'AbortError' ? '' : error.message; showState(); } }
    });
    // A restored history document may carry obsolete row generations. Reload the server projection.
    window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });
    filter(); showState();
})();
