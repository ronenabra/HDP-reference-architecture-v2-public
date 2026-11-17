'use strict';
/** Discard this tab's drafts for all applications on the reset Doctor mount.
 * @param {Storage} storage Current tab session storage.
 * @param {string} base Configured local Doctor mount.
 * @returns {void}
 */
function clearDoctorDrafts(storage, base) {
    const prefix = `pcm-doctor-draft:${base}:`;
    for (const key of Object.keys(storage)) if (key.startsWith(prefix)) storage.removeItem(key);
}
if (typeof module !== 'undefined' && module.exports) module.exports = { clearDoctorDrafts };
/** Switch between already-rendered configuration notes without making requests. */
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
    const notice = document.querySelector('[data-doctor-notice]');
    if (!notice) return;
    const tabList = notice.querySelector('[data-doctor-notice-tabs]');
    const tabs = [...notice.querySelectorAll('[data-doctor-notice-tab]')];
    const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
    if (!tabList || !tabs.length || panels.some(panel => !panel)) return;
    /** Activate one panel while retaining native keyboard focus and tab semantics.
     * @param {number} selected Index of the configuration panel to display.
     * @returns {void}
     */
    const selectPanel = selected => {
        tabs.forEach((tab, index) => {
            const active = index === selected;
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
            panels[index].hidden = !active;
        });
    };
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', event => { if (!event.defaultPrevented) selectPanel(index); });
        tab.addEventListener('keydown', event => {
            if (event.defaultPrevented || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            selectPanel(next);
            tabs[next].focus();
        });
    });
    // Without scripting, every note remains readable inside the native disclosure.
    selectPanel(0);
    tabList.hidden = false;
});
/** Overlay existing navigation/actions without moving the document or making requests. */
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
    const button = document.querySelector('#doctor-tools-button'), panel = document.querySelector('#doctor-tools-panel');
    if (!button || !panel) return;
    /** A library Tools link opens the existing request-page disclosure on return. */
    const revealManual = () => {
        const manual = document.querySelector('#manual-testing');
        if (manual) { manual.open = true; manual.querySelector('summary').focus(); }
    };
    if (window.location.hash === '#manual-testing') revealManual();
    /** Bound physical width even when browser/CSS zoom reduces the usable layout. */
    const contain = () => {
        if (panel.hidden) return;
        const rect = button.getBoundingClientRect(), scale = rect.width / button.offsetWidth || 1;
        const height = window.visualViewport?.height || window.innerHeight;
        const below = height - rect.bottom - 16, above = rect.top - 16;
        const flip = below < 176 && above > below;
        panel.style.maxWidth = `${Math.max(1, (document.documentElement.clientWidth - 32) / scale)}px`;
        panel.style.maxHeight = `${Math.max(1, (flip ? above : below) / scale)}px`;
        panel.style.top = flip ? 'auto' : 'calc(100% + .4rem)';
        panel.style.bottom = flip ? 'calc(100% + .4rem)' : 'auto';
    };
    const close = (restore = true) => { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); if (restore) button.focus(); };
    button.addEventListener('click', () => {
        if (!panel.hidden) return close();
        panel.hidden = false; contain(); button.setAttribute('aria-expanded', 'true'); panel.querySelector('a,button')?.focus();
    });
    panel.querySelector('[data-tools-close]').addEventListener('click', () => close());
    panel.querySelector('form[action$="/reset"]')?.addEventListener('submit', event => {
        // The existing confirmation handler runs first; cancelling keeps the draft.
        if (event.defaultPrevented) return;
        try { clearDoctorDrafts(sessionStorage, document.body.dataset.browserBase || ''); }
        catch (_) { /* Optional tab storage cannot block the existing reset action. */ }
    });
    window.addEventListener('resize', contain);
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); close(); } });
    document.addEventListener('pointerdown', event => { if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target) && !event.target.closest('#pcm-help-tooltip')) close(false); });
    document.addEventListener('focusin', event => { if (!panel.hidden && !panel.contains(event.target) && event.target !== button && !event.target.closest('#pcm-help-tooltip')) close(false); });
    panel.querySelector('[data-manual-open]')?.addEventListener('click', () => {
        close(false); revealManual();
    });
});
