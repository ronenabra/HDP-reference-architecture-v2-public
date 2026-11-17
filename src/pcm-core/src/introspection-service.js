'use strict';

/** Closed OAuth introspection authentication, evaluation, and projection. */

const { resolveGrant, grantStillAllowed, grantContentStillAllowed, VERSION } = require('./data-grant');
const { registeredSourceId, sourceLimits, sourceControls } = require('./source-policy');
const { CODE_SYSTEMS, EXTENSIONS, IDENTIFIER_SYSTEMS, SCOPES, serializeBusinessIdentifier } = require('../../shared/pcm-contract');
const { organizationIsOperational, scopeIsApprovedSubset } = require('./token-authorization');
const { firstUseKey, readFirstUse } = require('./clinical-first-use');
const { participantEndpoint } = require('./fhir/participant-lifecycle');
const { serviceIsOperational } = require('./fhir/healthcare-service-lifecycle');
const { accessMode, consentIsActive } = require('./fhir/consent-lifecycle');

const jwt = require('jsonwebtoken');
const { transportLimits } = require('../../shared/presence-limits');
const { requiresExactSourceMembership } = require('./fhir/sandbox-source-change');

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const ONE_TIME_WINDOW_SECONDS = 60 * 60;
const ACTIVE_CACHE_CEILING_SECONDS = 30;
const CONTEXT_ROLES = Object.freeze({
    Patient: 'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-patient',
    Consent: 'https://pcm.fhir.health.gov.il/fhir-context-role/authorization-basis',
    HealthcareService: 'https://pcm.fhir.health.gov.il/fhir-context-role/healthcare-service'
});
const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;
const ensureArray = value => (Array.isArray(value) ? value : (value ? [value] : []));
const inactive = () => ({ ok: true, status: 200, body: { active: false } });
const oauthError = (status, error, description) => ({
    ok: false,
    status,
    body: { error, ...(description ? { error_description: description } : {}) }
});

function exactBody(body, required, optional = []) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const allowed = new Set([...required, ...optional]);
    return required.every(key => typeof body[key] === 'string' && body[key])
        && Object.keys(body).every(key => allowed.has(key) && typeof body[key] === 'string');
}

/** Select exactly one caller authentication branch before authentication side effects. */
function classifyIntrospectionRequest(req) {
    const authorization = req.get?.('authorization') || req.headers?.authorization;
    const hasBearer = typeof authorization === 'string' && authorization.startsWith('Bearer ');
    const hasAnyAuthorization = authorization !== undefined;
    const hasAssertion = req.body?.client_assertion !== undefined || req.body?.client_assertion_type !== undefined;
    if ((hasBearer && hasAssertion) || (hasAnyAuthorization && !hasBearer)) {
        return oauthError(400, 'invalid_request', 'Exactly one supported introspection caller authentication mode is required');
    }
    if (req.body?.token_type_hint !== undefined && req.body.token_type_hint !== 'access_token') {
        return oauthError(400, 'invalid_request', 'token_type_hint must be access_token');
    }
    if (hasBearer) {
        if (!exactBody(req.body, ['token'], ['token_type_hint'])) {
            return oauthError(400, 'invalid_request', 'Bearer introspection request fields are invalid');
        }
        const pieces = authorization.split(' ');
        if (pieces.length !== 2 || !pieces[1]) return oauthError(401, 'invalid_client', 'Bearer caller credential is invalid');
        return { ok: true, mode: 'bearer', credential: pieces[1] };
    }
    if (hasAssertion) {
        if (!exactBody(req.body, ['token', 'client_assertion_type', 'client_assertion'], ['token_type_hint'])
            || req.body.client_assertion_type !== ASSERTION_TYPE) {
            return oauthError(400, 'invalid_request', 'Direct-assertion introspection request fields are invalid');
        }
        return { ok: true, mode: 'assertion' };
    }
    return oauthError(401, 'invalid_client', 'Introspection caller authentication is required');
}

function officialIdentifier(resource, system) {
    return ensureArray(resource?.identifier).find(identifier => identifier.system === system && identifier.value) || null;
}

function exactAuthenticationContext(value, options) {
    try { require('../../shared/authentication-evidence').normalizeAuthenticationEvidence(value, options); return true; }
    catch (_) { return false; }
}

function referencedEndpoint(store, organization) {
    if (!organizationIsOperational(store, organization)) return null;
    const endpoint = participantEndpoint(store, organization, { requireActive: true });
    return typeof endpoint?.address === 'string' ? endpoint : null;
}

