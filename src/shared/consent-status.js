'use strict';
/** Readable projections of authoritative Consent state and retained status evidence. */
const { EXTENSIONS, CODE_SYSTEMS } = require('./pcm-contract');
const EVENT_TAG = 'urn:pcm:sandbox:consent-cancellation';
const STATES = Object.freeze({
    requested: ['Requested', 'Awaiting a decision. The owning provider may cancel this request.'],
    active: ['Active', 'Approved within its current period and operational prerequisites.'],
    rejected: ['Rejected', 'Cannot be restored. Submit a new request for approval.'],
    'temporarily-inactive': ['Temporarily inactive', 'PCM may restore access when the blocking condition clears within the existing approval period.'],
    'permanently-inactive': ['Permanently inactive', 'Cannot be restored. A new request and approval are needed.'],
    'service-provider-cancelled': ['Service Provider cancelled', 'Permanently cancelled by the requesting provider. A new request and approval are needed.']
});

/** Return one validated PCM business status, or null when missing/ambiguous/unknown. */
function businessStatus(consent) {
    const values = (consent?.extension || []).filter(item => item.url === EXTENSIONS.consentBusinessStatus);
    const coding = values.length === 1 && values[0].valueCoding;
    return coding?.system === CODE_SYSTEMS.consentBusinessStatus && Object.hasOwn(STATES, coding.code) ? coding.code : null;
}

/** Project state without interpreting lastUpdated or a terminal code as a historical cause.
 * @param {object} consent Authoritative FHIR Consent.
 * @param {number} now Current epoch milliseconds.
 * @param {object[]} events Detached authoritative events from the owning private lifecycle repository.
 * @returns {object} UI-only status, period, explanation and evidence.
 */
function consentStatus(consent, now = Date.now(), events = []) {
    const code = businessStatus(consent);
    const [label, restoration] = STATES[code] || ['Unknown / unrecorded', 'The consent status is unavailable. Refresh the page. If it remains unavailable, ask the sandbox administrator to investigate.'];
    const period = consent?.provision?.period || {};
    const expired = Number.isFinite(Date.parse(period.end)) && Date.parse(period.end) <= now;
    let event = null;
    try {
        const candidate = events.filter(item => ['provider-cancellation', 'status-change'].includes(item.kind)
            || item.newState === code).at(-1);
        if (candidate && candidate.consentId === consent.id && candidate.newState === code && /^[1-9][0-9]*$/.test(candidate.version)
            && Number(candidate.version) <= Number(consent.meta?.versionId)
            && Number.isFinite(Date.parse(candidate.at)) && typeof candidate.operator === 'string' && typeof candidate.provider === 'string') event = candidate;
    } catch { /* A malformed note is not authoritative event evidence. */ }
    const recordedCause = { 'approval-period-expired': 'Approval period expired (recorded PCM expiry)', 'service-suspended': 'Service suspension', 'service-cancelled': 'Service cancellation', 'service-active': 'Service restored' }[event?.cause];
    const cause = recordedCause || (code === 'service-provider-cancelled' ? 'Provider cancellation'
        : code === 'active' && expired ? 'Approval period expired'
        : code === 'active' ? 'Current approval is active; no terminal status change is recorded'
        : code === 'requested' ? 'Awaiting explicit review (unless the labelled test exception applies)'
        : 'Cause unknown / unrecorded');
    const description = code === 'active' && expired ? 'The approval period has ended. Further access requires a new request and approval.' : {
        requested: 'Awaiting a decision. Review the request, then approve or decline it.',
        active: 'PCM records this consent as active. Data access also depends on the approval dates, service availability and enabled access checks.',
        rejected: 'This request was declined. A new request is needed to seek approval again.',
        'temporarily-inactive': 'Access under this consent is temporarily blocked. PCM may reactivate it if the blocking condition clears before the approval expires.',
        'permanently-inactive': 'This consent can no longer be used. Further access requires a new request and approval.',
        'service-provider-cancelled': 'Cancelled by the requesting organization. This cannot be undone; further access requires a new request and approval.'
    }[code] || restoration;
    return { code, label, fhirStatus: consent?.status || 'unknown', restoration, cause, description,
        periodStart: period.start || 'Unrecorded', periodEnd: period.end || 'Unrecorded',
        periodExpired: expired, event,
        changedAt: event?.at || 'Unrecorded (resource lastUpdated is not a status-change time)',
        initiator: event ? `${event.operator} acting as ${event.provider}` : 'Unknown / unrecorded' };
}
module.exports = { EVENT_TAG, businessStatus, consentStatus };
