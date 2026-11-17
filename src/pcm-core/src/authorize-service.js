'use strict';

/** Standalone SMART authorization protocol validation and decision service. */

const SMART_SCOPE_PATTERN = /^patient\/(\*|[A-Z][A-Za-z0-9]*)\.([cruds]+)(?:\?([^#\s]+))?$/;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const AUTHORIZATION_PARAMETERS = new Set([
    'response_type',
    'response_mode',
    'client_id',
    'redirect_uri',
    'scope',
    'state',
    'code_challenge',
    'code_challenge_method',
    'aud'
]);

function singleString(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function parsePatientScope(scope) {
    if (typeof scope !== 'string' || !scope || scope.trim() !== scope || scope.includes('  ')) return null;
    const tokens = scope.split(' ');
    if (new Set(tokens).size !== tokens.length) return null;
    const parsed = [];
    for (const token of tokens) {
        const match = SMART_SCOPE_PATTERN.exec(token);
        if (!match) return null;
        const [, resource, permissions, query] = match;
        if (new Set(permissions).size !== permissions.length) return null;
        if (query) {
            if (resource === '*') return null;
            for (const constraint of query.split('&')) {
                const separator = constraint.indexOf('=');
                if (separator <= 0 || separator === constraint.length - 1) return null;
                const name = constraint.slice(0, separator);
                if (name === '_filter' || name.startsWith('_filter:')
                    || !/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)) return null;
            }
        }
        parsed.push({ token, resource, permissions: new Set(permissions), query: query || '' });
    }
    return parsed;
}

function scopeTokenWithin(candidate, ceiling) {
    if (ceiling.resource !== '*' && candidate.resource !== ceiling.resource) return false;
    if ([...candidate.permissions].some(permission => !ceiling.permissions.has(permission))) return false;
    if (ceiling.query && candidate.query !== ceiling.query) return false;
    return true;
}

function scopesWithin(candidateScopes, ceilingScopes) {
    const candidates = parsePatientScope(candidateScopes);
    const ceilings = Array.isArray(ceilingScopes)
        ? ceilingScopes.flatMap(scope => parsePatientScope(scope) || [])
        : parsePatientScope(ceilingScopes);
    if (!candidates || !ceilings?.length) return false;
    return candidates.every(candidate => ceilings.some(ceiling => scopeTokenWithin(candidate, ceiling)));
}

function redirectLocation(redirectUri, values) {
    const location = new URL(redirectUri);
    for (const [key, value] of Object.entries(values)) {
        if (value !== undefined && value !== null && value !== '') location.searchParams.set(key, value);
    }
    return location.toString();
}

function oauthError(error, description, safeRedirect = null, state = null) {
    if (safeRedirect) {
        return {
            type: 'redirect',
            location: redirectLocation(safeRedirect, { error, error_description: description, state })
        };
    }
    return { type: 'error', status: 400, body: { error, error_description: description } };
}

/** Private browser capability shared with the maintained HMO sign-in page. */
function browserHash(req) {
    const binding = require('./system-browser-session').cookie(req, 'pcmSystemBrowser');
    return binding && /^[A-Za-z0-9_-]{43}$/.test(binding) ? require('node:crypto').createHash('sha256').update(binding).digest('hex') : null;
}

/** Build the shared protocol service used by interactive and automated flows. */
function createAuthorizeService(options) {
    const { findClient, store, identityProvider, getFhirAudience } = options || {};
    if (typeof findClient !== 'function' || !store?.beginAuthorization || !identityProvider?.resolve
        || typeof getFhirAudience !== 'function') {
        throw new Error('Authorize service requires client, store, identity, and audience providers');
    }

    /** Revalidate the immutable request against live registration and current identity. */
    function pending(transactionId, req) {
        const request = store.peekAuthorization?.(transactionId), client = request && findClient(request.clientId);
        if (!request || !request.browserHash || request.browserHash !== browserHash(req)
            || client?.role !== 'service-provider' || client.authorizationCodeGrant !== true
            || !client.redirectUris.includes(request.redirectUri) || request.audience !== getFhirAudience(req)
            || !scopesWithin(request.scope.join(' '), client.smartScopes)) return null;
        return { request, client };
    }
    function interaction(transactionId, client, scopes, req) {
        const patients = identityProvider.listChoices(req);
        const self = identityProvider.resolve('authenticated-self', req);
        const eligible = !self || !store.bindAuthorizationSelf || store.bindAuthorizationSelf(transactionId, self);
        return { type: 'interaction', transactionId, clientName: client.name, scopes,
            patients: eligible ? patients : patients.filter(patient => patient.subject !== 'authenticated-self'),
            technical: { clientId: client.clientId, callback: store.read?.('auth-request', transactionId)?.redirectUri,
                audience: store.read?.('auth-request', transactionId)?.audience, pkce: 'S256' },
            selfChanged: !eligible };
    }
    return {
        /** Resume the same pending decision; no code, approval, consume or lifetime extension. */
        resume(transactionId, req) {
            const current = pending(transactionId, req);
            return current ? interaction(transactionId, current.client, current.request.scope, req)
                : oauthError('invalid_request', 'This pending SMART request expired, was used, changed registration, or belongs to another browser. Restart from Doctor.');
        },
        /** Validate a private continuation without binding or revealing an identity. */
        canResume(transactionId, req) { return !!pending(transactionId, req); },
        /** Validate an authorization request and create an interactive decision. */
        start(query, req) {
            const unknown = Object.keys(query || {}).find(name => !AUTHORIZATION_PARAMETERS.has(name));
            const clientId = singleString(query?.client_id);
            const redirectUri = singleString(query?.redirect_uri);
            const client = clientId ? findClient(clientId) : null;
            const registeredRedirects = client?.redirectUris || [];
            const safeRedirect = client && redirectUri && registeredRedirects.includes(redirectUri)
                ? redirectUri
                : null;
            const state = singleString(query?.state);

            if (!client || client.role !== 'service-provider' || client.authorizationCodeGrant !== true) {
                return oauthError('unauthorized_client', 'Client is not registered for standalone SMART authorization');
            }
            if (!safeRedirect) return oauthError('invalid_request', 'redirect_uri must exactly match a registered URI');
            if (unknown) return oauthError('invalid_request', 'Authorization request contains an unsupported parameter', safeRedirect, state);
            if (query.response_type !== 'code') {
                return oauthError('unsupported_response_type', 'response_type must be code', safeRedirect, state);
            }
            if (query.response_mode !== undefined && query.response_mode !== 'query') {
                return oauthError('invalid_request', 'Only query response mode is supported', safeRedirect, state);
            }
            if (!state) return oauthError('invalid_request', 'state is required', safeRedirect);
            if (!singleString(query.code_challenge) || !PKCE_CHALLENGE_PATTERN.test(query.code_challenge)) {
                return oauthError('invalid_request', 'A valid S256 code_challenge is required', safeRedirect, state);
            }
            if (query.code_challenge_method !== 'S256') {
                return oauthError('invalid_request', 'code_challenge_method must be S256', safeRedirect, state);
            }
            const expectedAudience = getFhirAudience(req);
            if (query.aud !== expectedAudience) {
                return oauthError('invalid_request', 'aud must equal the exact PCM FHIR base', safeRedirect, state);
            }
            const requestedScopes = parsePatientScope(query.scope);
            if (!requestedScopes || !scopesWithin(query.scope, client.smartScopes)) {
                return oauthError('invalid_scope', 'Only registered patient-level SMART v2 scopes are supported', safeRedirect, state);
            }

            const transactionId = store.beginAuthorization({
                clientId,
                redirectUri,
                state,
                scope: requestedScopes.map(item => item.token),
                codeChallenge: query.code_challenge,
                audience: expectedAudience,
                browserHash: browserHash(req)
            });
            return interaction(transactionId, client, requestedScopes.map(item => item.token), req);
        },

        /** Apply an interactive approval, denial, or cancellation decision. */
        decide(input, req) {
            const transactionId = singleString(input?.transaction_id);
            const before = transactionId && store.peekAuthorization?.(transactionId);
            if (before?.browserHash && !pending(transactionId, req)) return oauthError('invalid_request', 'This request belongs to another browser or its registration changed. Restart from Doctor.');
            const request = transactionId ? store.consumeAuthorization(transactionId) : null;
            if (!request) return oauthError('invalid_request', 'Authorization transaction is unknown, expired, or already used');

            if (input.decision === 'deny' || input.decision === 'cancel') {
                return oauthError('access_denied', input.decision === 'cancel' ? 'The test launch was cancelled.' : 'The test launch was denied.', request.redirectUri, request.state);
            }
            if (input.decision !== 'approve') {
                return oauthError('invalid_request', 'Authorization decision is invalid', request.redirectUri, request.state);
            }

            const patient = identityProvider.resolve(singleString(input.patient), req);
            const approvedScope = Array.isArray(input.approved_scope)
                ? input.approved_scope
                : (singleString(input.approved_scope) ? [input.approved_scope] : []);
            const approvedScopeString = approvedScope.join(' ');
            if (input.patient === 'authenticated-self' && patient && JSON.stringify(store.read('auth-self', transactionId)?.patient) !== JSON.stringify(patient)) return oauthError('access_denied', 'Verified identity changed. Restart this test from Doctor.', request.redirectUri, request.state);
            if (!patient) return oauthError('access_denied', 'No configured test identity was selected', request.redirectUri, request.state);
            if (!approvedScope.length || !scopesWithin(approvedScopeString, request.scope)) {
                return oauthError('invalid_scope', 'Approved scope must narrow the requested scope', request.redirectUri, request.state);
            }

            const code = store.issueCode({
                clientId: request.clientId,
                redirectUri: request.redirectUri,
                patient,
                scope: approvedScope,
                codeChallenge: request.codeChallenge,
                audience: request.audience
            });
            return {
                type: 'redirect',
                location: redirectLocation(request.redirectUri, { code, state: request.state })
            };
        }
    };
}

module.exports = {
    AUTHORIZATION_PARAMETERS,
    PKCE_CHALLENGE_PATTERN,
    SMART_SCOPE_PATTERN,
    createAuthorizeService,
    oauthError,
    parsePatientScope,
    redirectLocation,
    scopesWithin,
    singleString
};
