/**
 * Shared route classification policy for structured logging.
 */

const routeLogPolicy = [
    { match: /^\/api\/logs/, category: 'noise', visibility: 'hidden', emitMiddleware: false, causesSystemFlow: false },
    { match: /^\/api\/unified-logs/, category: 'noise', visibility: 'hidden', emitMiddleware: false, causesSystemFlow: false },
    { match: /^\/docs\//, category: 'noise', visibility: 'hidden', emitMiddleware: false, causesSystemFlow: false },
    { match: /^\/healthz$/, category: 'noise', visibility: 'hidden', emitMiddleware: false, causesSystemFlow: false },
    { match: /^\/logs-view$/, category: 'admin', visibility: 'diagnostic', emitMiddleware: false, causesSystemFlow: false },
    { match: /^\/ui(?:\/|$)/, category: 'admin', visibility: 'diagnostic', emitMiddleware: false, causesSystemFlow: false },
    { match: /^\/admin(?:\/|$)/, category: 'admin', visibility: 'diagnostic', emitMiddleware: false, causesSystemFlow: false },
    { match: /^\/$/, category: 'harness', visibility: 'diagnostic', emitMiddleware: false, causesSystemFlow: false },
    { match: /^\/manage$/, category: 'harness', visibility: 'diagnostic', operation: 'manage-organization', emitMiddleware: false, causesSystemFlow: false },
    { match: /^\/create-consent$/, category: 'harness', visibility: 'diagnostic', operation: 'create-consent', emitMiddleware: false, causesSystemFlow: true },
    { match: /^\/discover$/, category: 'harness', visibility: 'diagnostic', operation: 'discover-source', emitMiddleware: false, causesSystemFlow: true },
    { match: /^\/fetch-data$/, category: 'harness', visibility: 'diagnostic', operation: 'fetch-data', emitMiddleware: false, causesSystemFlow: true },
    { match: /^\/reset$/, category: 'harness', visibility: 'diagnostic', operation: 'reset-session', emitMiddleware: false, causesSystemFlow: false },
    { match: /^\/api\/fhir-service\/r4(?:\/|$)/, category: 'system', visibility: 'default', operation: 'pcm-protocol', emitMiddleware: true, causesSystemFlow: true },
    { match: /^\/(?:r4|fhir)(?:\/|$)/, category: 'system', visibility: 'default', emitMiddleware: true, causesSystemFlow: true },
    { match: /^\/(?:Patient|RelatedPerson|Consent|Contract|Observation)(?:\/|$|\?)/, category: 'system', visibility: 'default', emitMiddleware: true, causesSystemFlow: true },
    { match: /^\/(?:token|introspect|auth-check)$/, category: 'system', visibility: 'default', emitMiddleware: true, causesSystemFlow: true }
];

// Browser bookkeeping may initiate real work without becoming that work's evidence.
const authenticationWorkActions = new Set(['start', 'local-sso', 'fixture-start', 'verify', 'resend', 'discover', 'presence', 'presence-dependents', 'select']);
const pcmAuthenticationEvidence = new Set([
    'SYSTEM_AUTHENTICATION', 'SYSTEM_OTP', 'SYSTEM_WORKFLOW_REQUEST', 'SYSTEM_WORKFLOW_RESPONSE', 'SYSTEM_WORKFLOW_FAILURE',
    'SYSTEM_DISCOVERY', 'SYSTEM_DISCOVERY_PAGE', 'SYSTEM_PRESENCE',
    'TOKEN_ISSUED', 'TOKEN_AUTHORIZATION_DENIED', 'INTROSPECTION_DECISION', 'INTROSPECTION_PROCESSED', 'INTROSPECTION_TOKEN_REFRESH',
    'AUTHENTICATION_ROLE_DENIED', 'AUTHENTICATION_SIMULATION', 'PUBLIC_MTLS_REJECTED', 'COMPATIBILITY_ADAPTER',
    'OUTGOING_REQUEST', 'OUTGOING_RESPONSE', 'OUTGOING_ERROR'
]);
/** Match only a configured PCM browser path; external service identity is checked by callers. */
function authenticationBrowserPolicy(url = '', action) {
    let pathname;
    try { pathname = String(url).startsWith('/') ? String(url).split('?')[0] : new URL(url).pathname; }
    catch (_) { return null; }
    const match = /^\/sandbox\/authentication(?:\/([^/]+))?$/.exec(pathname);
    if (!match) return null;
    return { category: 'harness', visibility: 'diagnostic', operation: 'system-authentication-browser', emitMiddleware: true,
        causesSystemFlow: authenticationWorkActions.has(action || match[1]) };
}

/** Classify a service route; Doctor selection is a local UI action only. */
function classifyRoute(url = '', service = '') {
    if (service === 'pcm-core') { const browser = authenticationBrowserPolicy(url); if (browser) return browser; }
    const path = String(url).split('?')[0] || '/';
    if (service === 'sp-client' && path === '/selection') return {
        category: 'harness', visibility: 'diagnostic', emitMiddleware: true, causesSystemFlow: false
    };
    return routeLogPolicy.find(policy => policy.match.test(path)) || {
        category: 'system',
        visibility: 'default',
        emitMiddleware: true,
        causesSystemFlow: true
    };
}

/** Precise source-aware corrections shared by emission and retained display.
 * Historical source text remains unchanged; non-native unknown records keep their fallback.
 * @param {object} entry Recorded message, level and details.
 * @param {object} source Trusted configured identity, never a URL heuristic.
 * @returns {object|null} Approved classification override, or no correction.
 */
function knownLogClassification(entry, source = {}) {
    const details = entry.details || {}, type = details.type;
    const role = source.role || entry.event?.source?.role;
    const service = source.componentId || source.dir || entry.event?.source?.componentId;
    const doctor = role === 'doctor' || service === 'sp-client';
    const legacy = service === 'ds-fhir-server';
    // Only receipt/completion rows are ordinary in registered HAPI runtime sources.
    if (role === 'hapi') {
        return { visibility: ['HAPI_REQUEST', 'HAPI_RESPONSE'].includes(type) ? 'default' : 'diagnostic',
            ...(type === 'HAPI_STARTUP_READY' ? { category: 'lifecycle', causesSystemFlow: false } : {}) };
    }
    if (role === 'hapi-import' && type === 'HAPI_IMPORT_DIAGNOSTIC') return { visibility: 'diagnostic' };

    if (service === 'pcm-core') {
        if (type === 'SYSTEM_BROWSER_ACTION') return {
            category: 'harness', visibility: 'diagnostic', causesSystemFlow: authenticationWorkActions.has(details.action)
        };
        if (['REQUEST', 'RESPONSE', 'ROUTE_ERROR'].includes(type)) {
            const browser = authenticationBrowserPolicy(details.originalUrl || details.url || '');
            if (browser) return { category: browser.category, visibility: browser.visibility, causesSystemFlow: browser.causesSystemFlow };
            // Protocol request evidence must not inherit a diagnostic browser context.
            if (['REQUEST', 'RESPONSE'].includes(type) && /^\/api\/fhir-service\/r4(?:\/|$)/.test(details.originalUrl || details.url || '')) return { category: 'system', visibility: 'default' };
        }
        if (pcmAuthenticationEvidence.has(type)) return { category: /AUTHENTICATION|OTP|MTLS/.test(type) ? 'security' : 'system', visibility: 'default' };
    }

    if (service === 'pcm-core' && type === 'SANITY_CHECK_FAILED') {
        return { category: 'harness', visibility: 'diagnostic' };
    }
    // A Doctor operation summary is separate from its real HTTP/failure evidence.
    if (doctor && (type || entry.event?.eventName) === 'DATA_FETCH_COMPLETED') {
        return { category: 'harness', visibility: 'diagnostic' };
    }
    if (doctor && ['REQUEST', 'RESPONSE'].includes(type) && (details.url || details.originalUrl)) {
        const route = classifyRoute(details.url || details.originalUrl || '', 'sp-client');
        if (route.visibility === 'diagnostic') return {
            category: route.category, visibility: route.visibility, causesSystemFlow: route.causesSystemFlow
        };
    }
    if (['CONFORMANCE_MODE', 'PROCESS_BOOT', 'PROCESS_LISTENING'].includes(type) || (!type && /^PCM conformance mode: /.test(entry.message || ''))
        || (!type && (role === 'adapter' || service === 'ds-auth-adapter') && /^DS Auth Adapter listening on \d+$/.test(entry.message || ''))) {
        return { category: 'lifecycle', visibility: 'diagnostic', causesSystemFlow: false };
    }
    if (legacy && type === 'PROCESS_RELOAD_FAILED' && (details.stage === 'config'
        || (!details.stage && entry.message === 'DS FHIR config reload rejected'))) {
        return { category: 'lifecycle', visibility: 'diagnostic', causesSystemFlow: false };
    }
    if (legacy && ['LOCAL_JWT_DISCOVERY_SUCCEEDED', 'LOCAL_JWT_METADATA_CACHE_HIT', 'LOCAL_JWT_JWKS_CACHE_HIT', 'LOCAL_JWT_VERIFIED'].includes(type)) {
        return { category: 'security', visibility: 'default', causesSystemFlow: false };
    }
    return null;
}

/** An observed diagnostic error warrants one notice, never a service-health claim. */
function isCriticalDiagnostic(entry) {
    return entry.details?.visibility === 'diagnostic' && /^(?:ERROR|FATAL|CRITICAL)$/i.test(entry.level || '');
}

const AWS_CREDENTIAL_BLOCKED = '[AWS_CREDENTIAL_BLOCKED]';
const AWS_CREDENTIAL_KEYS = /^(?:aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key|session[_-]?token|security[_-]?token|web[_-]?identity[_-]?token(?:[_-]?file)?)|x-amz-security-token|ecr[_-]?(?:authorization[_-]?token|password)|ecs[_-]?credential(?:s)?|container[_-]?(?:credentials[_-]?(?:full[_-]?uri|relative[_-]?uri)|authorization[_-]?token))$/i;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}\b/g;
const AWS_SIGV4 = /\bAWS4-HMAC-SHA256\s+Credential=[^\s,]+(?:,\s*SignedHeaders=[^\s,]+,\s*Signature=[A-Fa-f0-9]+)?/g;

