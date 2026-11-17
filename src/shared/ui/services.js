'use strict';
/** Basic service forms use server-held credentials; explanations never trigger requests. */
(() => {
    const create = document.querySelector('[data-service-create]');
    if (!create) return;
    const panel = document.querySelector('[data-service-panel]');
    const load = document.querySelector('[data-service-load]');
    const loading = document.querySelector('[data-services-loading]');
    const boundForms = new WeakSet();
    let dirty = false, loadingData = false, submitting = false;
    let releaseCreate = () => {};
    let loadSequence = 0, activeLoad;
    let previewSequence = 0, previewTimer, previewAbort, previewProof, previewDraftKey;
    let scopeOrigin = 'generated', templateKey, templateOrder = [], manualTemplate;
    const draftLabel = document.querySelector('[data-template-draft]');
    const markDraft = () => { if (draftLabel) draftLabel.textContent = `${templateKey ? 'Template' : 'Blank'} starting point${dirty ? ' — modified draft' : ''}. Review before Create service.`; };
    const edited = () => { dirty = true; markDraft(); validateDraft(); };
    let filters = { name: '', state: '', provider: '', providerLabel: '' };
    /** Filter only the loaded page; hidden rows never imply a server-wide result count. */
    function filterRows() {
        for (const view of document.querySelectorAll('[data-services-fragment="list"]')) {
            const rows = [...view.querySelectorAll('[data-service-group]')];
            let shown = 0, pairs = 0, visiblePairs = 0;
            for (const row of rows) {
                row.hidden = !row.dataset.serviceName.toLocaleLowerCase().includes(filters.name.toLocaleLowerCase()) || Boolean(filters.state && row.dataset.serviceState !== filters.state);
                const providerRows = [...row.querySelectorAll('[data-provider-pair]')];
                for (const pair of providerRows) pair.hidden = Boolean(filters.provider && pair.dataset.providerPair !== filters.provider);
                const matches = providerRows.filter(pair => !pair.hidden).length;
                pairs += providerRows.length;
                if (!row.hidden) { shown++; visiblePairs += matches; }
                const noProvider = row.querySelector('[data-provider-no-match]');
                if (noProvider) noProvider.hidden = !filters.provider || matches > 0;
            }
            if (!view.querySelector('[data-service-count]')) continue;
            view.querySelector('[data-service-count]').textContent = `${shown} of ${rows.length} loaded service groups; ${visiblePairs} of ${pairs} loaded assignment rows. Unloaded providers and services are not searched.`;
            view.querySelector('[data-service-no-match]').hidden = !rows.length || (filters.provider ? visiblePairs > 0 : shown > 0);
        }
    }
    document.addEventListener('input', event => {
        if (event.target.matches('[data-service-filter]')) { filters.name = event.target.value; filterRows(); }
    });
    document.addEventListener('change', event => {
        if (event.target.matches('[data-provider-filter]')) { filters.provider = event.target.value; filters.providerLabel = event.target.selectedOptions[0]?.textContent || ''; filterRows(); }
        if (event.target.matches('[data-service-status]')) { filters.state = event.target.value; filterRows(); }
    });
    create.addEventListener('input', edited);
    create.addEventListener('change', edited);
    /** Keep the live draft in memory while the dedicated creation view is closed. */
    function showAuthoring(show) {
        panel.hidden = !show;
        document.querySelector('[data-service-browse]').hidden = show;
        (show ? document.querySelector('#service-create-heading') : document.querySelector('[data-service-new]')).focus();
    }
    document.querySelector('[data-service-new]').addEventListener('click', () => {
        if (!submitting && !loadingData) showAuthoring(true);
    });
    document.querySelector('[data-service-cancel]').addEventListener('click', () => {
        if (submitting) return;
        showAuthoring(false);
    });
    /** Replace a draft only after the ordinary dirty-draft confirmation. */
    function startingPoint(button) {
        if (submitting || loadingData) return;
        if (dirty && !window.confirm('Replace this draft with the selected starting point? Unsaved edits will be discarded.')) return;
        let value;
        try { value = button.hasAttribute('data-service-blank') ? null : JSON.parse(button.dataset.templateValues); } catch { return; }
        invalidatePreview(); create.reset(); remembered.clear();
        // Every new starting point uses the same defaults; later user choices remain editable.
        create.elements.allowChanges.checked = false;
        create.elements.includeMasterData.checked = true;
        templateOrder = value?.permissions.map(item => item.type) || [];
        templateKey = value ? button.dataset.templateKey : undefined;
        typeHost.replaceChildren();
        if (value) {
            for (const key of ['name', 'purpose', 'category', 'accessMode', 'duration', 'durationUnit']) create.elements[key].value = value[key];
            create.elements.allowRestricted.checked = value.confidentialityPolicy?.allowRestricted === true;
            for (const category of categories) {
                const bucket = value.buckets.find(item => item.code === category.dataset.serviceBucket);
                category.querySelector('[name="enabled"]').checked = Boolean(bucket);
                if (bucket) {
                    category.querySelector('[name="history"]').value = bucket.history;
                    category.querySelector('[name="historyUnit"]').value = bucket.historyUnit;
                }
                for (const tag of category.querySelectorAll('[name="sensitivity"]')) tag.checked = Boolean(bucket?.sensitivity.includes(tag.value));
            }
            create.elements.exampleQueries.value = JSON.stringify(value.exampleQueries, null, 2);
        }
        scopeOrigin = value?.scopeOrigin || 'generated';
        create.elements.approvalScope.value = value?.approvalScope || '';
        manualTemplate = scopeOrigin === 'custom' ? { key: templateKey, scope: value.approvalScope } : undefined;
        closeScopeReview();
        generatorSettings.open = scopeOrigin !== 'custom';
        dirty = Boolean(value);
        for (const choice of create.querySelectorAll('[data-service-template-pick],[data-service-blank]')) choice.setAttribute('aria-pressed', String(choice === button));
        create.querySelector('[data-template-summary]').textContent = value ? button.dataset.templateDescription : 'Blank — enter service details and data access below. Selecting a starting point creates nothing.';
        updateTypes(); validateDraft(); markDraft();
        create.elements.name.focus();
    }
    document.addEventListener('click', event => {
        const button = event.target.closest('[data-service-template-pick],[data-service-blank]');
        if (button && !event.defaultPrevented) startingPoint(button);
    });
    /** Refresh the protected catalog or grouped assignment view without replacing the live draft. */
    async function refresh(destination, fromHistory = false) {
        if (submitting) return;
        const url = new URL(destination, location.href);
        const doctorRole = new URL(location.href).searchParams.get('providerRole');
        if (!fromHistory && doctorRole && !url.searchParams.has('providerRole')) url.searchParams.set('providerRole', doctorRole);
        const sequence = ++loadSequence;
        activeLoad?.abort();
        activeLoad = new AbortController();
        const expanded = [...document.querySelectorAll('[data-service-expansion][open]')].map(node => [node.dataset.serviceExpansion, node.dataset.version]);
        const focused = document.activeElement;
        const focusInResults = Boolean(focused?.closest('[data-services-fragment="list"]'));
        loadingData = true; loading.hidden = false; loading.textContent = 'Loading Services…';
        try {
            const response = await fetch(url.href, { headers: { Accept: 'text/html' }, signal: activeLoad.signal });
            if (!response.ok) throw new Error('load failed');
            const page = new DOMParser().parseFromString(await response.text(), 'text/html');
            if (sequence !== loadSequence) return;
            const fresh = page.querySelector('[data-service-create]');
            if (!fresh || page.querySelector('[data-services-fragment="catalog"] [role="alert"]') || (url.searchParams.get('view') === 'assignments' && page.querySelector('[data-services-fragment="list"] [role="alert"]'))) throw new Error('inventory unavailable');
            // Validate all fragments before altering the current view or ownership binding.
            const fragments = [...document.querySelectorAll('[data-services-fragment]')].map(node => [node, page.querySelector(`[data-services-fragment="${node.dataset.servicesFragment}"]`)]);
            if (fragments.some(([, node]) => !node)) throw new Error('incomplete page');
            for (const [current, replacement] of fragments) {
                current.replaceWith(replacement);
            }
            create.dataset.csrf = fresh.dataset.csrf;
            create.dataset.providerRole = fresh.dataset.providerRole;
            create.dataset.catalogCsrf = fresh.dataset.catalogCsrf;
            create.dataset.revision = fresh.dataset.revision;
            create.dataset.previewCsrf = fresh.dataset.previewCsrf;
            if (!fromHistory && url.href !== location.href) history.pushState(null, '', url.href);
            for (const node of document.querySelectorAll('[data-service-expansion]')) node.open = expanded.some(([id, version]) => id === node.dataset.serviceExpansion && version === node.dataset.version);
            const target = url.searchParams.get('target');
            if (target && url.searchParams.get('view') !== 'assignments') { const details = [...document.querySelectorAll('[data-service-expansion]')].find(node => node.dataset.serviceExpansion === target); if (details) details.open = true; }
            if (document.querySelector('[data-service-filter]')) document.querySelector('[data-service-filter]').value = filters.name;
            if (document.querySelector('[data-service-status]')) document.querySelector('[data-service-status]').value = filters.state;
            const providerFilter = document.querySelector('[data-provider-filter]');
            if (providerFilter) {
                if (filters.provider && ![...providerFilter.options].some(option => option.value === filters.provider)) {
                    const option = document.createElement('option'); option.value = filters.provider;
                    option.textContent = `${filters.providerLabel || filters.provider} (not on loaded pages)`; providerFilter.append(option);
                }
                providerFilter.value = filters.provider;
            }
            filterRows();
            bindForms();
            if (focusInResults || focused?.closest('[data-services-fragment="catalog"],[data-services-fragment="views"]')) document.querySelector(url.searchParams.get('view') === 'assignments' ? '#services-view-heading' : '#catalog-heading').focus();
            releaseCreate();
            loading.hidden = true;
            return true;
        } catch {
            if (sequence !== loadSequence) return;
            loading.textContent = 'Stale results — Services could not be refreshed. Your draft, view and displayed records are unchanged. Inspect current state with a successful Refresh before another mutation. Retry Refresh after resolving the issue.';
        } finally { if (sequence === loadSequence) loadingData = false; }
    }
    load.addEventListener('submit', event => {
        event.preventDefault();
        const destination = new URL(location.href); destination.searchParams.delete('offset'); destination.searchParams.delete('revision'); for (const key of ['group', 'providerOffset', 'providerRevision']) destination.searchParams.delete(key); refresh(destination.href);
    });
    document.addEventListener('click', async event => {
        const link = event.target.closest('a');
        if (!link || !link.hasAttribute('href') || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const url = new URL(link.href, location.href);
        if (url.origin === location.origin && url.pathname === load.getAttribute('action')) {
            event.preventDefault();
            if (link.hasAttribute('data-service-connect-next')) {
                showAuthoring(false); await refresh(url.href);
                document.querySelector(url.searchParams.get('view') === 'assignments' ? '#services-view-heading' : '#catalog-heading').focus();
            } else refresh(url.href);
        }
    });
    window.addEventListener('popstate', () => refresh(location.href, true));
    /** Associate invalid fields with nearby feedback and let native validity identify the first error. */
    create.addEventListener('invalid', event => {
        event.target.setAttribute('aria-invalid', 'true');
        event.target.setAttribute('aria-describedby', 'service-create-result');
        create.querySelector('[data-service-result]').textContent = event.target.validationMessage;
        showAuthoring(true);
        for (let node = event.target.parentElement; node && node !== create; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
    }, true);
    create.addEventListener('input', event => { event.target.removeAttribute('aria-invalid'); });
    const categories = [...create.querySelectorAll('[data-service-bucket]')];
    const typeHost = create.querySelector('[data-permission-types]');
    const remembered = new Map();
    const generator = create.querySelector('[data-service-generator]');
    const generatorSettings = create.querySelector('[data-generator-settings]');
    const scopeReview = create.querySelector('[data-scope-replacement]');
    const masterTypes = ['Organization', 'Practitioner', 'PractitionerRole', 'Location'];
    /** Describe the maintained Basic manual template only while its exact text is unchanged. */
    function basicManualFacts() {
        if (manualTemplate?.key !== 'basic-patient-data' || create.elements.approvalScope.value !== manualTemplate.scope) return null;
        const knownScope = ['Patient', 'Observation', 'Condition'].map(type => `patient/${type}.rs?_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V`).join(' ');
        if (manualTemplate.scope !== knownScope) return null;
        return {
            'Clinical resources': 'Patient, Observation, Condition — read/search',
            'Data categories': 'No category filters',
            'Record history': 'No date limits',
            'Sensitive categories': 'No sensitivity filters',
            'Master data': 'Not included in the manual scope',
            'Confidentiality': 'Restricted (R) allowed; Very Restricted (V) excluded'
        };
    }
    /** Describe generator inputs for review, without interpreting or compiling manual text. */
    function generatorFacts(data = definition()) {
        const label = bucket => categories.find(row => row.dataset.serviceBucket === bucket.code).querySelector('legend').textContent.trim();
        return {
            'Clinical resources': data.permissions.map(item => `${item.type} — ${item.actions === 'rs' ? 'read/search' : item.actions === 'r' ? 'individual read' : 'search'}`).join('; '),
            'Data categories': data.buckets.map(label).join('; ') || 'No categories selected',
            'Record history': data.buckets.map(bucket => `${label(bucket)}: ${bucket.history} ${historyUnitLabel(bucket)}${Number(bucket.history) === 0 ? ' (cutoff at creation)' : ''}`).join('; ') || 'No clinical categories selected',
            'Sensitive categories': data.buckets.map(bucket => `${label(bucket)}: ${bucket.sensitivity.length ? 'allow ' + bucket.sensitivity.map(tag => tag.split('|').pop()).join(', ') + '; exclude other listed categories' : 'all listed sensitive categories excluded'}`).join('; ') || 'No clinical categories selected',
            'Master data': data.includeMasterData ? `${masterTypes.join(', ')} — individual read only` : 'Not included',
            'Confidentiality': data.confidentialityPolicy.allowRestricted ? 'Restricted (R) allowed; Very Restricted (V) excluded' : 'Restricted (R) and Very Restricted (V) excluded'
        };
    }
    /** Read the displayed history unit from the existing bucket control. */
    function historyUnitLabel(bucket) {
        return categories.find(row => row.dataset.serviceBucket === bucket.code).querySelector('[name="historyUnit"]').selectedOptions[0].textContent;
    }
    /** Make scope ownership explicit while retaining inactive generator metadata. */
    function renderScopeMode() {
        const manual = scopeOrigin === 'custom';
        const basicFacts = manual ? basicManualFacts() : null;
        create.querySelector('[data-scope-mode]').dataset.mode = manual ? 'manual' : 'generated';
        create.querySelector('[data-scope-mode-label]').textContent = manual ? 'Manual scope' : 'Generated from settings';
        create.querySelector('[data-scope-mode-heading]').textContent = manual ? 'The exact scope text determines access' : 'The settings below determine access';
        create.querySelector('[data-scope-mode-description]').textContent = manual
            ? `${basicFacts ? 'Basic patient data uses a manual scope. ' : ''}The generator settings below are inactive. They do not add limits or permissions to this scope.`
            : 'Changing a category, history, sensitive category or permission updates the final scope. Review its exact text before saving.';
        generator.disabled = manual;
        create.elements.approvalScope.readOnly = !manual;
        create.querySelector('[data-switch-scopes]').hidden = !manual;
        create.querySelector('[data-edit-scopes]').hidden = manual;
        create.querySelector('[data-reset-scopes]').hidden = manual;
        create.querySelector('[data-generated-history]').hidden = manual;
        create.querySelector('[data-generator-label]').textContent = manual ? 'Generator settings — inactive in Manual mode' : 'Generator settings — active';
        create.querySelector('[data-generator-explanation]').textContent = manual
            ? 'Shown for reference only. Checked boxes here do not describe the current manual scope. Switch modes above to use these settings.'
            : 'These settings generate the final scope below.';
        create.querySelector('[data-scope-edit-note]').textContent = manual
            ? 'This exact text will be saved. Editing it keeps the generator settings inactive.'
            : 'Read-only preview of the active settings. Choose Edit exact scope manually to write your own scope.';
        const facts = basicFacts || (manual ? { Permissions: 'Review the exact manual text below; no generator permissions or limits are inferred.' } : generatorFacts());
        const list = create.querySelector('[data-scope-facts]');
        list.replaceChildren();
        for (const [label, value] of Object.entries(facts)) {
            const row = document.createElement('div'), term = document.createElement('dt'), detail = document.createElement('dd');
            term.textContent = label; detail.textContent = value; row.append(term, detail); list.append(row);
        }
    }
    /** Close an unconfirmed mode replacement without altering any scope text. */
    function closeScopeReview() {
        scopeReview.hidden = true;
        create.querySelector('[data-switch-scopes]').setAttribute('aria-expanded', 'false');
    }
    /** Review the current generator settings before discarding a manual scope. */
    function reviewScopeReplacement() {
        if (submitting || loadingData || scopeOrigin !== 'custom') return;
        const current = basicManualFacts();
        const head = create.querySelector('[data-scope-comparison-head]'), body = create.querySelector('[data-scope-comparison]');
        const headings = ['Access', ...(current ? ['Current manual template'] : []), 'After switching'];
        head.replaceChildren(); body.replaceChildren();
        const headingRow = document.createElement('tr');
        for (const label of headings) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; headingRow.append(cell); }
        head.append(headingRow);
        for (const [label, value] of Object.entries(generatorFacts())) {
            const row = document.createElement('tr'), title = document.createElement('th');
            title.scope = 'row'; title.textContent = label; row.append(title);
            const values = [...(current ? [current[label]] : []), value];
            values.forEach((text, index) => { const cell = document.createElement('td'); cell.textContent = text; cell.dataset.label = headings[index + 1]; row.append(cell); });
            body.append(row);
        }
        create.querySelector('[data-scope-comparison-note]').textContent = current ? 'Basic patient data currently uses the exact manual template scope.' : 'Current permissions are defined only by your exact manual text below; they are not inferred from the inactive settings.';
        scopeReview.hidden = false;
        create.querySelector('[data-switch-scopes]').setAttribute('aria-expanded', 'true');
        create.querySelector('#service-scope-replacement-heading').focus();
    }
    /** Return explicit chosen resource/action pairs; there is no arbitrary scope parser here. */
    function permissions() {
        return [...typeHost.querySelectorAll('[data-permission-type]')].map(row => ({ type: row.dataset.permissionType,
            actions: row.dataset.permissionType === 'Patient' ? 'rs' : [...row.querySelectorAll('input:checked')].map(input => input.value).join('') })).filter(item => item.actions);
    }
    /** Fence every obsolete result, including replies already in flight at manual edits. */
    function invalidatePreview() {
        previewSequence++; previewProof = undefined; previewDraftKey = undefined; clearTimeout(previewTimer); previewAbort?.abort();
    }
    /** Ask only the existing server generator or basic manual advisory, never a browser compiler. */
    function schedulePreview(force = false) {
        const key = JSON.stringify(definition());
        if (!force && key === previewDraftKey) return;
        invalidatePreview();
        previewDraftKey = key;
        const status = create.querySelector('[data-preview-status]');
        const manual = scopeOrigin === 'custom';
        create.querySelector('[data-scope-origin]').textContent = manual ? 'Manual — exact text' : 'Generated from settings — recalculating';
        status.textContent = manual ? 'Exact manual text will be saved. Basic syntax advice pending; no compiler preview is required.' : 'Generation pending — complete the required fields. Previous text is retained until generation succeeds.';
        create.querySelector('[data-preview-policy]').textContent = '';
        create.querySelector('[data-scope-interpretation]').textContent = '';
        previewTimer = setTimeout(async () => {
            const sequence = previewSequence;
            previewAbort = new AbortController();
            const deadline = setTimeout(() => previewAbort.abort(), 10000);
            try {
                const response = await fetch(create.getAttribute('action').replace(/\/catalog$/, '/preview'), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({ csrf: create.dataset.previewCsrf, definition: definition() }), signal: previewAbort.signal });
                const value = await response.json();
                if (sequence !== previewSequence) return;
                if (!response.ok) throw new Error(value.error || 'Generation failed.');
                if (!manual) {
                    previewProof = value.previewProof;
                    create.elements.approvalScope.value = value.savedScope;
                }
                create.querySelector('[data-scope-origin]').textContent = manual ? 'Manual — exact text' : 'Generated from settings';
                status.textContent = manual ? 'Exact manual text will be saved. Syntax advice is advisory; saving does not establish usable authority.' : `Generated at ${value.calculatedAt}. This creation/history anchor is retained on save.`;
                create.querySelector('[data-preview-policy]').textContent = manual
                    ? value.diagnostics.issues.join(' ') || 'No basic syntax issues found. Runtime validation still applies.'
                    : 'Generated default excludes Very Restricted (V); Restricted (R) follows the deliberate generator setting.';
                create.querySelector('[data-scope-interpretation]').textContent = value.interpretation;
            } catch (error) {
                if (sequence === previewSequence) {
                    create.querySelector('[data-scope-origin]').textContent = manual ? 'Manual — exact text' : 'Generated from settings — unavailable';
                    status.textContent = `${manual ? 'Syntax advice' : 'Generation'} unavailable: ${error.name === 'AbortError' ? 'Request timed out.' : error.message} Entered text is retained.${manual ? ' Exact manual saving remains available.' : ' Regenerate successfully before saving generated text.'}`;
                }
            } finally { clearTimeout(deadline); }
        }, 250);
    }
    /** Render readable rule choices and reusable text, without compiling clinical predicates. */
    function scopePreview(force = false) {
        renderScopeMode();
        const selected = [...permissions(), ...(create.elements.includeMasterData?.checked ? ['Organization', 'Practitioner', 'PractitionerRole', 'Location'].map(type => ({ type, actions: 'r' })) : [])];
        for (const row of typeHost.querySelectorAll('[data-permission-type]')) remembered.set(row.dataset.permissionType, [...row.querySelectorAll('input:checked')].map(input => input.value).join(''));
        const restricted = create.elements.allowRestricted.checked;
        create.querySelector('[data-restricted-impact]').textContent = scopeOrigin === 'custom' ? 'Generator setting only. The exact manual scope determines R/V predicates; these controls do not add filters to it.' : restricted ? 'Restricted (R) is explicitly allowed, including Patient. Very Restricted (V) stays excluded under normal rules. Sensitive categories remain separate.' : 'Restricted (R) and Very Restricted (V) are excluded, including Patient. Sensitive categories do not change this policy.';
        const data = definition();
        create.querySelector('[data-service-rules]').textContent = [selected.map(item => `${item.type}: ${item.actions === 'rs' ? 'read and search' : item.actions === 'r' ? 'read only' : 'search only'}`).join('; '),
            ...data.buckets.map(bucket => {
                const row = categories.find(category => category.dataset.serviceBucket === bucket.code);
                const unit = row.querySelector('[name="historyUnit"]').selectedOptions[0].textContent;
                const tags = [...row.querySelectorAll('[name="sensitivity"]:checked')].map(input => input.parentElement.textContent.trim());
                return `${row.querySelector('legend').textContent.trim()}: history ${bucket.history} ${unit}${Number(bucket.history) === 0 ? ' (cutoff now, not unlimited)' : ''}; sensitive categories: ${tags.join(', ') || 'none'}`;
            }),
            `Confidentiality: R ${restricted ? 'allowed deliberately' : 'excluded'}; V excluded. Master: ${data.includeMasterData ? 'Organization, Practitioner, PractitionerRole and Location read by known logical ID only, outside Patient compartment' : 'off'}.`,
            `Maximum access period: ${data.duration} ${create.elements.durationUnit.selectedOptions[0].textContent}; mode: ${create.elements.accessMode.selectedOptions[0].textContent}; patient category choice preference: ${data.allowChanges ? 'allowed' : 'not allowed'} (no separate category editor).`].join('\n');
        schedulePreview(force);
    }
    create.elements.approvalScope.addEventListener('input', invalidatePreview);
    create.querySelector('[data-edit-scopes]').addEventListener('click', () => {
        if (submitting || loadingData) return;
        scopeOrigin = 'custom'; closeScopeReview(); dirty = true; markDraft(); scopePreview(true);
        create.elements.approvalScope.focus();
    });
    create.querySelector('[data-switch-scopes]').addEventListener('click', reviewScopeReplacement);
    create.querySelector('[data-keep-manual]').addEventListener('click', () => {
        closeScopeReview(); create.querySelector('[data-switch-scopes]').focus();
    });
    create.querySelector('[data-confirm-scopes]').addEventListener('click', () => {
        if (submitting || loadingData || scopeReview.hidden) return;
        scopeOrigin = 'generated'; closeScopeReview(); generatorSettings.open = true;
        dirty = true; markDraft(); scopePreview(true); validateDraft();
        create.elements.allowRestricted.focus();
    });
    create.querySelector('[data-reset-scopes]').addEventListener('click', () => {
        if (submitting || loadingData) return;
        if (scopeOrigin === 'custom') { reviewScopeReplacement(); return; }
        dirty = true; markDraft(); scopePreview(true);
    });
    create.querySelector('[data-copy-scope]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(create.elements.approvalScope.value); }
        catch { create.querySelector('[data-preview-status]').textContent += ' Copy unavailable; select and copy the raw preview text.'; }
    });
    /** Input edits refresh the current mode; only the reviewed action replaces manual text. */
    function changedDraft() {
        closeScopeReview();
        scopePreview();
    }
    create.addEventListener('input', changedDraft);
    create.addEventListener('change', changedDraft);
    /** Reuse the server-supplied resource mapping and retain choices when categories change. */
    function updateTypes() {
        const types = new Set(['Patient']);
        for (const category of categories) {
            const enabled = category.querySelector('[name="enabled"]').checked;
            category.querySelector('[data-bucket-settings]').hidden = !enabled;
            for (const input of category.querySelectorAll('input:not([name="enabled"]),select')) input.disabled = !enabled;
            if (enabled) for (const type of JSON.parse(category.dataset.types)) types.add(type);
        }
        typeHost.hidden = !categories.some(category => category.querySelector('[name="enabled"]').checked);
        for (const row of typeHost.querySelectorAll('[data-permission-type]')) {
            if (row.dataset.permissionType !== 'Patient') remembered.set(row.dataset.permissionType, [...row.querySelectorAll('input:checked')].map(input => input.value).join(''));
        }
        typeHost.replaceChildren();
        // Preserve the template's resource order while applying the new-draft action defaults.
        const ordered = [...types].sort((a, b) => (templateOrder.includes(a) ? templateOrder.indexOf(a) : 1000) - (templateOrder.includes(b) ? templateOrder.indexOf(b) : 1000));
        for (const type of ordered) {
            const row = document.createElement('fieldset'); row.dataset.permissionType = type; row.dataset.helpKey = 'services.actions'; row.className = 'mb-2';
            const legend = document.createElement('legend'); legend.className = 'h6'; legend.textContent = type.replace(/([a-z])([A-Z])/g, '$1 $2'); row.append(legend);
            if (type === 'Patient') {
                const fixed = document.createElement('p'); fixed.textContent = 'Read and search included (patient/Patient.rs)'; row.append(fixed); typeHost.append(row); continue;
            }
            for (const [value, labelText] of [['r', 'Read individual records'], ['s', 'Search records']]) {
                const label = document.createElement('label'); label.className = 'form-check'; label.dataset.helpKey = 'services.actions';
                const input = document.createElement('input'); input.type = 'checkbox'; input.value = value; input.className = 'form-check-input';
                input.checked = (remembered.get(type) ?? 'rs').includes(value); label.append(input, document.createTextNode(labelText)); row.append(label);
            }
            typeHost.append(row);
        }
        scopePreview();
    }
    for (const category of categories) category.querySelector('[name="enabled"]').addEventListener('change', updateTypes);
    updateTypes();
    /** Mirror existing required-field rules so errors identify a field before an ordinary API request. */
    function validateDraft() {
        if (create.elements.exampleQueries) {
            let message = '';
            try { if (create.elements.exampleQueries.value.trim() && !Array.isArray(JSON.parse(create.elements.exampleQueries.value))) message = 'Use a JSON array for example queries.'; } catch { message = 'Use valid JSON for example queries, or leave blank for generated examples.'; }
            create.elements.exampleQueries.setCustomValidity(message);
            // Invalid native controls must be focusable, including inside collapsed disclosures.
            if (message) create.elements.exampleQueries.closest('details').open = true;
        }
        for (const name of ['name', 'purpose']) create.elements[name].setCustomValidity(create.elements[name].value.trim() ? '' : `${name === 'name' ? 'Service name' : 'Purpose'} is required.`);
        categories[0].querySelector('[name="enabled"]').setCustomValidity(categories.some(row => row.querySelector('[name="enabled"]').checked) ? '' : 'Select at least one supported data category.');
        const firstAction = typeHost.querySelector('input');
        if (firstAction) firstAction.setCustomValidity(permissions().length ? '' : 'Choose at least one read/search permission.');
    }
    /** Read only the supported form fields; FHIR wrappers and validation belong to the server. */
    function definition() {
        const data = new FormData(create);
        let exampleQueries;
        if (create.elements.exampleQueries?.value.trim()) { try { exampleQueries = JSON.parse(create.elements.exampleQueries.value); } catch { exampleQueries = null; } }
        return { ...(exampleQueries === undefined ? {} : { exampleQueries }), name: data.get('name'), purpose: data.get('purpose'), category: data.get('category'), accessMode: data.get('accessMode'),
            // Disabled generator controls still supply required authoring metadata in Manual mode.
            scopeOrigin, ...(scopeOrigin === 'custom' ? { approvalScope: data.get('approvalScope') } : {}), confidentialityPolicy: { allowRestricted: create.elements.allowRestricted.checked },
            duration: data.get('duration'), durationUnit: data.get('durationUnit'), allowChanges: data.has('allowChanges'), includeMasterData: create.elements.includeMasterData.checked, permissions: permissions(),
            buckets: categories.filter(row => row.querySelector('[name="enabled"]').checked).map(row => ({ code: row.dataset.serviceBucket,
                history: row.querySelector('[name="history"]').value, historyUnit: row.querySelector('[name="historyUnit"]').value,
                sensitivity: [...row.querySelectorAll('[name="sensitivity"]:checked')].map(input => input.value) })) };
    }
    /** Bind refreshed forms once, keeping pending/completed submission guards on each live form. */
    function bindForms() {
        for (const form of document.querySelectorAll('[data-service-create],[data-service-assign],[data-service-sandbox],[data-service-template],[data-service-status-form]')) {
            if (boundForms.has(form)) continue;
            boundForms.add(form);
            let busy = false, completed = false, lockedButtons = [];
            // A successful explicit refresh permits a reviewed request; failed loads keep the uncertainty guard.
            if (form === create) releaseCreate = () => {
                completed = false;
                lockedButtons.forEach(([button, disabled]) => { button.disabled = disabled; });
                lockedButtons = [];
            };
            form.addEventListener('submit', async event => {
                event.preventDefault();
                if (busy || completed || loadingData || submitting) return;
                if (form === create) { validateDraft(); if (!create.reportValidity()) return; }
                const template = form.hasAttribute('data-service-template');
                const sandbox = form.hasAttribute('data-service-sandbox');
                const ownerStatus = form.hasAttribute('data-service-status-form');
                const action = event.submitter?.value;
                if ((sandbox || ownerStatus) && (!action || event.submitter.disabled)) return;
                if (ownerStatus) {
                    const effect = action === 'suspended' ? 'Pause is reversible. Current approved Consents become temporarily inactive.' : action === 'active' ? 'Eligible temporarily inactive Consents may recover; expired or terminal Consents never revive. Obtain fresh tokens after restoration.' : 'This is terminal and cannot be reversed. Current Consents become permanently inactive; historical references remain.';
                    if (!window.confirm(`${event.submitter.textContent.trim()}: ${form.dataset.serviceName}, provider ${form.dataset.providerName}? ${effect} Previously cached decisions may last up to 30 seconds.`)) return;
                }
                if (sandbox) {
                    const target = form.dataset.targetKind === 'catalog' ? 'the shared definition for all providers' : `the registration for ${form.dataset.providerName}`;
                    const effect = action === 'delete' ? 'This removes only the selected inactive record from this runtime. Referenced records block deletion. No patient data or seed files are deleted. Uncheckpointed runtime changes are lost on restart/reset. An explicit retained checkpoint can preserve them.'
                        : action === 'disable' ? 'Consent-based access will be blocked for the affected registrations.' : 'Only eligible approvals can become usable. Terminal decisions remain terminal.';
                    if (!window.confirm(`${event.submitter.textContent.trim()} ${target}: ${form.dataset.serviceName}? Private sandbox simulation. ${effect} Previously cached decisions may last up to 30 seconds. Clinical permissions stay enforced in every preset.`)) return;
                }
                if (form === create && scopeOrigin === 'generated' && !previewProof) { form.querySelector('[data-service-result]').textContent = 'Regenerate successfully before creating generated text. Your draft is retained.'; return; }
                const body = ownerStatus ? { providerRole: form.dataset.providerRole, csrf: form.dataset.csrf, expectedVersion: form.dataset.version, expectedState: form.dataset.state, state: action } : sandbox ? { action, expectedVersion: form.dataset.version, csrf: form.dataset.csrf }
                    : form === create ? { csrf: form.dataset.catalogCsrf, expectedRevision: Number(form.dataset.revision), definition: definition(), ...(scopeOrigin === 'generated' ? { previewProof } : {}) } : { providerRole: form.dataset.providerRole, csrf: form.dataset.csrf, ...(template ? { templateKey: form.dataset.templateKey } : { catalogId: form.elements.catalogId.value }) };
                const result = form.querySelector('[data-service-result]');
                // Help remains usable while ordinary actions are locked after a result.
                const buttons = [...(form.closest?.('[data-provider-pair]') || form).querySelectorAll('button')].filter(button => !button.dataset?.helpFor).map(button => [button, button.disabled]);
                // Keep the original control states until explicit successful inspection releases this form.
                if (form === create) lockedButtons = buttons;
                const fields = form === create ? [...form.querySelectorAll('input,select,textarea')].map(field => [field, field.disabled]) : [];
                fields.forEach(([field]) => { field.disabled = true; });
                busy = true; submitting = true; buttons.forEach(([button]) => { button.disabled = true; }); result.textContent = 'Saving…';
                try {
                    let response, value;
                    if (ownerStatus && action === 'disconnect') {
                        const registration = { id: form.dataset.registrationId, providerId: form.dataset.providerId, role: form.dataset.providerRole, version: form.dataset.version, state: form.dataset.state, csrf: form.dataset.csrf };
                        value = await PcmServiceLifecycle.disconnect({ registration,
                            transition: async (current, state) => {
                                const reply = await fetch(form.action, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ providerRole: current.role, csrf: current.csrf, expectedVersion: current.version, expectedState: current.state, state }) });
                                const outcome = await reply.json();
                                if (!reply.ok) throw new Error(outcome.error || 'The ordinary API refused the step.');
                                return outcome;
                            },
                            inspect: async current => {
                                const url = new URL(load.action); url.searchParams.set('view', 'assignments'); url.searchParams.set('target', current.id);
                                const reply = await fetch(url.href, { headers: { Accept: 'text/html' } });
                                if (!reply.ok) throw new Error('The paused-state read failed.');
                                const page = new DOMParser().parseFromString(await reply.text(), 'text/html');
                                const exact = [...page.querySelectorAll('[data-service-status-form]')].find(node => node.dataset.registrationId === current.id && node.dataset.providerId === current.providerId);
                                return exact ? { id: exact.dataset.registrationId, providerId: exact.dataset.providerId, role: exact.dataset.providerRole, state: exact.dataset.state, version: exact.dataset.version, csrf: exact.dataset.csrf } : null;
                            } });
                        response = { ok: true, status: 200 };
                    } else {
                        response = await fetch(form.getAttribute('action'), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
                        value = await response.json();
                    }
                    completed = response.ok || response.status === 409 || response.status === 403 || response.status >= 500;
                    result.textContent = response.ok ? value.message : `${response.status >= 500 ? 'The result may be uncertain. ' : ''}${value.error || 'The request failed.'} Refresh Services and review the current state before retrying.`;
                    if (response.ok && form.closest?.('[data-service-group]')) {
                        const groupId = form.closest('[data-service-group]').dataset.serviceGroup;
                        const providerId = form.closest?.('[data-provider-pair]').dataset.providerPair;
                        const destination = new URL(load.action); destination.searchParams.set('view', 'assignments'); destination.searchParams.set('target', value.reviewTarget || value.id || groupId);
                        submitting = false;
                        const inspected = await refresh(destination.href);
                        const group = [...document.querySelectorAll('[data-service-group]')].find(node => node.dataset.serviceGroup === groupId);
                        const row = [...(group?.querySelectorAll('[data-provider-pair]') || [])].find(node => node.dataset.serviceId === (value.id || form.closest('[data-service-id]')?.dataset.serviceId) && node.dataset.providerPair === providerId)
                            || [...(group?.querySelectorAll('[data-provider-pair]') || [])].find(node => node.dataset.providerPair === providerId);
                        const receipt = row?.querySelector('[data-connection-result]') || group?.querySelector('[data-group-result]');
                        if (inspected && receipt) { receipt.textContent = row ? value.message : `Organization/${providerId}: ${value.message}`; receipt.tabIndex = -1; receipt.focus(); }
                        else { result.textContent = value.message + ' Saved, but current state could not be inspected. Refresh before another action.'; completed = true; }
                        return;
                    }
                    if (response.ok && form === create) dirty = false;
                    if (response.ok && (template || form === create)) {
                        const details = document.createElement('details'), summary = document.createElement('summary'), values = document.createElement('pre');
                        summary.textContent = form === create ? 'Saved definition and exact authoring record' : 'Registration details for clients'; summary.dataset.helpKey = 'services.template-reference';
                        values.className = 'scope-value'; values.textContent = JSON.stringify({ reference: value.reference, businessIdentifier: value.businessIdentifier, canonicalReference: value.canonicalReference, serviceGrant: value.serviceGrant }, null, 2);
                        details.append(summary, values); result.append(details);
                    }
                    if (response.ok && form === create) {
                        const next = document.createElement('a'), destination = new URL(location.href); destination.searchParams.set('target', value.id); destination.searchParams.set('view', 'assignments'); destination.searchParams.delete('offset'); destination.searchParams.delete('revision'); destination.hash = '';
                        next.textContent = 'Connect providers'; next.href = destination.href; next.dataset.serviceConnectNext = ''; next.dataset.helpKey = 'services.assign'; next.className = 'btn btn-secondary'; result.append(next);
                        const note = document.createElement('p'); note.textContent = 'Review this service group. Approve its catalog definition before connecting eligible providers; provider activation remains separate.'; result.append(note);
                    }
                    const refreshLink = document.createElement('a');
                    const destination = new URL(location.href); destination.searchParams.delete('offset'); destination.searchParams.delete('revision');
                    if (form === create) destination.searchParams.set('view', 'catalog');
                    if (response.ok && value.reviewTarget && (!sandbox || action === 'delete' || !destination.searchParams.has('target'))) destination.searchParams.set('target', value.reviewTarget);
                    else if (sandbox && action === 'delete') destination.searchParams.delete('target');
                    refreshLink.href = destination.href; refreshLink.dataset.helpKey = 'services.load'; refreshLink.textContent = 'Refresh Services'; refreshLink.className = 'services-refresh'; result.append(refreshLink);
                } catch (error) {
                    completed = true; result.textContent = error.stage ? error.message : 'The result is uncertain. Refresh Services to inspect the saved state before retrying.';
                } finally {
                    fields.forEach(([field, disabled]) => { field.disabled = disabled; });
                    busy = false; submitting = false;
                    if (!completed) {
                        buttons.forEach(([button, disabled]) => { button.disabled = disabled; });
                        lockedButtons = [];
                    }
                }
            });
        }
    }
    bindForms();
    filterRows();
})();
