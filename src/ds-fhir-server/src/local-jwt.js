/**
 * Local JWT verification via OAuth2 authorization-server metadata and JWKS.
 */
const crypto = require('crypto');
const fs = require('fs');
const { buildEffectivePolicy, simulationPolicyStamp } = require('../../shared/conformance-policy');
const { safeLookup, parseOutboundUrl } = require('../../shared/outbound-destination');
const http = require('http');
const https = require('https');
const jwt = require('jsonwebtoken');
const logger = require('./logger');

let cachedMetadata = null;
let cachedJwks = null;

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;

function discoveryTimeoutMs() {
    const configured = Number(process.env.LOCAL_JWT_DISCOVERY_TIMEOUT_MS || DEFAULT_DISCOVERY_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DISCOVERY_TIMEOUT_MS;
}

function trimTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

function getMetadataUrl() {
    if (process.env.LOCAL_JWT_AUTHORIZATION_SERVER_METADATA_URL) {
        return process.env.LOCAL_JWT_AUTHORIZATION_SERVER_METADATA_URL;
    }
    const adapterUrl = trimTrailingSlash(process.env.DS_AUTH_ADAPTER_URL || 'http://ds-auth-adapter:3000');
    return `${adapterUrl}/.well-known/oauth-authorization-server`;
}

function expectedIssuer() {
    const hoId = process.env.HO_ID || 'reference';
    return process.env.LOCAL_JWT_ISSUER || `https://ds-auth-adapter.internal/${encodeURIComponent(hoId)}`;
}

function expectedAudience() {
    const hoId = process.env.HO_ID || 'reference';
    return process.env.LOCAL_JWT_AUDIENCE || `urn:pcm:ho:${hoId}:fhir-server`;
}

function fetchJson(url, label = 'json') {
    parseOutboundUrl(url);
    const client = url.startsWith('https:') ? https : http;
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const req = client.get(url, { lookup: safeLookup() }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                const durationMs = Date.now() - startedAt;
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    logger.warn(`Local JWT discovery failed: ${label}`, {
                        type: 'LOCAL_JWT_DISCOVERY',
                        label,
                        url,
                        status: res.statusCode,
                        durationMs
                    });
                    reject(new Error(`GET ${url} returned ${res.statusCode}`));
                    return;
                }
                try {
                    const parsed = JSON.parse(body);
                    logger.debug(`Local JWT discovery succeeded: ${label}`, {
                        type: 'LOCAL_JWT_DISCOVERY_SUCCEEDED',
                        category: 'security',
                        visibility: 'default',
                        causesSystemFlow: false,
                        label,
                        url,
                        status: res.statusCode,
                        durationMs
                    });
                    resolve(parsed);
                } catch (err) {
                    logger.warn(`Local JWT discovery returned invalid JSON: ${label}`, {
                        type: 'LOCAL_JWT_DISCOVERY',
                        label,
                        url,
                        status: res.statusCode,
                        durationMs,
                        error: err.message
                    });
                    reject(err);
                }
            });
        });
        req.on('error', err => {
            logger.warn(`Local JWT discovery request failed: ${label}`, {
                type: 'LOCAL_JWT_DISCOVERY',
                label,
                url,
                durationMs: Date.now() - startedAt,
                error: err.message
            });
            reject(err);
        });
        req.setTimeout(discoveryTimeoutMs(), () => {
            req.destroy(new Error(`GET ${url} timed out`));
        });
    });
}

async function getAuthorizationServerMetadata() {
    if (cachedMetadata) {
        logger.debug('Local JWT metadata cache hit', {
            type: 'LOCAL_JWT_METADATA_CACHE_HIT',
            category: 'security',
            visibility: 'default',
            causesSystemFlow: false
        });
        return cachedMetadata;
    }
    cachedMetadata = await fetchJson(getMetadataUrl(), 'metadata');
    if (cachedMetadata?.issuer !== expectedIssuer()) {
        cachedMetadata = null;
        throw new Error('Local JWT metadata issuer does not match this HO');
    }
    return cachedMetadata;
}

function internalJwksUrl() {
    return new URL('/.well-known/jwks.json', getMetadataUrl()).toString();
}

function getPreferredJwksUrls(metadata) {
    const configured = process.env.LOCAL_JWT_JWKS_URL;
    if (configured) return [configured];

    const internal = internalJwksUrl();
    const advertised = metadata.jwks_uri;
    if (!advertised || advertised === internal) return [internal].filter(Boolean);

    if (process.env.LOCAL_JWT_AUTHORIZATION_SERVER_METADATA_URL) {
        // In ECS the adapter publishes a public issuer/JWKS URI for external
        // clients, while the mock FHIR server should stay on task-local
        // loopback to avoid NLB hairpin latency.
        return [internal, advertised];
    }
    return [advertised, internal];
}

