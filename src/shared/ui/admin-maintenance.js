'use strict';
/** Read a selected ordinary backup into the same ephemeral paste field; never persist it. */
document.addEventListener('DOMContentLoaded', () => {
    const form = document.querySelector('[data-maintenance-restore]');
    if (!form) return;
    const error = document.querySelector('#admin-error-summary');
    if (error) { error.tabIndex = -1; error.focus(); }
    const file = form.querySelector('input[type=file]'), input = form.querySelector('textarea'), status = form.querySelector('[role=status]');
    let attempt = 0;
    file.addEventListener('change', async () => {
        const current = ++attempt, selected = file.files[0];
        input.value = ''; status.textContent = '';
        if (!selected) return;
        if (selected.size > 1024 * 1024) { status.textContent = 'Backup exceeds the 1 MiB restore limit. Select a smaller ordinary configuration backup.'; status.focus(); return; }
        try {
            const text = await selected.text();
            if (current !== attempt) return;
            JSON.parse(text);
            input.value = text; status.textContent = 'File loaded for review. No server changes made.';
        } catch (_) { if (current === attempt) { status.textContent = 'Backup is not valid JSON. Select or paste a complete configuration backup.'; status.focus(); } }
    });
    // A deliberate paste supersedes any pending file read. Secret content stays tab-local.
    input.addEventListener('input', () => { attempt++; file.value = ''; status.textContent = ''; });
    window.addEventListener('pageshow', event => { if (event.persisted) { attempt++; input.value = ''; file.value = ''; status.textContent = ''; } });
});
