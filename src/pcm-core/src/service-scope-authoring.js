'use strict';
/** Creation-time service scopes, lossless manual alternatives and detached display. */
const { EXTENSIONS, SANDBOX_EXTENSIONS } = require('../../shared/pcm-contract');
const { compileConsentScope } = require('./grant-compiler');
const { URL, MODEL, COMPILER, inspectScope, readServiceGrant } = require('../../shared/service-grant');

/** Validate the bounded text envelope while preserving diagnostic experimental input.
 * @param {string} text Exact manual expression.
 * @returns {string} Exact bounded input, without lexical or authority normalization.
 */
function validateScope(text) {
    if (typeof text !== 'string' || !text.length || text.length > 16384) {
        throw Object.assign(new TypeError('Scopes require nonempty text, at most 16384 characters.'), { status: 400 });
    }
    return text;
}

/** Offer bounded lexical hints only; runtime authority analysis remains separate.
 * @param {string} text Exact final scope, never repaired or normalized.
 * @returns {object} Advisory syntax result without policy or source-capability claims.
 */
function advisoryScope(text) {
    validateScope(text);
    const issues = [];
    for (const token of text.trim().split(/\s+/)) {
        if (issues.length === 8) break;
        const match = /^(patient|system)\/([A-Z][A-Za-z0-9]*|\*)\.([cruds]+)(?:\?(.+))?$/.exec(token);
        if (!match || new Set(match[3]).size !== match[3].length) issues.push('A clause does not match SMART resource-scope syntax. Exact text will still be saved.');
        else if (match[4]?.split('&').some(filter => !/^[^=&\s]+=[^=&\s]+$/.test(filter) || /%(?![A-Fa-f0-9]{2})/.test(filter))) issues.push('A search predicate has unusual syntax. Exact text will still be saved.');
    }
    return { syntax: issues.length ? 'warning' : 'no-basic-issues', issues };
}

/** Freeze a generated scope or exact complete override at one creation anchor.
 * @param {object} request Validated ordinary definition with legacy option metadata.
 * @param {object} input Original readable authoring choices, retained as provenance.
 * @param {object} options Injected Unix-second authoring clock.
 * @returns {object} Owned FHIR extension containing the final immutable definition.
 */
function serviceGrantExtension(request, input, { now = Math.floor(Date.now() / 1000) } = {}) {
    if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now * 1000).getTime())) throw Object.assign(new TypeError('Invalid service creation clock.'), { status: 400 });
    const option = request.extension.find(item => item.url === SANDBOX_EXTENSIONS.approvalScopeOption);
    const coarse = option.extension.find(item => item.url === 'scope').valueString;
    const origin = input.scopeOrigin || 'generated';
    const scope = origin === 'custom' ? input.approvalScope : compileConsentScope({
        store: { get: () => request }, service: { extension: [{ url: EXTENSIONS.basedOnCanonicalHealthcareService,
            valueReference: { reference: 'HealthcareService/creation' } }] },
        scope: coarse, approved: coarse, now, reusable: true
    });
    const grant = { model: MODEL, compiler: COMPILER, origin, scope, anchor: new Date(now * 1000).toISOString(),
        historyMode: origin === 'custom' ? 'manual-literal' : 'creation-fixed', authoring: structuredClone(input), diagnostics: inspectScope(scope).diagnostics };
    return { url: URL, valueString: JSON.stringify(grant) };
}

/** Display retained final text; neither reads nor later clocks compile it again.
 * @param {object} request Newly built or previously stored service definition.
 * @returns {object} Versioned exact preview, separate history/duration and diagnostics.
 */
function previewDefinition(request) {
    const grant = readServiceGrant(request);
    if (!grant) throw new TypeError('Legacy service has no final grant; an explicit new definition is required.');
    const parsed = grant.origin === 'custom' ? null : inspectScope(grant.scope);
    return { version: 2, model: grant.model, compiler: grant.compiler, calculatedAt: grant.anchor,
        origin: grant.origin, savedScope: grant.scope, effectiveScope: grant.scope,
        requestCeiling: parsed?.requestCeiling ?? null, diagnostics: grant.origin === 'custom' ? advisoryScope(grant.scope) : grant.diagnostics,
        history: { mode: grant.historyMode, anchor: grant.anchor, buckets: grant.authoring.buckets },
        access: { mode: grant.authoring.accessMode, duration: grant.authoring.duration, unit: grant.authoring.durationUnit },
        interpretation: parsed ? `Generated from ${grant.authoring.buckets.length} data categories and ${grant.authoring.permissions.length} resource choices. Review the exact scope above.` :
            'Exact manual override replaces the generator. Syntax advice does not establish runtime authority.',
        policy: { fullClinicalAccess: false, reason: 'Saved service scopes do not depend on the security preset.' } };
}

/** Validate ordinary wire metadata against its original authoring and creation anchor.
 * @param {object} request Incoming complete definition or catalog-update proposal.
 * @returns {void} Throws on forged scope/provenance or contradictory definition fields.
 */
function assertServiceGrant(request) {
    const grant = readServiceGrant(request);
    if (!grant) return;
    const rebuilt = require('./service-definition-form').serviceDefinitionDraft(grant.authoring,
        { now: Date.parse(grant.anchor) / 1000, internalValidation: true });
    const protectedUrls = new Set([URL, SANDBOX_EXTENSIONS.approvalScopeOption,
        require('../../shared/service-confidentiality-policy').URL, require('../../shared/service-master-data').URL,
        EXTENSIONS.informationBucket, EXTENSIONS.accessMode, EXTENSIONS.accessDuration, EXTENSIONS.allowPatientBucketChange]);
    const project = resource => (resource.extension || []).filter(item => protectedUrls.has(item.url))
        .map(item => JSON.stringify(item)).sort();
    if (JSON.stringify(project(request)) !== JSON.stringify(project(rebuilt))) throw new TypeError('Service grant differs from its creation scope, authoring inputs or provenance. Submit a new definition.');
}
module.exports = { validateScope, advisoryScope, previewDefinition, serviceGrantExtension, assertServiceGrant };
