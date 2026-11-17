'use strict';
/** Apply a changed sandbox source selection directly, preserving version and CSRF checks. */
(() => {
    const form = document.querySelector('[data-source-change]');
    if (!form) return;
    const result = form.querySelector('[data-source-result]'), apply = form.querySelector('[data-source-apply]');
    const cancel = form.querySelector('[data-source-cancel]');
    const inputs = [...form.querySelectorAll('input[name="sourceIds"]')];
    const sources = () => inputs.filter(input => input.checked).map(input => input.value);
    const original = JSON.stringify(sources().sort());
    let busy = false, stale = false;
    /** Only a changed selection can be submitted; stale versions require a page refresh. */
    function update() {
        const changed = JSON.stringify(sources().sort()) !== original;
        apply.disabled = busy || stale || !changed;
        apply.dataset.helpDisabledKey = busy ? 'pcm.source-saving' : stale ? 'pcm.source-stale' : 'pcm.source-unchanged';
        cancel.disabled = busy || !changed;
        inputs.forEach(input => { input.disabled = busy || (input.dataset.unavailable === 'true'); });
    }
    // Preserve choices that were initially unavailable when unlocking after a failed request.
    inputs.forEach(input => { input.dataset.unavailable = String(input.disabled); });
    form.addEventListener('change', () => { if (!stale) result.textContent = ''; update(); });
    cancel.addEventListener('click', () => { form.reset(); if (!stale) result.textContent = ''; update(); });
    /** Submit once; never automatically retry a conflict or uncertain network outcome. */
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (apply.disabled) return;
        busy = true; update();
        try {
            const response = await fetch(form.action, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ action: 'apply', sourceIds: sources(), expectedVersion: form.elements.expectedVersion.value, csrf: form.elements.csrf.value }) });
            const body = await response.json();
            if (response.ok) { window.location.reload(); return; }
            stale = response.status === 409 || response.status === 403;
            result.textContent = response.status === 401 ? 'Admin login is required. Open Admin, log in, then refresh the details.'
                : `${body.error || 'Source change failed.'}${stale ? ' Refresh the details before applying again.' : ''}`;
        } catch (error) {
            stale = true;
            result.textContent = `${error.message}. Refresh the details to check the saved sources before applying again.`;
        } finally { busy = false; update(); }
    });
    update();
})();
