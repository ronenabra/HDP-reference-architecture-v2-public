'use strict';
/** Merge freshly polled Consents without retaining endpoints, tokens or data from an old source set. */
const { businessStatus } = require('../../shared/consent-status');
const SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType';
/** Return a stable exact CST membership signature, including the empty source set. */
function sourceSignature(consent) {
    return JSON.stringify((consent?.provision?.actor || []).filter(actor => actor.role?.coding?.some(code => code.system === SYSTEM && code.code === 'CST'))
        .map(actor => actor.reference?.reference).sort());
}
/** Compare ordinary permission/context bytes without inferring or repairing authority. */
function permissionSignature(consent) {
    const { EXTENSIONS } = require('../../shared/pcm-contract');
    const urls = new Set([EXTENSIONS.pcmService]);
    return JSON.stringify([consent?.id, consent?.identifier, consent?.patient, consent?.category, consent?.provision?.period, (consent?.extension || []).filter(value => urls.has(value.url))]);
}
/** Refresh endpoint discovery on membership changes; failed discovery clears all old endpoint/data projections. */
async function refreshConsent(record, consent, { discover, resetCache }) {
    if (Number(consent.meta?.versionId) < Number(record.consent?.meta?.versionId)) return false;
    const lifecycleChanged = (record.consent?.status && record.consent.status !== 'unknown' && record.consent.status !== consent.status)
        || businessStatus(record.consent) !== businessStatus(consent);
    const changed = lifecycleChanged || permissionSignature(record.consent) !== permissionSignature(consent) || sourceSignature(record.consent) !== sourceSignature(consent);
    if (changed) {
        const revision = record.sourceRevision = (record.sourceRevision || 0) + 1;
        resetCache(record.owner); record.data = null; record.tokenGrant = null; record.tokenStatus = null; record.authorityBlocked = false; record.validationError = null; record.selectedEndpoint = null;
        record.consent = consent;
        if (consent.status && consent.status !== 'active') return true;
        try {
            const expanded = await discover(consent.id, record.owner);
            if (record.sourceRevision === revision && expanded && sourceSignature(expanded) === sourceSignature(consent)) record.consent = expanded;
        }
        catch (_) { /* The raw polled Consent remains visible, with no stale endpoint or clinical data. */ }
    } else {
        const { discoveredEndpoint, discoveredEndpoints } = record.consent || {};
        record.consent = { ...consent, ...(discoveredEndpoint ? { discoveredEndpoint } : {}), ...(discoveredEndpoints ? { discoveredEndpoints } : {}) };
    }
    return changed;
}
module.exports = { refreshConsent, sourceSignature, permissionSignature };
