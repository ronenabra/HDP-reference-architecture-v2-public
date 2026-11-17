'use strict';

/** Closed sandbox clinical grant policy, independent of downstream simulation controls. */
const crypto = require('crypto');
const { BUCKET_RESOURCES } = require('./clinical-resource-mapping');
const CLINICAL_TYPES = Object.freeze(['Patient', ...new Set(Object.values(BUCKET_RESOURCES).flatMap(bucket => Object.keys(bucket)))]);
const FULL_SERVICE_TAG = 'urn:pcm:sandbox:full-clinical-access';

/** Retired bypass defaults are always off; explicit saved scopes own permission. */
function presetGrantDefault(_preset) { return false; }

/** Reject the old flag even when false so retained configuration needs review. */
function clinicalGrantPolicy(config = {}) {
    if (Object.hasOwn(config.sandbox || {}, 'grantFullClinicalAccess')) {
        throw new TypeError('sandbox.grantFullClinicalAccess is retired; use an explicitly approved scope and coordinated config migration');
    }
    return { grantFullClinicalAccess: false, locked: true, supportedResources: CLINICAL_TYPES, cacheMaximumSeconds: 30 };
}

/** Legacy compiler callers cannot obtain hidden permissions from tags or presets. */
function clinicalGrantDecision(config, _store, _service) {
    clinicalGrantPolicy(config);
    return Object.freeze({ fullAccess: false, reason: 'explicit-approved-scope',
        fingerprint: crypto.createHash('sha256').update('pcm-explicit-grants/1').digest('hex') });
}

/** Explicit read/search union; writes, wildcard and version history are absent. */
function fullClinicalScope() { return CLINICAL_TYPES.map(type => `patient/${type}.rs`).join(' '); }
module.exports = { CLINICAL_TYPES, FULL_SERVICE_TAG, clinicalGrantDecision, clinicalGrantPolicy, fullClinicalScope, presetGrantDefault };
