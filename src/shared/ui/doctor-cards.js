'use strict';
/** Copy the exact visible logical ID, preserving keyboard/manual fallback on local HTTP.
 * @param {string} value Complete selectable Consent logical ID.
 * @param {object|undefined} clipboard Browser clipboard capability, when available.
 * @returns {Promise<string>} Accurate copied/denied/unavailable feedback.
 */
async function copyConsentId(value, clipboard) {
    if (!clipboard?.writeText) return 'Clipboard unavailable. Select the full Consent ID and copy it manually.';
    try { await clipboard.writeText(value); return 'Consent ID copied.'; }
    catch (_) { return 'Clipboard denied. Select the full Consent ID and copy it manually.'; }
}
if (typeof module !== 'undefined') module.exports = { copyConsentId };
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-token-expiry]').forEach(card => {
        const expiresAt = Number(card.dataset.tokenExpiry);
        if (!expiresAt) return;
        // A timer only clears local projections; expiry never requests or renews authority.
        const expire = () => {
            card.querySelector('[aria-label="Fetched FHIR data"]')?.remove();
            const token = card.querySelector('[data-token-details]');
            if (token) token.textContent = 'Previous token expired locally. Granted permissions not yet obtained for a new token.';
            const status = card.querySelector('[data-token-status]');
            if (status) status.textContent = 'Token expired locally. Status check unavailable until a new token is obtained.';
            const summary = card.querySelector('.doctor-retrieval-summary');
            if (summary) summary.textContent = 'Previous token expired locally; no current token-validated retrieval selection.';
        };
        setTimeout(expire, Math.max(0, expiresAt - Date.now()));
    });
    document.querySelectorAll('[data-copy-consent]').forEach(button => button.addEventListener('click', async () => {
        const card = button.closest('[data-consent-card]');
        card.querySelector('[data-copy-feedback]').textContent = await copyConsentId(card.querySelector('[data-consent-id]').textContent, navigator.clipboard);
    }));
});
