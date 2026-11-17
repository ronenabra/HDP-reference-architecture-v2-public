/**
 * Patient access checks for the built-in DS FHIR mock server.
 */
const crypto = require('crypto');
const path = require('path');

function loadIdentityMappingHelpers() {
    const candidates = [
        ...(process.env.SHARED_IDENTITY_MAPPING_DIR ? [path.join(process.env.SHARED_IDENTITY_MAPPING_DIR, 'identity-mapping')] : []),
        path.join(__dirname, '..', '..', 'shared', 'identity-mapping'),
        '/shared/identity-mapping'
    ];
    for (const candidate of candidates) {
        try { return require(candidate); } catch (err) { /* try next layout */ }
    }
    throw new Error('Unable to load shared identity mapping helpers');
}

const { getEffectiveBusinessIdOverrides, cleanLocalSubject } = loadIdentityMappingHelpers();

const UNRESOLVED_PATIENT_OPERATION_OUTCOME = Object.freeze({
    resourceType: 'OperationOutcome',
    issue: [
        {
            severity: 'error',
            code: 'security',
            details: {
                coding: [
                    {
                        system: 'http://fhir.health.gov.il/CodeSystem/operation-outcome-codes',
                        code: 'patient-context-unresolved',
                        display: 'Patient context could not be resolved'
                    }
                ],
                text: 'The patient context in the access token could not be resolved to a Patient record on this FHIR server.'
            },
            diagnostics: 'The access token is valid for this server, but the patient context is no longer resolvable. The service provider should contact PCM/support out of band.'
        }
    ]
});

function cloneOperationOutcome() {
    return JSON.parse(JSON.stringify(UNRESOLVED_PATIENT_OPERATION_OUTCOME));
}

/** Patient mapping remains mandatory for any diagnostic context resolution. */
function isMappedPatientEnforcementEnabled(_config = {}) { return true; }

function allowedMappedPatientSubjects(config = {}) {
    return new Set(Object.values(getEffectiveBusinessIdOverrides(config))
        .map(cleanLocalSubject)
        .filter(Boolean));
}

function isPatientContextResolved(patientRef, config = {}) {
    if (!isMappedPatientEnforcementEnabled(config)) return true;
    const allowedSubjects = allowedMappedPatientSubjects(config);
    return allowedSubjects.has(cleanLocalSubject(patientRef));
}

/** The compatibility distribution has no qualified clinical scope engine. */
function permitsClinicalContext(_context) { return false; }

/** Preserve the facade's configured mapping without trusting a token-supplied logical ID. */
function localPatientReference(identifier, hoId, config) {
    const overrides = getEffectiveBusinessIdOverrides(config);
    const mapped = overrides[`${identifier.system}|${identifier.value}`]
        || (identifier.system === 'http://fhir.health.gov.il/identifier/il-national-id' ? overrides[identifier.value] : null);
    if (mapped) return cleanLocalSubject(mapped);
    return `Patient/${crypto.createHash('sha256').update(`${hoId}\u0000${identifier.system}\u0000${identifier.value}`).digest('hex')}`;
}

module.exports = {
    permitsClinicalContext,
    localPatientReference,
    allowedMappedPatientSubjects,
    cloneOperationOutcome,
    isMappedPatientEnforcementEnabled,
    isPatientContextResolved
};
