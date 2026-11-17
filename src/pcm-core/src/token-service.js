'use strict';

/** Closed, schema-discriminated OAuth token issuance service. */

const { getConfiguredAuthorizationStore } = require('./authorization-store');
const { getPcmAccessTokenExpiresInSeconds, loadTeamConfig } = require('./team-config');
const { organizationIsOperational } = require('./token-authorization');
const { INTERNAL_INVOCATION, resolveGrant } = require('./data-grant');
const { sourceLimits, sourceControls } = require('./source-policy');
const { LOGGING_EXCEPTION } = require('../../shared/pcm-environment');
const { SCOPES } = require('../../shared/pcm-contract');
const { parseAuthorizationDetails, parseScopeCeiling, RequestError } = require('./rar-request');

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const AUTH_CODE_FIELDS = Object.freeze(['grant_type', 'code', 'redirect_uri', 'code_verifier', 'client_assertion_type', 'client_assertion']);
const CLIENT_CREDENTIALS_FIELDS = Object.freeze(['grant_type', 'client_assertion_type', 'client_assertion', 'scope', 'resource']);
const PRESENCE_PATTERN = /^system\/Patient\.s\?identifier=([^|,\s]+\|[^,\s]+)(,[^|,\s]+\|[^,\s]+)*$/;

function oauthError(error, description, status = 400) {
    return { ok: false, status, body: { error, ...(description ? { error_description: description } : {}) } };
}

function hasExactFields(body, fields) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const keys = Object.keys(body);
    return keys.length === fields.length
        && fields.every(field => Object.hasOwn(body, field) && typeof body[field] === 'string');
}

function classifyTokenRequest(body, limits) {
    if (typeof body?.grant_type !== 'string' || !body.grant_type) return oauthError('invalid_request', 'grant_type is required');
    if (body?.grant_type !== 'authorization_code' && body?.grant_type !== 'client_credentials') {
        return oauthError('unsupported_grant_type', 'grant_type is not supported');
    }
    if (body.grant_type === 'authorization_code') {
        if (!hasExactFields(body, AUTH_CODE_FIELDS)) return oauthError('invalid_request', 'Authorization-code request fields are invalid');
        if (!body.code || !body.redirect_uri || !body.code_verifier || body.client_assertion_type !== ASSERTION_TYPE || !body.client_assertion) {
            return oauthError('invalid_request', 'Authorization-code request values are invalid');
        }
        return { ok: true, kind: 'authorization_code', body };
    }
    if (Array.isArray(body.resource)) {
        return oauthError('invalid_target', 'Exactly one resource parameter is required');
    }
    const management = [SCOPES.management, SCOPES.legacyManagement].includes(body.scope);
    if (!hasExactFields(body, management ? CLIENT_CREDENTIALS_FIELDS : [...CLIENT_CREDENTIALS_FIELDS, 'authorization_details'])) {
        return oauthError('invalid_request', 'Client-credentials request fields are invalid');
    }
    if (body.client_assertion_type !== ASSERTION_TYPE || !body.client_assertion || !body.scope || !body.resource) {
        return oauthError('invalid_request', 'Client-credentials request values are invalid');
    }
    if (body.scope === SCOPES.management) return { ok: true, kind: 'management_or_introspection', body };
    if (body.scope === SCOPES.legacyManagement) {
        return { ok: true, kind: 'legacy_management', body };
    }
    try {
        const requested = parseAuthorizationDetails(body.authorization_details, limits);
        parseScopeCeiling(body.scope);
        return { ok: true, kind: requested.basis.type === 'Consent' ? 'data_source_access' : 'system_policy_access', body, requested };
    } catch (error) {
        if (!(error instanceof RequestError)) throw error;
        return oauthError(error.code, error.message);
    }
}

