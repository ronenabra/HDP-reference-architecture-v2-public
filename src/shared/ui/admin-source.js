/* Custom-source fields and local exact-change review; never persist credentials or drafts. */
(() => {
    'use strict';
    document.querySelectorAll('[data-source-command]').forEach(form => {
        const review = form.querySelector('[data-source-review]'), button = form.querySelector('[data-source-save]');
        let reviewed = false;
        const update = () => {
            reviewed = false; review.hidden = true; button.textContent = 'Review changes';
            const value = name => form.elements.namedItem(name)?.value;
            if (form.dataset.sourcePinAction && value('serverTrustMode')) form.action = value('serverTrustMode') === 'pinned-thumbprint' ? form.dataset.sourcePinAction : form.dataset.sourceCaAction;
            form.querySelectorAll('[data-source-generate]').forEach(group => { group.hidden = value('credentialMode') !== 'generate'; });
            form.querySelectorAll('[data-source-upload]').forEach(group => {
                group.hidden = value('credentialMode') !== 'upload' || group.hasAttribute('data-source-separate') && value('credentialProfile') !== 'separate-es384';
                group.querySelectorAll('input').forEach(input => { input.disabled = group.hidden; input.required = !group.hidden; });
            });
            form.querySelectorAll('[data-source-trust]').forEach(group => {
                group.hidden = group.dataset.sourceTrust !== value('serverTrustMode');
                group.querySelectorAll('input').forEach(input => { input.disabled = group.hidden; });
            });
        };
        form.addEventListener('input', update); form.addEventListener('change', update); update();
        form.addEventListener('submit', event => {
            if (reviewed) return;
            event.preventDefault();
            const before = JSON.parse(form.dataset.sourceCurrent), changes = [];
            for (const [name, value] of new FormData(form)) {
                if (['expectedRevision','adminForm'].includes(name)) continue;
                if (value instanceof File) { if (value.name) changes.push(`${name}: replace with ${value.name} (${value.size} bytes)`); }
                else if (before[name] !== value) changes.push(`${name}: ${before[name] || '(not set)'} → ${value || '(generated/default)'}`);
            }
            form.querySelector('[data-source-changes]').textContent = changes.join('\n') || 'No registration fields changed.';
            review.hidden = false; reviewed = true; button.textContent = 'Publish changes'; review.focus();
        });
    });
    // An empty source field inherits; a typed value uses the existing override contract.
    document.querySelectorAll('[data-limit-mode]').forEach(mode => {
        const input = mode.closest('[data-limit]').querySelector('[data-limit-value]');
        const update = () => { mode.value = input.value.trim() ? 'custom' : 'inherit'; };
        input.addEventListener('input', update); input.form.addEventListener('submit', update); update();
    });
    // Validation feedback has one stable keyboard entry point; no secret field is restored.
    const error = document.querySelector('#admin-error-summary') || document.querySelector('#source-trust-error.alert-danger');
    if (error) { error.setAttribute('tabindex','-1'); error.setAttribute('role','alert'); error.focus(); }
})();
