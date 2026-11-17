'use strict';
/** Bounded private one-read feedback for the Doctor's optional SMART protocol test. */
function createSmartFeedback({ clock = Date.now, limit = 500 } = {}) {
    const records = new Map();
    const prune = () => { for (const [key, value] of records) if (value.expiresAt <= clock()) records.delete(key); };
    return {
        put(key, value) { prune(); records.delete(key); while (records.size >= limit) records.delete(records.keys().next().value); records.set(key, { value, expiresAt: clock() + 300000 }); },
        take(key) { prune(); const record = records.get(key); records.delete(key); return record?.value; }
    };
}
/** Author static recovery text; untrusted callback descriptions never become page instructions. */
function smartFailure(error, stage) {
    let message = 'SMART code exchange failed.', explanation = 'Start a fresh test. If it fails again, ask the operator to check the registered callback, client credentials and server trust. No clinical Consent or clinical data retrieval was performed.';
    if (stage === 'start') {
        message = 'SMART test could not start.';
        explanation = error.canonicalBase ? 'This Doctor address has no matching registered SMART callback. Open the configured address to start a fresh request.' : 'Start at the configured Doctor address. Ask the operator to check its exact callback registration and PCM metadata reachability.';
    } else if (stage === 'state') {
        message = 'SMART request expired or unavailable.';
        explanation = 'The request expired, was already used, or belongs to another browser. Start a fresh test on the same configured Doctor address.';
    } else if (error.oauthError === 'access_denied') {
        message = error.message === 'The test launch was cancelled.' ? 'SMART test cancelled.' : error.message === 'The test launch was denied.' ? 'SMART test denied.' : 'SMART identity was not authorized.';
        explanation = 'No application code or token was issued for this decision. Verify your own test identity or choose an explicit synthetic protocol fixture, then start a fresh test if needed.';
    } else if (error.oauthError === 'invalid_scope') {
        message = 'SMART permissions were not accepted.';
        explanation = 'Start a fresh test and keep at least one requested permission. Optional narrowing cannot add permissions beyond the application request.';
    }
    return { type: 'error', smart: true, message, explanation };
}
module.exports = { createSmartFeedback, smartFailure };
