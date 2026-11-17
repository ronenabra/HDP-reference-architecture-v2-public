'use strict';

/** Explicit private sandbox alternatives, completed before one approval decision. */
const crypto = require('node:crypto');
const { BUCKET_RESOURCES } = require('../../shared/clinical-resource-mapping');
const { basedOnId } = require('./fhir/healthcare-service-lifecycle');
const { serviceBuckets, compileConsentScope } = require('./grant-compiler');
const { confidentialityFilters } = require('../../shared/service-confidentiality-policy');
const { COMPILER } = require('../../shared/service-grant');
const { approvalDiagnostics } = require('../../shared/consent-scope-snapshot');
const { scopeWarnings } = require('../../shared/ui/approval-scopes');
const secret = crypto.randomBytes(32);

/** Generate two complete, deliberately broader options independently of narrowing controls. */
function approvalScopeOptions(store, service, { now = Math.floor(Date.now() / 1000) } = {}) {
    const canonical = store.get('HealthcareService', basedOnId(service));
    if (!canonical) throw Object.assign(new Error('Service definition is missing.'), { status: 409 });
    const definition = require('./public-fhir').requireDefinition(store, service);
    const retained = definition.grant;
    const buckets = serviceBuckets(store, service);
    const types = ['Patient', ...new Set(buckets.flatMap(bucket => Object.keys(BUCKET_RESOURCES[bucket.coding.code])))];
    const coarse = [...types.map(type => `patient/${type}.rs`), ...(definition.includeMasterData ? require('../../shared/service-master-data').TYPES.map(type => `patient/${type}.r`) : [])].join(' ');
    // Resource generation deliberately drops category/history/sensitivity predicates.
    // Mandatory confidentiality predicates still accompany each union alternative.
    const policy = definition.confidentialityPolicy || { allowRestricted: false };
    const resources = coarse.split(' ').map(scope => `${scope}?${confidentialityFilters(policy).join('&')}`).join(' ');
    const bucketScope = compileConsentScope({ store, service, scope: coarse, approved: coarse, now, reusable: true }).split(' ').map(scope => {
        const [head, query = ''] = scope.split('?');
        return `${head}?${[...new Set([...query.split('&').filter(Boolean), ...confidentialityFilters(policy)])].join('&')}`;
    }).join(' ');
    const options = [
        { id: 'service-provided', kind: 'service', label: 'Use the service’s permissions', value: retained?.scope ?? '',
            origin: retained?.origin ?? 'missing-legacy-definition', anchor: retained?.anchor ?? new Date(now * 1000).toISOString(),
            historyMode: retained?.historyMode ?? 'missing', generator: retained?.compiler ?? null,
            description: retained ? 'Uses the exact saved service permissions and fixed record dates. Approval saves this choice for this consent.' : 'No versioned service default exists. This choice saves an unusable empty decision; create a new service definition or explicitly choose an alternative.' },
        { id: 'auto-resources', kind: 'generated', label: 'All records of the service’s resource types', value: resources,
            description: 'Deliberate broader sandbox override: read/search for service resource types, without category, sensitive-category or record-date limits. R and V exclusions still follow the service setting.' },
        { id: 'auto-buckets', kind: 'generated', label: 'Service categories with dates recalculated for this approval', value: bucketScope,
            description: 'Rebuilds read/search permissions from the service categories and sensitive-data settings, with fixed record dates calculated for this review. This may grant more access than the service default.' }
    ];
    return options.map(option => ({ anchor: new Date(now * 1000).toISOString(), historyMode: 'approval-fixed', generator: COMPILER,
        ...option, diagnostics: approvalDiagnostics(option.value) }));
}

/** Preserve the caller's explicit choice; equal text does not erase manual provenance. */
function scopeSelection(value, options, choice) {
    if (choice === 'custom') return { id: 'custom', kind: 'custom', label: 'Manual override' };
    const match = options.find(option => (choice ? option.id === choice : option.value === value) && option.value === value);
    return match ? { id: match.id, kind: match.kind, label: match.label } : { id: 'custom', kind: 'custom', label: 'Manual override' };
}

/** Show snapshot provenance only; old text is explicitly unusable, never inferred. */
function approvedScopeOrigin(consent, store) {
    const saved = store?.privateRecords.approvals.getDecision(consent.id)?.snapshot;
    return saved ? `${saved.origin}: ${saved.choice}` : 'Missing legacy approval snapshot — unusable; obtain a new approval';
}

/** Bind a displayed exact menu to Consent/service versions and its generation instant. */
function approvalReview(store, consent, anchor = new Date().toISOString()) {
    const service = store.get('HealthcareService', require('./fhir/consent-lifecycle').consentServiceId(consent));
    const canonical = store.get('HealthcareService', basedOnId(service));
    const versions = { consent: consent.meta?.versionId, service: service?.meta?.versionId, canonical: canonical?.meta?.versionId };
    const payload = JSON.stringify([consent.id, versions, anchor, require('./migration-checkpoint').sessionEpoch()]);
    return { anchor, versions, proof: crypto.createHmac('sha256', secret).update(payload).digest('base64url') };
}

/** Reject stale/forged displays before generating the exact reviewed alternative. */
function validateApprovalReview(store, consent, review, now = new Date()) {
    if (!review || typeof review.anchor !== 'string' || !Number.isFinite(Date.parse(review.anchor))
        || Date.parse(review.anchor) > now.getTime() || now.getTime() - Date.parse(review.anchor) > 900000) throw Object.assign(new Error('Approval review expired; refresh and review the exact scope.'), { status: 409 });
    const expected = approvalReview(store, consent, review.anchor);
    if (JSON.stringify(expected.versions) !== JSON.stringify(review.versions) || typeof review.proof !== 'string'
        || Buffer.byteLength(review.proof) !== Buffer.byteLength(expected.proof)
        || !crypto.timingSafeEqual(Buffer.from(review.proof), Buffer.from(expected.proof))) throw Object.assign(new Error('Consent or service changed; refresh approval review.'), { status: 409 });
    return Date.parse(review.anchor) / 1000;
}
module.exports = { approvalScopeOptions, approvedScopeOrigin, scopeSelection, scopeWarnings, approvalReview, validateApprovalReview };
