'use strict';
/** Presentation-only exact address copying and legacy fragment compatibility. */
document.addEventListener('DOMContentLoaded', () => {
    for (const button of document.querySelectorAll('[data-copy-address]')) {
        button.addEventListener('click', async () => {
            const row = button.closest('[data-endpoint]');
            const value = row.querySelector('[data-exact-address]');
            const status = row.querySelector('[data-copy-status]');
            try {
                if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
                await navigator.clipboard.writeText(value.textContent);
                status.textContent = button.dataset.copyLabel ? `${button.dataset.copyLabel} copied.` : 'Exact address copied.';
            } catch {
                const range = document.createRange(); range.selectNodeContents(value);
                const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
                value.focus();
                status.textContent = `Automatic copy unavailable. ${button.dataset.copyLabel || 'Address'} selected; use your keyboard or touch Copy command.`;
            }
        });
    }
    // Disclosure state is local to this rendered page; no command, log deletion or guard change.
    const show = (id, visible) => {
        const panel = document.getElementById(id);
        if (!panel) return;
        panel.hidden = !visible;
        document.querySelectorAll('[data-admin-toggle]').forEach(button => {
            if (button.dataset.adminToggle === id) button.setAttribute('aria-expanded', String(visible));
        });
    };
    document.querySelectorAll('[data-admin-toggle]').forEach(button => button.addEventListener('click', () => {
        const panel = document.getElementById(button.dataset.adminToggle);
        if (panel) show(panel.id, panel.hidden);
    }));
    document.querySelectorAll('[data-admin-dismiss]').forEach(button => button.addEventListener('click', () => {
        show(button.dataset.adminDismiss, false);
        document.querySelector(`[data-admin-toggle="${button.dataset.adminDismiss}"]`)?.focus();
    }));
    // Old bookmarks used fragments on the single page. Resolve known owning areas
    // before an operation can start; unknown fragments leave the current page intact.
    const legacy = { 'presence-limits': 'sources', 'simulation-preset': 'security', 'access-token-lifetime': 'security',
        'mapping-business-id': 'sources', 'ds-gateway-fhir-url': 'sources', 'restore-backup-json': 'maintenance' };
    let fragment;
    try { fragment = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    const area = legacy[fragment] || (/^(server-|source-)/.test(fragment) ? 'sources' : null);
    const current = new URL(location.href);
    if (area && (!current.searchParams.has('section') || (area === 'sources' && !current.searchParams.has('source')))) {
        current.searchParams.set('section', area);
        const sourceLink = [...document.querySelectorAll('[data-source-address]')].find(link => {
            if (fragment.startsWith('source-')) return link.dataset.sourceAddress === fragment.slice(7);
            if (fragment.startsWith('server-')) return link.dataset.serverAddress === fragment.slice(7);
            return ['mapping-business-id', 'ds-gateway-fhir-url'].includes(fragment) && link.dataset.sourceHosting === 'legacy';
        });
        if (sourceLink) current.searchParams.set('source', sourceLink.dataset.sourceAddress);
        else if (fragment.startsWith('source-')) current.searchParams.set('source', fragment.slice(7));
        if (fragment === 'mapping-business-id') current.searchParams.set('view', 'mappings');
        if (fragment === 'ds-gateway-fhir-url') current.searchParams.set('view', 'upstream');
        if (fragment.startsWith('server-')) current.searchParams.set('view', 'data');
        if (fragment === 'presence-limits') current.searchParams.set('view', 'defaults');
        if (current.href !== location.href) location.replace(current.href);
    }
});
