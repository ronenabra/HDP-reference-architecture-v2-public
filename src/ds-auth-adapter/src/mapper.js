'use strict';

/** Map the single normalized PCM authorization schema into a private DS JWT. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { NORMALIZED_SCHEMA } = require('./introspection-contract');
const { readTeamConfig } = require('../../shared/team-config-validator');
const { signLocalJwt } = require('./local-jwt');
const { classifyRequestBinding } = require('./request-binding');

function loadIdentityMappingHelpers() {
    const candidates = [
        ...(process.env.SHARED_IDENTITY_MAPPING_DIR ? [path.join(process.env.SHARED_IDENTITY_MAPPING_DIR, 'identity-mapping')] : []),
        path.join(__dirname, '..', '..', 'shared', 'identity-mapping'),
        '/shared/identity-mapping'
    ];
    for (const candidate of candidates) {
        try { return require(candidate); } catch (_error) { /* try the next deployment layout */ }
    }
    throw new Error('Unable to load shared identity mapping helpers');
}

const { DEFAULT_PATIENT_ID_SYSTEM, cleanLocalSubject, getEffectiveBusinessIdOverrides, toPatientContext } = loadIdentityMappingHelpers();

function readIdentityOverrides() {
    const configPath = process.env.TEAM_CONFIG_PATH || [
        '/runtime/team-config.json',
        path.join(process.cwd(), 'team-config.json')
    ].filter(Boolean).find(filePath => {
        try { return fs.existsSync(filePath) && fs.statSync(filePath).isFile(); } catch (_error) { return false; }
    });
    return getEffectiveBusinessIdOverrides(readTeamConfig(configPath, { env: process.env }));
}

/** Resolve a typed patient identifier inside one immutable HO namespace. */
function mapPatient(identifier, hoId, overrides = readIdentityOverrides()) {
    if (!identifier?.system || !identifier?.value || !hoId) throw new Error('Typed Patient context and HO namespace are required');
    const context = `${identifier.system}|${identifier.value}`;
    const configured = cleanLocalSubject(overrides[toPatientContext(context)] || (identifier.system === DEFAULT_PATIENT_ID_SYSTEM ? overrides[identifier.value] : ''));
    if (configured) return configured;
    const digest = crypto.createHash('sha256').update(`${hoId}\u0000${identifier.system}\u0000${identifier.value}`).digest('hex');
    return `Patient/${digest}`;
}

/**
 * Convert a validated PCM decision into a closed, short-lived private JWT.
 * Raw introspection objects are deliberately rejected.
 */
function mapIdentity(context, options = {}) {
    if (!context?.active || context.schema !== NORMALIZED_SCHEMA) {
        throw new Error(`Authorization context must use ${NORMALIZED_SCHEMA}`);
    }
    const hoId = options.hoId || context.hoId;
    if (!hoId || context.hoId !== hoId) throw new Error('Authorization context belongs to another HO');
    if (!options.issuer || !options.audience) throw new Error('Private local JWT issuer and audience are required');

    const requestBinding = options.requestBinding;
    let requestRoute;
    try { requestRoute = classifyRequestBinding(requestBinding).route; } catch (_error) {
        throw new Error('A validated protected FHIR request binding is required');
    }
    const clinicalBinding = ['data-source-access', 'patient-authentication', 'dependent-discovery'].includes(context.kind)
        && (['GET', 'HEAD'].includes(requestBinding?.method)
            && ['clinical', 'continuation', 'patient-everything'].includes(requestRoute)
            || requestBinding?.method === 'POST' && requestRoute === 'type-search');
    const onlineBinding = context.kind === 'online-presence'
        && (requestBinding?.method === 'GET' && requestBinding?.uri.startsWith('/fhir/Patient?')
            || requestRoute === 'type-search' && /^\/fhir\/Patient\/_search(?:\?|$)/.test(requestBinding.uri));
    const batchBinding = ['batch-presence', 'online-presence', 'dependent-discovery'].includes(context.kind)
        && requestBinding?.method === 'POST' && ['/fhir', '/fhir/'].includes(requestBinding?.uri);
    if (!requestBinding || typeof requestBinding.uri !== 'string'
        || !(clinicalBinding || onlineBinding || batchBinding || context.kind === 'sandbox-patient-sample')) {
        throw new Error('A validated protected FHIR request binding is required');
    }
    const samplingBinding = context.kind === 'sandbox-patient-sample';
    if (samplingBinding) require('../../shared/sandbox-patients').assertSampleRequest(requestBinding);
    const payload = {
        schema: 'pcm-ds-local-token/5',
        policy_stamp: options.policyStamp || 'test-policy',
        authorization_schema: context.schema,
        ho_id: hoId,
        kind: context.kind,
        sub: context.subject.clientId,
        client_id: context.subject.clientId,
        scope: context.grant.scope,
        pcm_issuer: context.token.issuer,
        pcm_audience: context.token.audience,
        pcm_expires_at: context.token.expiresAt,
        authentication: context.authentication,
        request_binding: { method: requestBinding.method, uri: requestBinding.uri },
        ...(context.subject.organization ? { organization: context.subject.organization } : {}),
        ...(context.grant.patient ? { patient_identifier: context.grant.patient } : {}),
        ...(context.grant.contract ? { contract_identifier: context.grant.contract } : {}),
        ...(context.grant.representative ? { representative_identifier: context.grant.representative } : {}),
        ...(context.grant.scenario ? { scenario: context.grant.scenario } : {}),
        ...(context.grant.consent ? { consent_identifier: context.grant.consent } : {}),
        ...(context.grant.healthcareService ? { healthcare_service_identifier: context.grant.healthcareService } : {}),
        ...(context.grant.presenceIdentifiers ? { presence_identifiers: context.grant.presenceIdentifiers } : {})
    };
    return signLocalJwt(payload, {
        issuer: options.issuer,
        audience: options.audience,
        sourceExpiresAt: context.token.expiresAt,
        clock: options.clock,
        maxPrivateAuthorizationBytes: options.queryLimits?.maxPrivateAuthorizationBytes
    });
}

/** Retired contexts must never be minted, including by diagnostic callers. */
function mapUnfilteredSimulation() { throw new Error('Unfiltered and anonymous clinical simulation is retired; an explicit approved scope is required'); }

module.exports = { mapIdentity, mapPatient, mapUnfilteredSimulation };