function isOneTimeConsent(consent) {
    return accessMode(consent) === 'one-time';
}

function contextItem(type, identifier) {
    return { type, role: CONTEXT_ROLES[type], identifier: { system: identifier.system, value: identifier.value } };
}

function commonProjection(token, now, authorizationDeadline = Infinity, controls = {}) {
    return {
        active: true,
        scope: token.scope,
        client_id: token.client_id,
        pcm_authentication_context: token.pcm_authentication_context,
        exp: Math.floor(Math.min(controls.tokenExpiry === false ? Infinity : token.exp, now + ACTIVE_CACHE_CEILING_SECONDS, authorizationDeadline)),
        iat: token.iat,
        iss: token.iss,
        aud: token.aud,
        sub: token.sub
    };
}

/** Evaluate frozen authority using only injected state owners for first-use and permanent revocation. */
function evaluateSubjectToken({ token, caller, store, findClient, firstUseStore, now, config = {}, resolveInvocation = () => null, controls = {}, getSourceControls = () => controls, revokeSubject = () => {}, audit = () => {}, ownToken = false, issuer }) {
    // SP diagnostics reevaluate the original authority but never persist a denial or usage.
    if (ownToken) revokeSubject = () => {};
    controls = require('../../shared/conformance-policy').effectiveControls(controls);
    const configuredSourceControls = getSourceControls;
    getSourceControls = id => require('../../shared/conformance-policy').effectiveControls(configuredSourceControls(id));
    const deny = reason => {
        audit({ active: false, reason, kind: token?.kind || 'unknown' });
        return null;
    };
    const allow = response => {
        audit({ active: true, reason: 'authorized', kind: token.kind });
        return response;
    };
    if (token?.revoked) return deny('subject-revoked');
    if (!token || !['data_source_access', 'presence_online', 'presence_batch', 'patient_authentication', 'dependent_discovery', 'sandbox_patient_sample'].includes(token.kind)) return deny('subject-token-kind');
    if (!Number.isSafeInteger(token.exp) || !Number.isSafeInteger(token.iat) || (controls.tokenExpiry !== false && token.exp <= now)) return deny('subject-token-time');
    if (!exactAuthenticationContext(token.pcm_authentication_context,
        require('../../shared/authentication-evidence').simulationOptions(config.conformance?.mode
            ? require('../../shared/conformance-policy').buildEffectivePolicy(config) : {}, getSourceControls(token.authorization?.dataSourceOrganizationId)))) return deny('subject-authentication-context');
    // A retained token never acquires a different audience through source simulation.
    if (token.kind === 'sandbox_patient_sample' || requiresExactSourceMembership(store.get('Consent', token.authorization?.consentId), store)) {
        controls = { ...controls, consentState: true, tokenResourceBinding: true, tokenAudience: true, serviceState: true, tokenExpiry: true };
        if (token.exp <= now) return deny('subject-token-time');
    }
    const callerClient = findClient(caller.clientId);
    if (!callerClient || callerClient.role !== (ownToken ? 'service-provider' : 'data-source') || callerClient.organizationId !== caller.organizationId) return deny('caller-client-binding');
    if (ownToken && (token.client_id !== caller.clientId || token.sub !== caller.clientId || !issuer || token.iss !== issuer)) return deny('subject-owner-issuer');
    const sourceOrganizationId = ownToken ? token.authorization?.dataSourceOrganizationId : caller.organizationId;
    const callerOrganization = store.get('Organization', sourceOrganizationId);
    const endpoint = referencedEndpoint(store, callerOrganization);
    if (!endpoint || (controls.tokenAudience !== false && token.aud !== endpoint.address)) return deny('caller-endpoint-audience');
    if (controls.tokenResourceBinding !== false && (token.authorization?.dataSourceOrganizationId !== sourceOrganizationId
        || token.authorization?.endpointId !== endpoint.id)) return deny('subject-endpoint-authorization');

    const subjectClient = findClient(token.client_id);
    if (!subjectClient || subjectClient.clientId !== token.sub) return deny('subject-client-binding');
    if (!require('./client-assertion').registeredAuthenticationContext(subjectClient, token.pcm_authentication_context)) {
        return deny('subject-certificate-registration');
    }
    if (token.authorization?.version !== VERSION || !token.authorization_details) return deny('legacy-subject-grant');
    if (token.scope !== token.authorization.scope || JSON.stringify(token.authorization_details) !== JSON.stringify(token.authorization.authorization_details)) return deny('subject-grant-integrity');
    const crossSource = token.authorization.dataSourceOrganizationId !== sourceOrganizationId;
    const authorityControls = crossSource ? getSourceControls(token.authorization.dataSourceOrganizationId) : controls;
    const authorityEndpoint = crossSource
        ? referencedEndpoint(store, store.get('Organization', token.authorization.dataSourceOrganizationId)) : endpoint;
    const evaluate = (targetEndpoint, effectiveControls) => resolveGrant({
        store, config, firstUseStore, client: subjectClient,
        requested: token.authorization.requested, scope: token.authorization.requestedScope,
        resource: effectiveControls.tokenAudience === false ? targetEndpoint?.address : token.aud,
        now, compiledAt: token.authorization.compiledAt,
        invocation: token.authorization.invocationId ? resolveInvocation(token.authorization.invocationId, subjectClient.clientId) : null,
        controls: effectiveControls
    });
    // Only the original source's current authority/history can permanently revoke an issued token.
    // A relaxed caller has separate dependencies and cannot replace this frozen source identity.
    let authorityCurrent;
    try {
        if (!authorityEndpoint) throw new Error('Issuing source is unavailable');
        authorityCurrent = evaluate(authorityEndpoint, authorityControls);
    } catch (_) { revokeSubject('subject-current-authorization'); return deny('subject-current-authorization'); }
    if (!grantStillAllowed(token.authorization, authorityCurrent)) { revokeSubject('subject-grant-narrowed'); return deny('subject-grant-narrowed'); }
    let current = authorityCurrent;
    if (crossSource) {
        try { current = evaluate(endpoint, controls); }
        catch (_) { return deny('caller-current-authorization'); }
        // Preserve disabled audience/resource checks without allowing caller-relative generations
        // to become an unconditional binding or terminal loss of the original source's authority.
        if (!grantContentStillAllowed(token.authorization, current)) return deny('caller-grant-narrowed');
    }
    let deadline = controls.consentState === false && current.scenario === 'consent-access'
        ? current.deadline : Math.min(current.deadline, token.authorization.deadline);
    if (crossSource) deadline = Math.min(deadline, authorityCurrent.deadline);
    const consent = current.scenario === 'consent-access' ? store.get('Consent', current.consentId) : null;
    const oneTime = consent && controls.consentState !== false && isOneTimeConsent(consent);
    if (oneTime) {
        const existing = readFirstUse(firstUseStore, current.serviceId, consent.id, subjectClient.clientId, sourceOrganizationId);
        if (existing && (!existing.ok || existing.startedAt > now)) return deny('subject-first-use-window');
        deadline = Math.min(deadline, existing?.expiresAt ?? now + ONE_TIME_WINDOW_SECONDS);
    }
    if (Math.floor(deadline) <= now) { revokeSubject('subject-authorization-deadline'); return deny('subject-authorization-deadline'); }
    const projection = {
        ...commonProjection(token, now, deadline, controls),
        ...(current.scenario === 'consent-access' ? { organization_id: serializeBusinessIdentifier(current.requesterIdentifier) } : {}),
        authorization_details: token.authorization_details
    };
    if (Buffer.byteLength(JSON.stringify(projection)) > sourceLimits(store, config, { organizationId: sourceOrganizationId }).maxResponseBytes) return deny('subject-response-budget');
    if (oneTime && !ownToken) {
        const window = firstUseStore.getOrStart(firstUseKey(current.serviceId, consent.id, subjectClient.clientId, caller.organizationId), ONE_TIME_WINDOW_SECONDS, now);
        if (!window.ok || window.expiresAt <= now) return deny('subject-first-use-window');
        projection.exp = Math.floor(Math.min(projection.exp, window.expiresAt));
    }
    return allow(projection);
}

