'use strict';

/** UI-only first-page evidence. Continuations are recorded, never requested. */
const LIMIT = 10;

/** Summarize one queried resource type without interpreting absent totals as zero. */
function pageEvidence(type, bundle) {
    const entries = (bundle.resourceType === type ? [{ resource: bundle }] : bundle.entry || []).filter(entry => entry.resource?.resourceType === type && entry.search?.mode !== 'include');
    const next = (bundle.link || []).find(link => link.relation === 'next');
    const total = Number.isSafeInteger(bundle.total) && bundle.total >= 0 ? bundle.total : null;
    const count = Math.min(entries.length, LIMIT);
    // A short response without a next link is not proof that an upstream omitted nothing.
    const boundary = next || entries.length > LIMIT || total !== null && total > count ? 'more'
        : total !== null && total === count ? 'complete' : 'unknown';
    const evidence = { type, count, total, boundary, hasNext: Boolean(next) };
    // Keep untrusted continuation bytes private; query strings can contain credentials.
    Object.defineProperty(evidence, 'next', { value: next?.url || null, enumerable: false });
    return evidence;
}

/** Combine bounded successful responses, retaining independent type/source paging evidence. */
function combinePreview(pages, source, failures = []) {
    const types = pages.map(({ type, bundle }) => pageEvidence(type, bundle));
    const entries = pages.flatMap(({ type, bundle }) => (bundle.resourceType === type ? [{ resource: bundle }] : bundle.entry || [])
        .filter(entry => entry.resource?.resourceType === type && entry.search?.mode !== 'include').slice(0, LIMIT));
    const outcome = failures.length ? 'partial' : !entries.length ? 'empty'
        : types.some(type => type.boundary === 'more') ? 'bounded'
        : types.every(type => type.boundary === 'complete') ? 'complete' : 'unknown';
    return { resourceType: 'Bundle', type: 'collection', entry: entries,
        preview: { source, limit: LIMIT, outcome, types, failures } };
}

/** Classify a failed query for visible recovery without claiming absent clinical data. */
function failureEvidence(type, error) {
    const status = error.response?.status;
    const denied = [401, 403].includes(status) || error.classification === 'authorization_failed'
        || ['invalid_grant', 'access_denied', 'invalid_scope', 'insufficient_scope', 'invalid_authorization_details'].includes(error.response?.data?.error);
    return { type, outcome: denied ? 'denied' : 'unavailable',
        status: status || null, message: error.message };
}

module.exports = { LIMIT, pageEvidence, combinePreview, failureEvidence };