async function getJwks() {
    if (cachedJwks) {
        logger.debug('Local JWT JWKS cache hit', {
            type: 'LOCAL_JWT_JWKS_CACHE_HIT',
            category: 'security',
            visibility: 'default',
            causesSystemFlow: false
        });
        return cachedJwks;
    }
    if (!cachedJwks) {
        const metadata = await getAuthorizationServerMetadata();
        const attempts = getPreferredJwksUrls(metadata);
        let lastError = null;
        for (const url of attempts) {
            try {
                cachedJwks = await fetchJson(url, url === internalJwksUrl() ? 'jwks-internal' : 'jwks-advertised');
                break;
            } catch (err) {
                lastError = err;
                logger.warn('Local JWT JWKS fetch attempt failed', {
                    type: 'LOCAL_JWT_JWKS_FALLBACK',
                    url,
                    error: err.message
                });
            }
        }
        if (!cachedJwks) throw lastError || new Error('No JWKS URL configured');
    }
    return cachedJwks;
}

function selectJwk(jwks, kid) {
    const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
    if (!keys.length) throw new Error('JWKS contains no keys');
    return keys.find(key => key.kid === kid) || (kid ? null : keys[0]);
}

async function verifyLocalJwt(token) {
    const decodedHeader = jwt.decode(token, { complete: true })?.header || {};
    const metadata = await getAuthorizationServerMetadata();
    const jwk = selectJwk(await getJwks(), decodedHeader.kid);
    if (!jwk) throw new Error(`No JWKS key found for kid ${decodedHeader.kid}`);

    const verifyOptions = {
        algorithms: ['RS256'],
        issuer: expectedIssuer(),
        audience: expectedAudience()
    };

    const payload = jwt.verify(token, crypto.createPublicKey({ key: jwk, format: 'jwk' }), verifyOptions);
    validateLocalPayload(payload);
    logger.debug('Local JWT verified', {
        type: 'LOCAL_JWT_VERIFIED',
        category: 'security',
        visibility: 'default',
        causesSystemFlow: false,
        issuer: payload.iss,
        subject: payload.sub,
        audience: payload.aud
    });
    return payload;
}

