'use strict';

/** Editable configured choices, safe error focus and advisory timers; the server remains authoritative. */
// Some browsers retain no-store pages in back/forward cache; revalidate bound state before reuse.
addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
document.addEventListener('DOMContentLoaded', () => {
    const form = document.querySelector('[data-workflow-start]');
    if (form) {
        const picker = document.querySelector('[data-workflow-patient-choice]');
        const details = document.querySelector('[data-workflow-system]');
        picker?.addEventListener('change', () => {
            const option = picker.selectedOptions[0];
            if (option?.dataset.system) { form.system.value = option.dataset.system; form.identifier.value = option.dataset.identifier; form.identifier.focus(); }
            if (details) details.textContent = form.system.value;
        });
        form.system.addEventListener('change', () => { if (details) details.textContent = form.system.value; });
        form.addEventListener('submit', () => { form.identifier.value = form.identifier.value.trim(); });
    }
    document.querySelector('[data-workflow-feedback]')?.focus();
    const busy = document.querySelector('[data-workflow-busy]');
    for (const current of document.querySelectorAll('form')) current.addEventListener('submit', event => {
        if (current.getAttribute('aria-busy') === 'true') return event.preventDefault();
        current.setAttribute('aria-busy', 'true');
        // Preserve the native form and submitter while announcing the pending request.
        if (busy) { busy.hidden = false; busy.tabIndex = -1; busy.focus(); }
    });
    const verify = document.querySelector('[data-code-verify]'), resend = document.querySelector('[data-code-resend]');
    const status = document.querySelector('[data-code-status]');
    if (!verify && !resend) return;
    const update = () => {
        const now = Date.now() / 1000;
        if (verify) {
            const exhausted = Number(verify.dataset.attemptsRemaining) <= 0;
            const expired = Number(verify.dataset.expiresAt) <= now;
            verify.disabled = expired || exhausted;
            if (status) {
                const key = exhausted ? 'workflow.attempts' : expired ? 'workflow.code-expired' : 'workflow.otp-status';
                if (status.dataset.helpKey !== key) status.dataset.helpKey = key;
                const message = exhausted
                ? 'No attempts remain. End this sign-in and start again.'
                : expired ? 'This code expired. Request a new code if available, or end this sign-in and start again.'
                    : 'Enter the current code to continue.';
                if (status.textContent !== message) status.textContent = message;
            }
        }
        if (resend) resend.disabled = resend.dataset.permanentlyDisabled === 'true' || Number(resend.dataset.resendAt) > now;
    };
    update(); const timer = setInterval(update, 500);
    addEventListener('pagehide', () => clearInterval(timer), { once: true });
});