/**
 * Preserve developer log text verbatim except positively identified AWS
 * operational credentials. Generic tokens, passwords, private keys, Patient
 * identifiers, query strings, and FHIR bodies are intentional local output.
 */
function sanitizeLogMessage(value) {
    return String(value)
        .replace(AWS_ACCESS_KEY, AWS_CREDENTIAL_BLOCKED)
        .replace(AWS_SIGV4, AWS_CREDENTIAL_BLOCKED);
}

/**
 * Produce log-safe structured details without mutating caller-owned values.
 * FHIR bodies, identifiers, query strings, and non-AWS authentication material
 * are intentionally retained for local sandbox diagnostics.
 */
function sanitizeLogDetails(value, key = '', seen = new WeakSet()) {
    if (AWS_CREDENTIAL_KEYS.test(key)) return value === undefined ? undefined : AWS_CREDENTIAL_BLOCKED;
    if (value instanceof Error) {
        return {
            name: value.name,
            message: sanitizeLogMessage(value.message),
            stack: sanitizeLogMessage(value.stack || '')
        };
    }
    if (typeof value === 'string') return sanitizeLogMessage(value);
    if (typeof value === 'bigint') return value.toString();
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => sanitizeLogDetails(item, '', seen));
    const names = Object.keys(value);
    const awsCredentialResponse = names.some(name => /^AccessKeyId$/i.test(name))
        && names.some(name => /^SecretAccessKey$/i.test(name))
        && names.some(name => /^(?:Token|SessionToken)$/i.test(name));
    const ecrCredentialResponse = names.some(name => /^authorizationToken$/i.test(name))
        && (names.some(name => /^proxyEndpoint$/i.test(name)) || /authorizationData/i.test(key));
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [
        name,
        (awsCredentialResponse && /^(?:AccessKeyId|SecretAccessKey|Token|SessionToken)$/i.test(name))
            || (ecrCredentialResponse && /^authorizationToken$/i.test(name))
            ? AWS_CREDENTIAL_BLOCKED
            : sanitizeLogDetails(item, name, seen)
    ]));
}

module.exports = {
    AWS_CREDENTIAL_BLOCKED,
    AWS_CREDENTIAL_KEYS,
    classifyRoute,
    knownLogClassification,
    isCriticalDiagnostic,
    routeLogPolicy,
    sanitizeLogDetails,
    sanitizeLogMessage
};