function applyTokenCompatibility(body, policy, logger) {
    if (body?.scope !== SCOPES.legacyManagement) return body;
    if (!policy?.compatibility?.enabledAdapters?.includes('legacy-management-scope-cruds')) return body;
    logger.warn?.('connectathon adapter legacy-management-scope-cruds normalized a management scope', {
        type: 'COMPATIBILITY_ADAPTER',
        code: 'PCM-COMPAT-TOKEN-MANAGEMENT-SCOPE',
        adapter: 'legacy-management-scope-cruds'
    });
    return { ...body, scope: SCOPES.management };
}

function tokenResponse(issued, lifetimeSeconds, scope, details) {
    return {
        access_token: issued.token,
        token_type: 'Bearer',
        expires_in: lifetimeSeconds,
        scope,
        ...(details ? { authorization_details: details } : {})
    };
}

function patientContext(identifier) {
    return identifier ? [{
        type: 'Patient',
        role: 'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-patient',
        identifier
    }] : [];
}

/** Build evidence only from verifier results; skipped roles remain explicitly unobserved. */
function authenticationContext(req, authentication, options = {}) {
    const { VERSION, TRANSPORT, SIGNATURE, normalizeAuthenticationEvidence } = require('../../shared/authentication-evidence');
    if (typeof authentication.transportVerified !== 'boolean' || typeof authentication.signatureVerified !== 'boolean') return null;
    const transport = authentication.transportVerified === true ? req.mtls?.thumbprint : null;
    const signing = authentication.signatureVerified === true ? authentication.assertionSigningThumbprint : null;
    // Verified bare keys have no certificate evidence and cannot become a skipped signature.
    if (authentication.signatureVerified === true && !signing) return null;
    const skipped = [...(!transport ? [TRANSPORT] : []), ...(!signing ? [SIGNATURE] : [])];
    const context = { token_endpoint_mtls: transport ? { 'x5t#S256': transport } : null,
        client_assertion_signing: signing ? { 'x5t#S256': signing } : null,
        correlation_verified: skipped.length === 0,
        ...(skipped.length ? { simulation: { version: VERSION, skipped } } : {}) };
    try { normalizeAuthenticationEvidence(context, options); return context; }
    catch (_) { return null; }
}