/** Validate the private adapter/FHIR-server contract after signature checks. */
function validateLocalPayload(payload) {
    const required = [
        'schema', 'authorization_schema', 'ho_id', 'kind', 'sub', 'client_id', 'scope',
        'pcm_issuer', 'pcm_audience', 'pcm_expires_at', 'authentication',
        'iat', 'exp', 'iss', 'aud', 'jti', 'policy_stamp', 'request_binding'
    ];
    const optional = [
        'organization', 'patient_identifier', 'consent_identifier',
        'healthcare_service_identifier', 'presence_identifiers', 'contract_identifier', 'scenario'
    ];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || required.some(key => !Object.hasOwn(payload, key))
        || Object.keys(payload).some(key => !required.includes(key) && !optional.includes(key))) {
        throw new Error('Local JWT claim set is not closed');
    }
    if (payload.schema !== 'pcm-ds-local-token/5'
        || payload.authorization_schema !== 'pcm-ds-authorization-context/4'
        || payload.ho_id !== (process.env.HO_ID || 'reference')
        || payload.sub !== payload.client_id
        || !['data-source-access', 'online-presence', 'batch-presence'].includes(payload.kind)
        || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
        || payload.exp <= payload.iat || payload.exp - payload.iat > 30
        || payload.exp > payload.pcm_expires_at) {
        throw new Error('Local JWT authorization binding is invalid');
    }
    if (typeof payload.policy_stamp !== 'string' || !payload.policy_stamp
        || !['GET', 'HEAD', 'POST'].includes(payload.request_binding?.method)
        || !payload.request_binding?.uri?.startsWith('/fhir')) throw new Error('Local JWT policy/request binding is invalid');
    let authenticationOptions = {};
    if (process.env.TEAM_CONFIG_PATH) {
        const config = require('../../shared/team-config-validator').readTeamConfig(process.env.TEAM_CONFIG_PATH, { env: process.env });
        const policy = buildEffectivePolicy(config, process.env);
        const controls = policy.simulation.perSource[payload.ho_id] || policy.simulation.controls;
        authenticationOptions = require('../../shared/authentication-evidence').simulationOptions(policy, controls);
        if (payload.policy_stamp !== simulationPolicyStamp(controls, payload.ho_id, (config.runtime?.revision || 0) - (config.runtime?.queryLimitsRevisionOffset || 0))) throw new Error('Local JWT source policy is stale');
        if (payload.kind === 'data-source-access') throw new Error('Legacy Node clinical access is unsupported');
    }
    if (typeof payload.scope !== 'string' || !payload.scope
        || typeof payload.pcm_issuer !== 'string' || !payload.pcm_issuer
        || typeof payload.pcm_audience !== 'string' || !payload.pcm_audience
        || !exactAuthentication(payload.authentication, authenticationOptions)) {
        throw new Error('Local JWT authorization binding is invalid');
    }
    const has = key => Object.hasOwn(payload, key);
    if (payload.kind === 'data-source-access') {
        if (!has('organization') || !has('patient_identifier')
            || !has('consent_identifier') || !has('healthcare_service_identifier') || has('presence_identifiers')
            || has('contract_identifier') || payload.scenario !== 'consent-access') {
            throw new Error('Local JWT data-source context is incomplete');
        }
        if (!payload.scope.split(' ').every(scope => /^patient\/[A-Z][A-Za-z]+\.(?:r|s|rs)(?:\?[^\s]+)?$/.test(scope))) throw new Error('Local JWT clinical scope context is invalid');
        for (const scope of payload.scope.split(' ')) {
            if (scope.startsWith('patient/Patient.') && scope.split('?')[1]?.split('&').some(clause => clause.startsWith('identifier=')
                && clause !== `identifier=${payload.patient_identifier?.system}|${payload.patient_identifier?.value}`)) throw new Error('Local JWT Patient identity disagrees with context');
        }
    } else {
        const count = payload.presence_identifiers?.length;
        if (!Array.isArray(payload.presence_identifiers)
            || new Set(payload.presence_identifiers.map(id => `${id?.system}|${id?.value}`)).size !== count
            || (payload.kind === 'online-presence' ? count !== 1 : count < 2 || count > localPresenceLimits().maxPatients)
            || has('patient') || has('patient_identifier') || has('organization') || has('consent_identifier')
            || !exactIdentifier(payload.contract_identifier) || has('healthcare_service_identifier')
            || payload.scenario !== 'presence-check'
            || payload.contract_identifier.system !== 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id'
            || payload.scope !== `system/Patient.s?identifier=${payload.presence_identifiers.map(id => `${id.system}|${id.value}`).join(',')}&_security=http://fhir.health.gov.il/cs/il-hdp-information-buckets|patientDemographics`) {
            throw new Error('Local JWT presence context is invalid');
        }
    }
    if (payload.kind.endsWith('presence')) require('../../shared/workflow-identities').assertWorkflowIdentity(payload.contract_identifier, payload.scenario, require('../../shared/workflow-identities').workflowIdentities(localConfig()));
    for (const key of ['organization', 'patient_identifier', 'consent_identifier', 'healthcare_service_identifier']) {
        if (has(key) && !exactIdentifier(payload[key])) throw new Error(`Local JWT ${key} is invalid`);
    }
    for (const identifier of payload.presence_identifiers || []) {
        if (!exactIdentifier(identifier)) throw new Error('Local JWT presence identifier is invalid');
    }
    return payload;
}

/** Read current source configuration without carrying stale budgets across reloads. */
function localConfig() {
    return process.env.TEAM_CONFIG_PATH ? require('../../shared/team-config-validator').readTeamConfig(process.env.TEAM_CONFIG_PATH, { env: process.env }) : {};
}

/** Legacy budget alias is separate from the configured legacy security identity. */
function localPresenceLimits() {
    return require('../../shared/presence-limits').presenceLimits(localConfig(), { id: 'legacy' });
}

function exactIdentifier(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === 2
        && typeof value.system === 'string' && Boolean(value.system)
        && typeof value.value === 'string' && Boolean(value.value);
}

function exactAuthentication(value, options) {
    try { require('../../shared/authentication-evidence').normalizePrivateAuthentication(value, options); return true; }
    catch (_) { return false; }
}

function clearLocalJwtCache() {
    cachedMetadata = null;
    cachedJwks = null;
}

module.exports = {
    clearLocalJwtCache,
    getAuthorizationServerMetadata,
    getJwks,
    getMetadataUrl,
    getPreferredJwksUrls,
    selectJwk,
    validateLocalPayload,
    verifyLocalJwt
};
