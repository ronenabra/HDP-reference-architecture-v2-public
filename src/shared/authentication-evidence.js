'use strict';

/** Closed certificate evidence for strict OAuth and the authorized local simulation exception. */
const VERSION = 'pcm-authentication-simulation/1';
const TRANSPORT = 'token-endpoint-mtls';
const SIGNATURE = 'client-assertion-signature';
const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;

/** Require one exact JSON object shape; no client-supplied extra evidence is accepted. */
function exact(value, names) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

/** Resolve exception permissions from effective PCM transport and selected-source controls. */
function simulationOptions(policy, controls = policy?.simulation?.controls || {}) {
    return { allowSimulation: policy?.mode === 'connectathon',
        allowMissingTransport: policy?.transport?.pcmPublic?.clientAuth === 'tls', controls };
}

/**
 * Normalize observed evidence, rejecting skipped checks unless explicitly permitted.
 * @param {object} value PCM issuance evidence; null roles mean unobserved, never inferred.
 * @param {object} options Effective non-strict permissions, independent of wire input.
 * @returns {object} Closed normalized evidence for existing private consumers.
 */
function normalizeAuthenticationEvidence(value, options = {}) {
    const verified = value?.correlation_verified === true;
    const names = ['token_endpoint_mtls', 'client_assertion_signing', 'correlation_verified'];
    if (!exact(value, verified ? names : [...names, 'simulation'])) throw new Error('Invalid authentication evidence shape');
    const skipped = verified ? [] : value.simulation?.skipped;
    if (!verified && (value.correlation_verified !== false || options.allowSimulation !== true
        || !exact(value.simulation, ['version', 'skipped']) || value.simulation.version !== VERSION
        || !Array.isArray(skipped) || skipped.length < 1 || skipped.length > 2
        || new Set(skipped).size !== skipped.length || skipped.some(check => ![TRANSPORT, SIGNATURE].includes(check))
        || (skipped.includes(TRANSPORT) && options.allowMissingTransport !== true)
        || (skipped.includes(SIGNATURE) && options.controls?.clientAssertionSignature !== false))) {
        throw new Error('Authentication simulation is not permitted by current controls');
    }
    const read = (field, check) => {
        if (skipped.includes(check)) {
            if (value[field] !== null) throw new Error('Skipped authentication role must be null');
            return null;
        }
        if (!exact(value[field], ['x5t#S256']) || !THUMBPRINT.test(value[field]['x5t#S256'])) throw new Error('Invalid observed certificate thumbprint');
        return value[field]['x5t#S256'];
    };
    return { tokenEndpointMtlsThumbprint: read('token_endpoint_mtls', TRANSPORT),
        clientAssertionSigningThumbprint: read('client_assertion_signing', SIGNATURE), correlationVerified: verified,
        ...(!verified ? { simulation: { version: VERSION, skipped: [...skipped] } } : {}) };
}

/** Validate the same evidence after mapping into the private camel-case representation. */
function normalizePrivateAuthentication(value, options) {
    if (!exact(value, value?.correlationVerified === true
        ? ['tokenEndpointMtlsThumbprint', 'clientAssertionSigningThumbprint', 'correlationVerified']
        : ['tokenEndpointMtlsThumbprint', 'clientAssertionSigningThumbprint', 'correlationVerified', 'simulation'])) throw new Error('Invalid private authentication evidence');
    return normalizeAuthenticationEvidence({
        token_endpoint_mtls: value.tokenEndpointMtlsThumbprint === null ? null : { 'x5t#S256': value.tokenEndpointMtlsThumbprint },
        client_assertion_signing: value.clientAssertionSigningThumbprint === null ? null : { 'x5t#S256': value.clientAssertionSigningThumbprint },
        correlation_verified: value.correlationVerified, ...(value.simulation ? { simulation: value.simulation } : {})
    }, options);
}
module.exports = { VERSION, TRANSPORT, SIGNATURE, normalizeAuthenticationEvidence, normalizePrivateAuthentication, simulationOptions };