function createIntrospectionService(options) {
    const {
        tokenStore, store, findClient, authenticateAssertion, firstUseStore, resolveInvocation = () => null,
        getAudience = req => `${req.protocol}://${req.get('host')}/introspect`,
        getPolicy = () => ({}), getConfig = () => ({}),
        clock = () => Math.floor(Date.now() / 1000),
        logger = { info() {} }
    } = options;
    return function introspect(req) {
        const classified = classifyIntrospectionRequest(req);
        if (!classified.ok) return classified;
        const now = clock();
        const configuration = getConfig();
        const withinFormBudget = limits => {
            const decoded = Object.entries(req.body).reduce((bytes, [name, value], index) =>
                bytes + Buffer.byteLength(name) + Buffer.byteLength(value) + 1 + (index ? 1 : 0), 0);
            return decoded <= limits.maxFormBytes && (!req.oauthFormBytes
                || (req.oauthFormBytes.decoded <= limits.maxFormBytes && req.oauthFormBytes.encoded <= limits.maxEncodedFormBytes));
        };
        let caller;
        let authentication;
        let commitReplay = () => true;
        if (classified.mode === 'assertion') {
            // An untrusted issuer selects only an early budget, never authority. The authenticated caller is checked again below.
            const hint = jwt.decode(req.body.client_assertion)?.iss;
            const earlyLimits = registeredSourceId(store, configuration, { clientId: hint }) ? sourceLimits(store, configuration, { clientId: hint }) : transportLimits(configuration);
            if (!withinFormBudget(earlyLimits)) return oauthError(400, 'invalid_request', 'Introspection form exceeds the source budget');
            authentication = authenticateAssertion(req, { deferReplay: true });
            if (authentication.errorStatus) {
                return { ok: false, status: authentication.errorStatus, body: authentication.errorBody };
            }
            commitReplay = authentication.commitReplay || commitReplay;
            caller = {
                clientId: authentication.client.clientId,
                organizationId: authentication.client.organizationId
            };
        } else {
            const credential = tokenStore.get(classified.credential);
            if (!credential || credential.kind !== 'introspection' || credential.exp <= now
                || credential.aud !== getAudience(req) || credential.scope !== SCOPES.management
                || credential.sub !== credential.client_id) {
                return oauthError(401, 'invalid_client', 'Introspection bearer credential is invalid');
            }
            if (!require('./grant-authority-state').sourceClientCredentialStillAllowed(credential, store, configuration)) {
                return oauthError(401, 'invalid_client', 'Source registration changed; obtain a fresh introspection credential');
            }
            caller = { clientId: credential.client_id, organizationId: credential.organization_id };
        }
        if (!withinFormBudget(sourceLimits(store, configuration, { clientId: caller.clientId }))) return oauthError(400, 'invalid_request', 'Introspection form exceeds the source budget');
        if (!commitReplay()) return oauthError(401, 'invalid_client', 'Assertion jti has already been used');
        const callerClient = findClient(caller.clientId);
        const ownToken = callerClient?.role === 'service-provider';
        const callerEndpoint = referencedEndpoint(store, store.get('Organization', caller.organizationId));
        if (ownToken) {
            if (!require('../../shared/conformance-policy').serviceProviderOwnTokenIntrospection(configuration).enabled) {
                return oauthError(403, 'access_denied', 'Optional Service Provider own-token introspection is disabled');
            }
            if (classified.mode !== 'assertion' || authentication.transportVerified !== true || authentication.signatureVerified !== true
                || callerClient.organizationId !== caller.organizationId) {
                return oauthError(401, 'invalid_client', 'Own-token introspection requires registered mTLS and private_key_jwt credentials');
            }
        } else if (!callerClient || callerClient.role !== 'data-source'
            || callerClient.organizationId !== caller.organizationId
            || !callerClient.scopes?.includes('introspection') || !callerEndpoint) {
            return oauthError(401, 'invalid_client', 'Introspection caller is not an active registered Data Source');
        }
        const subject = ownToken && tokenStore.peek ? tokenStore.peek(req.body.token) : tokenStore.get(req.body.token);
        const active = evaluateSubjectToken({
            ownToken,
            issuer: getAudience(req).replace(/\/introspect$/, ''),
            token: subject,
            revokeSubject: () => tokenStore.revoke?.(req.body.token),
            config: getConfig(),
            resolveInvocation,
            caller,
            store,
            findClient,
            firstUseStore,
            now,
            controls: sourceControls(store, getPolicy(), configuration, ownToken
                ? { organizationId: subject?.authorization?.dataSourceOrganizationId } : { clientId: caller.clientId }),
            getSourceControls: organizationId => sourceControls(store, getPolicy(), configuration, { organizationId }),
            audit: decision => logger.info?.('Introspection authorization decision', {
                type: 'INTROSPECTION_DECISION',
                caller_client_id: caller.clientId,
                ...(ownToken ? { visibility: 'diagnostic', component: 'pcm', operation: 'service-provider-own-token-introspection', compatibility: true } : {}),
                ...decision
            })
        });
        return active ? { ok: true, status: 200, body: active } : inactive();
    };
}

module.exports = {
    ACTIVE_CACHE_CEILING_SECONDS,
    CONTEXT_ROLES,
    ONE_TIME_WINDOW_SECONDS,
    classifyIntrospectionRequest,
    createIntrospectionService,
    evaluateSubjectToken,
    exactAuthenticationContext,
    isOneTimeConsent
};
