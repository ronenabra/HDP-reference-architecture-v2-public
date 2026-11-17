'use strict';

/**
 * PCM OAuth and SMART discovery documents.
 *
 * PCM verifies participant assertions with non-public registered keys and does
 * not publish a PCM signing-key/JWKS surface.
 */

const { getEffectiveConformancePolicy, loadTeamConfig } = require('./team-config');
const { environmentEndpoints, validateEnvironment, AUTHORIZATION_DETAILS_TYPE, LOGGING_EXCEPTION } = require('../../shared/pcm-environment');

function trimTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

/** Derive the directly observed request origin without trusting forwarding headers. */
function requestIssuer(req) {
    if (!req) return '';
    const host = req.get?.('host');
    return host ? `${req.protocol}://${host}` : '';
}

/** Resolve the canonical public PCM issuer for discovery documents. */
function getIssuer(req, options = {}) {
    const config = options.config || loadTeamConfig();
    const errors = validateEnvironment(config);
    if (errors.length) throw new Error(errors.join('; '));
    const issuer = environmentEndpoints(config.contract.environment).oauthBase;
    if (process.env.PCM_ISSUER && process.env.PCM_ISSUER !== issuer) {
        throw new Error('PCM_ISSUER must exactly match the selected contract environment');
    }
    return issuer;
}

/** Return explicit non-conformance markers when a compatibility profile is active. */
function compatibilityFields(policy) {
    if (!policy.exposure?.notice) return {};
    return {
        pcm_sandbox_mode: 'connectathon',
        pcm_strict_conformance_evidence: false,
        pcm_compatibility_adapters: policy.compatibility.enabledAdapters
    };
}

/** Build the OAuth authorization-server metadata document. */
function getAuthorizationServerMetadata(req, options = {}) {
    const issuer = getIssuer(req, options);
    const policy = options.policy || getEffectiveConformancePolicy();
    return {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        introspection_endpoint: `${issuer}/introspect`,
        grant_types_supported: ['authorization_code', 'client_credentials'],
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        authorization_details_types_supported: [AUTHORIZATION_DETAILS_TYPE],
        pcm_conformance_exceptions: [LOGGING_EXCEPTION],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: policy.assertion.algorithms,
        introspection_endpoint_auth_methods_supported: ['private_key_jwt'],
        introspection_endpoint_auth_signing_alg_values_supported: policy.assertion.algorithms,
        tls_client_certificate_bound_access_tokens: false,
        ...compatibilityFields(policy)
    };
}

/** Build the SMART discovery document from the same canonical endpoint policy. */
function getSmartConfiguration(req, options = {}) {
    const metadata = getAuthorizationServerMetadata(req, options);
    const smart = {
        issuer: metadata.issuer,
        authorization_details_types_supported: metadata.authorization_details_types_supported,
        pcm_conformance_exceptions: metadata.pcm_conformance_exceptions,
        authorization_endpoint: metadata.authorization_endpoint,
        token_endpoint: metadata.token_endpoint,
        introspection_endpoint: metadata.introspection_endpoint,
        grant_types_supported: metadata.grant_types_supported,
        response_types_supported: metadata.response_types_supported,
        response_modes_supported: ['query'],
        token_endpoint_auth_methods_supported: metadata.token_endpoint_auth_methods_supported,
        token_endpoint_auth_signing_alg_values_supported: metadata.token_endpoint_auth_signing_alg_values_supported,
        introspection_endpoint_auth_methods_supported: metadata.introspection_endpoint_auth_methods_supported,
        introspection_endpoint_auth_signing_alg_values_supported: metadata.introspection_endpoint_auth_signing_alg_values_supported,
        tls_client_certificate_bound_access_tokens: false,
        code_challenge_methods_supported: ['S256'],
        capabilities: [
            'launch-standalone',
            'client-confidential-asymmetric',
            'permission-patient',
            'permission-v2'
        ]
    };
    for (const key of ['pcm_sandbox_mode', 'pcm_strict_conformance_evidence', 'pcm_compatibility_adapters']) {
        if (Object.hasOwn(metadata, key)) smart[key] = metadata[key];
    }
    return smart;
}

module.exports = {
    compatibilityFields,
    getAuthorizationServerMetadata,
    getIssuer,
    getSmartConfiguration,
    requestIssuer,
    trimTrailingSlash
};
