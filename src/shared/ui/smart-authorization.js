'use strict';
/** Advisory identity gating and accessible pending state; the server validates and consumes decisions. */
addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
document.addEventListener('DOMContentLoaded', () => {
    const form = document.querySelector('[data-smart-decision]');
    if (!form) return;
    const approve = form.querySelector('[data-smart-approve]'), busy = form.querySelector('[data-smart-busy]');
    const update = () => { approve.disabled = !form.querySelector('[name="patient"]:checked'); };
    form.addEventListener('change', update); update();
    form.addEventListener('submit', event => {
        if (form.getAttribute('aria-busy') === 'true') return event.preventDefault();
        form.setAttribute('aria-busy', 'true'); busy.hidden = false;
        // Keep the submitter enabled so its actual decision remains in the POST.
        busy.tabIndex = -1; busy.focus();
    });
});
