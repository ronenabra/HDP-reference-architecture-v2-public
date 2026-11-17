'use strict';
/** Submit a protected cancellation once; reload authoritative state after success or conflict. */
(() => {
    const form = document.querySelector('[data-consent-cancellation]');
    if (!form) return;
    const button = form.querySelector('button'), result = form.querySelector('[data-cancellation-result]');
    let busy = false;
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || button.disabled) return;
        if (!window.confirm(`Permanently cancel this consent on behalf of ${form.dataset.providerName}? This cannot be undone. Further access under a consent will require a new request and approval. Previously cached access decisions may remain usable for up to 30 seconds.`)) return;
        busy = true; button.disabled = true;
        try {
            const body = Object.fromEntries(['expectedVersion', 'providerRole', 'csrf'].map(key => [key, form.elements[key].value]));
            const response = await fetch(form.action, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
            const value = await response.json();
            if (response.ok) { window.location.reload(); return; }
            if (response.status === 409) { window.location.reload(); return; }
            result.textContent = response.status === 401 ? 'Admin login is required. Log in, then refresh the details.' : `${value.error || 'Cancellation failed'}. Refresh before trying again.`;
        } catch (error) { result.textContent = `${error.message}. Refresh to inspect the saved state before trying again.`; }
        finally { busy = false; }
    });
})();