/** Create the service with injected stores and time for deterministic tests. */
function createTokenService(options) {
    const {
        tokenStore,
        fhirStore,
        firstUseStore,
        authenticate,
        getIssuer,
        getPolicy,
        getConfig = loadTeamConfig,
        getLifetime = getPcmAccessTokenExpiresInSeconds,
        authorizationStore,
        resolveInvocation = () => null,
        consumeInvocation = () => {},
        logger = console,
        clock = () => Math.floor(Date.now() / 1000)
    } = options;

    return function issue(req) {
        const policy = getPolicy();
        const normalizedBody = applyTokenCompatibility(req.body, policy, logger);
        const limits = sourceLimits(fhirStore, getConfig(), { resource: normalizedBody?.resource });
        // Budget checks precede assertion replay consumption and authorization-code exchange.
        if (req.oauthFormBytes && (req.oauthFormBytes.encoded > limits.maxEncodedFormBytes || req.oauthFormBytes.decoded > limits.maxFormBytes)) {
            return oauthError('invalid_request', 'OAuth form exceeds the source budget');
        }
        const decodedBytes = Object.entries(normalizedBody || {}).reduce((bytes, [name, value], index) =>
            bytes + Buffer.byteLength(name) + Buffer.byteLength(typeof value === 'string' ? value : '') + 1 + (index ? 1 : 0), 0);
        if (decodedBytes > limits.maxFormBytes) return oauthError('invalid_request', 'Decoded OAuth form exceeds the source budget');
        const classified = classifyTokenRequest(normalizedBody, limits);
        if (!classified.ok) return classified;
        if (classified.kind === 'legacy_management') {
            return oauthError('invalid_scope', `${SCOPES.legacyManagement} is not supported`);
        }
        const authentication = authenticate(req, { deferReplay: true });
        if (authentication.errorStatus) {
            return { ok: false, status: authentication.errorStatus, body: authentication.errorBody };
        }
        const { client, decodedAssertion } = authentication;
        const issuer = getIssuer(req);
        const pcmFhirBase = issuer;
        const introspectionEndpoint = `${issuer}/introspect`;
        const now = clock();
        let lifetime = getLifetime(getConfig());
        const pcmAuthenticationContext = authenticationContext(req, authentication, require('../../shared/authentication-evidence').simulationOptions(policy,
            sourceControls(fhirStore, policy, getConfig(), { resource: normalizedBody.resource, clientId: client.clientId })));
        if (!pcmAuthenticationContext) {
            return oauthError('invalid_client', 'Registered client certificate roles are incomplete', 401);
        }
        let kind = classified.kind;
        let claims;
        let committedReplay = false;
        const commitAuthentication = () => {
            if (committedReplay) return true;
            committedReplay = authentication.commitReplay ? authentication.commitReplay() : true;
            return committedReplay;
        };

        if (kind === 'authorization_code') {
            if (client.role !== 'service-provider' || client.authorizationCodeGrant !== true) {
                return oauthError('unauthorized_client', 'Client is not authorized for the authorization-code grant', 401);
            }
            const store = authorizationStore || getConfiguredAuthorizationStore(getConfig());
            if (!commitAuthentication()) return oauthError('invalid_client', 'Assertion jti has already been used', 401);
            const exchanged = store.consumeCode({
                code: normalizedBody.code,
                clientId: client.clientId,
                redirectUri: normalizedBody.redirect_uri,
                codeVerifier: normalizedBody.code_verifier
            });
            if (!exchanged.ok) return oauthError(exchanged.error, exchanged.description);
            const scope = exchanged.grant.scope.join(' ');
            claims = {
                active: true,
                sub: client.clientId,
                client_id: client.clientId,
                organization_id: client.organizationId,
                iss: issuer,
                aud: exchanged.grant.audience,
                scope,
                pcm_authentication_context: pcmAuthenticationContext,
                patient: exchanged.grant.patient,
                fhirContext: patientContext(exchanged.grant.patient)
            };
        } else if (kind === 'management_or_introspection') {
            if (normalizedBody.resource === pcmFhirBase) {
                kind = 'management';
                if (!['service-provider', 'data-source', 'pcm'].includes(client.role) || !client.scopes.includes(SCOPES.management)) {
                    return oauthError('unauthorized_client', 'Client is not authorized for PCM management', 401);
                }
                if (!organizationIsOperational(fhirStore, fhirStore.get('Organization', client.organizationId))) {
                    return oauthError('unauthorized_client', 'Client Organization is not active', 401);
                }
            } else if (normalizedBody.resource === introspectionEndpoint) {
                kind = 'introspection';
                if (client.role !== 'data-source' || !client.scopes.includes('introspection')) {
                    return oauthError('unauthorized_client', 'Client is not an active Data Source introspector', 401);
                }
                if (!organizationIsOperational(fhirStore, fhirStore.get('Organization', client.organizationId))) {
                    return oauthError('unauthorized_client', 'Data Source Organization is not active', 401);
                }
            } else {
                return oauthError('invalid_target', 'resource must exactly identify the PCM FHIR or introspection endpoint');
            }
            claims = {
                active: true,
                sub: client.clientId,
                client_id: client.clientId,
                organization_id: client.organizationId,
                iss: issuer,
                aud: normalizedBody.resource,
                scope: SCOPES.management,
                pcm_authentication_context: pcmAuthenticationContext
            };
            if (client.role === 'data-source') {
                const sourceAuthority = require('./grant-authority-state').sourceClientAuthority(fhirStore, getConfig(), client);
                if (sourceAuthority) claims.source_registration_authority = sourceAuthority;
            }
        } else {
            let grant;
            try {
                grant = resolveGrant({ store: fhirStore, config: getConfig(), firstUseStore, client,
                    requested: classified.requested, scope: normalizedBody.scope, resource: normalizedBody.resource,
                    now, invocation: req[INTERNAL_INVOCATION] || resolveInvocation(client.clientId, decodedAssertion?.jti),
                    controls: sourceControls(fhirStore, policy, getConfig(), { resource: normalizedBody.resource }) });
            } catch (error) {
                if (!(error instanceof RequestError)) throw error;
                logger.warn?.('Data Source token authorization denied', { type: 'TOKEN_AUTHORIZATION_DENIED', decision: 'denied', reason: error.code, authorizationError: error.message,
                    client_id: client.clientId, basis: classified.requested.basis, requestedScope: normalizedBody.scope,
                    audience: normalizedBody.resource, environment: getConfig().contract?.environment, conformanceException: LOGGING_EXCEPTION });
                return oauthError(error.code, error.message, error.code === 'unauthorized_client' ? 401 : 400);
            }
            lifetime = Math.min(lifetime, Math.floor(grant.deadline - now));
            if (lifetime < 1) return oauthError('invalid_authorization_details', 'Authorization has expired');
            const projected = { access_token: 'x'.repeat(36), token_type: 'Bearer', expires_in: lifetime,
                scope: grant.scope, authorization_details: grant.authorization_details };
            // Reserve the larger response shape before issuing state. Opaque tokens are UUIDs.
            if (Buffer.byteLength(JSON.stringify(projected)) > limits.maxResponseBytes) {
                return oauthError('invalid_authorization_details', 'Effective response exceeds the source budget');
            }
            kind = grant.scenario === 'consent-access' ? 'data_source_access'
                : grant.scenario === 'presence-check' ? (classified.requested.patients.length === 1 ? 'presence_online' : 'presence_batch')
                    : grant.scenario === 'sandbox-patient-sample' ? 'sandbox_patient_sample'
                        : grant.scenario === 'patient-authentication' ? 'patient_authentication' : 'dependent_discovery';
            claims = {
                active: true, sub: client.clientId, client_id: client.clientId,
                ...(grant.scenario === 'consent-access' ? { organization_id: client.organizationId } : {}),
                iss: issuer, aud: normalizedBody.resource, scope: grant.scope,
                authorization_details: grant.authorization_details, authorization: grant,
                pcm_authentication_context: pcmAuthenticationContext
            };
        }

        if (!commitAuthentication()) return oauthError('invalid_client', 'Assertion jti has already been used', 401);
        if (claims.authorization?.invocationId) consumeInvocation(client.clientId, decodedAssertion?.jti);
        const issued = tokenStore.issue(kind, claims, lifetime);
        // Detach historical evidence from the store's mutable object graph before
        // handing it to a logger. Never reconstruct it from later introspection.
        // Token records are persisted JSON. A JSON round trip also detaches
        // repeated grant references so the logger cannot mark them as circular.
        const issuanceRecord = JSON.parse(JSON.stringify(issued.record));
        logger.info?.('Opaque access token issued', {
            type: 'TOKEN_ISSUED', kind, client_id: client.clientId,
            access_token: issued.token, issuanceRecord,
            scope: claims.scope, audience: claims.aud, authorization_details: claims.authorization_details,
            clinicalPolicy: claims.authorization?.clinicalPolicy,
            lifetimeSeconds: lifetime, decision: 'issued', conformanceException: LOGGING_EXCEPTION
        });
        return { ok: true, status: 200, body: tokenResponse(issued, lifetime, claims.scope, claims.authorization_details) };
    };
}

module.exports = {
    ASSERTION_TYPE,
    AUTH_CODE_FIELDS,
    CLIENT_CREDENTIALS_FIELDS,
    PRESENCE_PATTERN,
    applyTokenCompatibility,
    classifyTokenRequest,
    createTokenService,
    authenticationContext,
    hasExactFields,
    oauthError
};
