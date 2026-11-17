'use strict';

/**
 * Versioned strict/connectathon policy for the PCM-IG 0.4.0 sandbox.
 *
 * All runtime components consume the resulting immutable object. Mode
 * selection and compatibility decisions deliberately live in this module so
 * feature code cannot grow independent environment-variable switches.
 */

const { tokenMaximumSeconds, LOGGING_EXCEPTION } = require('./pcm-environment');
const POLICY_VERSION = 'pcm-sandbox-policy/4';
const CONFORMANCE_MODES = Object.freeze(['strict', 'connectathon']);
const PRESETS = Object.freeze(['connectathon-easy', 'connectathon-balanced', 'connectathon-mtls', 'strict']);
// Only authentication and transport experiments remain configurable. Clinical
// authority is required even when the development profile simulates credentials.
const SIMULATION_CONTROLS = Object.freeze([
    'publicClientMtls', 'serverCertificateVerification', 'clientAssertionSignature',
    'clientAssertionAudience', 'clientAssertionReplay', 'clientAssertionExpiry'
]);
const REQUIRED_AUTHORIZATION_CONTROLS = Object.freeze([
    'oauthBearer', 'tokenResourceBinding', 'tokenAudience', 'tokenExpiry',
    'consentState', 'serviceState', 'patientIdentifier', 'patientMapping',
    'smartScopes', 'smartInteractions', 'smartQueryFilters', 'informationBucket',
    'sensitivityLabels', 'history', 'references', 'includes', 'paging',
    'resultFiltering', 'presenceAuthorization'
]);
const NATIVE_FILTER_CONTROLS = REQUIRED_AUTHORIZATION_CONTROLS;
const EFFECTIVE_CONTROLS = Object.freeze([...SIMULATION_CONTROLS, ...REQUIRED_AUTHORIZATION_CONTROLS]);

/** No backend receives an implicit exemption from grant enforcement. */
function presetSourceDefaults(_preset) { return {}; }

/** Reject controls that could fabricate or broaden a retained authorization. */
function validateSimulationDependencies(controls, source = 'global') {
    for (const name of REQUIRED_AUTHORIZATION_CONTROLS) {
        if (controls[name] !== true) throw new Error(`${source}: ${name} is required and cannot be simulated`);
    }
}

/** Fingerprint all effective controls so warm caches and signed contexts cannot cross policy revisions. */
function simulationPolicyStamp(controls, sourceId, revision = 0) {
    const bits = EFFECTIVE_CONTROLS.map(name => controls[name] ? '1' : '0').join('');
    return require('crypto').createHash('sha256').update(`${POLICY_VERSION}:${sourceId}:${revision}:${bits}`).digest('hex');
}

/** Resolve global defaults plus the exact configured source override. */
function sourceSimulationControls(policy, config = {}, { resource, clientId } = {}) {
    const source = [...(config.healthOrganizations || []), ...(config.organizations?.dataSources || []), ...(config.legacyDataSource ? [{ ...config.legacyDataSource, endpoint: config.legacyDataSource.internalFhirBaseUrl, clientId: config.organizations?.referenceDataSource?.clientId }] : [])]
        .find(item => (resource && item.endpoint === resource) || (clientId && item.clientId === clientId));
    const overrides = policy?.simulation?.perSource || {};
    return source && Object.hasOwn(overrides, source.id) ? overrides[source.id] : policy?.simulation?.controls || {};
}

const COMPATIBILITY_ADAPTER_CATALOG = Object.freeze({
    'legacy-rs256-assertion': Object.freeze({
        description: 'Verify an explicitly registered RSA assertion certificate with RS256.',
        warning: 'connectathon adapter legacy-rs256-assertion accepted a registered assertion algorithm',
        removalCriterion: 'Remove after every registered partner uses an approved P-256 or P-384 assertion key.'
    }),
    'legacy-es384-assertion': Object.freeze({
        description: 'Retained migration setting; approved P-384/ES384 assertions are normative without this adapter.',
        warning: 'legacy-es384-assertion is a retained migration setting; approved ES384 is normative and does not use this adapter',
        removalCriterion: 'Remove after every registered partner uses an approved P-256 or P-384 assertion key.'
    }),
    'legacy-jose-kid': Object.freeze({
        description: 'Normalize a non-thumbprint legacy kid only with a single registered eligible assertion key.',
        warning: 'connectathon adapter legacy-jose-kid normalized a client assertion',
        removalCriterion: 'Remove after every registered partner sends RFC 7638 thumbprint kid values.'
    }),
    'legacy-introspection-token-audience': Object.freeze({
        description: 'Normalize the token endpoint audience to the introspection endpoint for an introspection client assertion.',
        warning: 'connectathon adapter legacy-introspection-token-audience normalized an assertion audience',
        removalCriterion: 'Remove after every Data Source signs an exact introspection-endpoint audience.'
    }),
    'legacy-organization-url-client-id': Object.freeze({
        description: 'Map an allowlisted registered Organization URL to its assigned opaque client_id.',
        warning: 'connectathon adapter legacy-organization-url-client-id normalized a client identifier',
        removalCriterion: 'Remove after all partner registrations use assigned opaque client IDs.'
    }),
    'legacy-management-scope-cruds': Object.freeze({
        description: 'Map the exact legacy system/*.cruds spelling to system/*.crus before strict scope validation.',
        warning: 'connectathon adapter legacy-management-scope-cruds normalized a management scope',
        removalCriterion: 'Remove after all partners request the PCM-IG system/*.crus scope.'
    })
});

const AUTHORIZATION_CEILING = Object.freeze({
    organizationIsolation: 'required',
    healthOrganizationAudience: 'exact',
    consentBinding: 'required',
    patientIsolation: 'required',
    informationBucket: 'required',
    historyAccess: 'explicit-only',
    sensitivityLabels: 'required',
    returnedResourceAuthorization: 'required',
    binaryAttachmentAccess: 'deny-unsupported',
    presenceIsolation: 'required',
    advancedScopeExpressions: 'deny-unsupported'
});

const POLICY_SHAPE = Object.freeze({
    transport: Object.freeze(['pcmPublic', 'dataSourceGateway', 'serviceProviderToDataSource', 'dataSourceGatewayToFhir']),
    trust: Object.freeze(['generatedLocalMaterial', 'completeCertificateRoles']),
    assertion: Object.freeze(['algorithms', 'requireTypJwt', 'forbidKeySelectionHeaders', 'exactAudience', 'opaqueClientIds', 'enforceCertificateBinding']),
    input: Object.freeze(['rejectUnknownFields', 'validateProfiles', 'vocabularyAliases']),
    token: Object.freeze(['opaqueAccessTokens', 'accessTokenExpiresInSeconds', 'allowAnyResource']),
    exposure: Object.freeze(['adminAuthentication', 'demoUi', 'bannerClass', 'notice']),
    debug: Object.freeze(['allowAnyTokenResource', 'allowExpiredTokens']),
    compatibility: Object.freeze(['enabledAdapters', 'warnings']),
    deferred: Object.freeze(['advancedScopeExpressions']),
    authorizationCeiling: Object.freeze(Object.keys(AUTHORIZATION_CEILING)),
    simulation: Object.freeze(['preset', 'controls', 'perSource']),
    grantPolicy: Object.freeze(['grantFullClinicalAccess', 'locked', 'supportedResources', 'cacheMaximumSeconds']),
    invariants: Object.freeze(['awsCredentialIsolation'])
});

function presetName(config = {}) {
    const value = config?.conformance?.preset || (config?.conformance?.mode === 'strict' ? 'strict' : 'connectathon-easy');
    if (!PRESETS.includes(value)) throw new Error(`conformance.preset must be one of: ${PRESETS.join(', ')}`);
    return value;
}

function presetSimulationDefaults(preset) {
    const enabled = preset === 'strict' || preset === 'connectathon-mtls';
    return Object.fromEntries(SIMULATION_CONTROLS.map(name => [name,
        enabled || (preset === 'connectathon-balanced' && name !== 'publicClientMtls')]));
}

/** Effective controls expose invariant true values for existing consumers. */
function effectiveControls(configured) {
    return { ...configured, ...Object.fromEntries(REQUIRED_AUTHORIZATION_CONTROLS.map(name => [name, true])) };
}

function simulationConfiguration(config, strict) {
    const preset = presetName(config);
    const defaults = presetSimulationDefaults(preset);
    const overrides = config?.securitySimulation?.global || {};
    const unknown = Object.keys(overrides).filter(name => !SIMULATION_CONTROLS.includes(name));
    if (unknown.length) throw new Error(`unknown security simulation control: ${unknown.join(', ')}`);
    if (Object.values(overrides).some(value => typeof value !== 'boolean')) throw new Error('securitySimulation.global values must be boolean');
    if (strict && Object.entries(overrides).some(([name, value]) => value !== defaults[name])) throw new Error('strict mode security simulation controls are fixed');
    const controls = effectiveControls({ ...defaults, ...overrides });
    validateSimulationDependencies(controls);
    const perSource = {};
    const configuredSourceIds = new Set([
        ...(config?.healthOrganizations || []).map(source => source?.id),
        ...(config?.organizations?.dataSources || []).map(source => source?.id),
        ...(config?.legacyDataSource?.enabled === false || !config?.legacyDataSource?.id
            ? []
            : [config.legacyDataSource.id])
    ].filter(Boolean));
    for (const [sourceId, sourceOverrides] of Object.entries(config?.securitySimulation?.perSource || {})) {
        if (!configuredSourceIds.has(sourceId)) throw new Error(`unknown per-source security simulation source: ${sourceId}`);
        const invalid = Object.keys(sourceOverrides).filter(name => !SIMULATION_CONTROLS.includes(name));
        if (invalid.length || Object.values(sourceOverrides).some(value => typeof value !== 'boolean')) throw new Error(`invalid per-source security simulation control for ${sourceId}`);
        if (strict && Object.keys(sourceOverrides).length) throw new Error('strict mode prohibits per-source security simulation overrides');
        perSource[sourceId] = { ...controls, ...sourceOverrides };
        validateSimulationDependencies(perSource[sourceId], sourceId);
    }
    return { preset, controls, perSource };
}

function normalizeMode(value) {
    const mode = value || 'connectathon';
    if (!CONFORMANCE_MODES.includes(mode)) {
        throw new Error(`PCM_CONFORMANCE_MODE must be one of: ${CONFORMANCE_MODES.join(', ')}`);
    }
    return mode;
}

function requestedMode(config = {}, env = process.env) {
    const configMode = config?.conformance?.mode;
    const envMode = env.PCM_CONFORMANCE_MODE;
    if (envMode && configMode && envMode !== configMode) {
        throw new Error(`PCM_CONFORMANCE_MODE=${envMode} contradicts conformance.mode=${configMode}`);
    }
    return normalizeMode(envMode || configMode);
}

function configuredAdapters(config) {
    const adapters = config?.conformance?.compatibilityAdapters || [];
    if (!Array.isArray(adapters)) throw new Error('conformance.compatibilityAdapters must be an array');
    const unique = [...new Set(adapters)];
    for (const adapter of unique) {
        if (!Object.hasOwn(COMPATIBILITY_ADAPTER_CATALOG, adapter)) {
            throw new Error(`Unknown connectathon compatibility adapter: ${adapter}`);
        }
    }
    return unique;
}

function securityOverrides(config) {
    return config?.security || {};
}

/** Resolve the optional sandbox SP diagnostic capability without widening Strict. */
function serviceProviderOwnTokenIntrospection(config = {}, policy = {}) {
    const strict = config.conformance?.mode === 'strict' || config.conformance?.preset === 'strict' || policy.mode === 'strict';
    const override = config.security?.pcmApi?.allowServiceProviderOwnTokenIntrospection;
    return { enabled: !strict && override !== false, default: !strict,
        origin: strict ? 'Strict lock' : override === undefined ? 'preset default' : 'explicit override' };
}

function baseConfigurationErrors(config) {
    const security = securityOverrides(config);
    const errors = [];
    const choice = (value, allowed, path) => {
        if (value !== undefined && !allowed.includes(value)) errors.push(`${path} must be one of: ${allowed.join(', ')}`);
    };
    const boolean = (value, path) => {
        if (value !== undefined && typeof value !== 'boolean') errors.push(`${path} must be boolean`);
    };
    choice(security.pcmApi?.clientAuth, ['tls', 'mtls'], 'security.pcmApi.clientAuth');
    choice(security.dataSourceGateway?.clientAuth, ['tls', 'mtls'], 'security.dataSourceGateway.clientAuth');
    choice(security.dsGatewayToFhirServer?.protocol, ['http', 'https'], 'security.dsGatewayToFhirServer.protocol');
    boolean(security.pcmApi?.allowAnyTokenResource, 'security.pcmApi.allowAnyTokenResource');
    boolean(security.pcmApi?.allowServiceProviderOwnTokenIntrospection, 'security.pcmApi.allowServiceProviderOwnTokenIntrospection');
    if ((config.conformance?.mode === 'strict' || config.conformance?.preset === 'strict') && security.pcmApi?.allowServiceProviderOwnTokenIntrospection === true) {
        errors.push('security.pcmApi.allowServiceProviderOwnTokenIntrospection=true is prohibited in Strict');
    }
    boolean(security.serviceProviderToDataSource?.verifyServerCertificate, 'security.serviceProviderToDataSource.verifyServerCertificate');
    boolean(security.dsGatewayToFhirServer?.verifyServerCertificate, 'security.dsGatewayToFhirServer.verifyServerCertificate');
    if (security.dsFhirServer?.enforceMappedPatients === false) errors.push('security.dsFhirServer.enforceMappedPatients cannot disable required Patient context');
    if (security.pcmApi?.allowAnyTokenResource === true) {
        errors.push('security.pcmApi.allowAnyTokenResource=true violates the authorization ceiling');
    }
    const lifetime = security.pcmApi?.accessTokenExpiresInSeconds;
    if (lifetime !== undefined && (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > tokenMaximumSeconds(config))) {
        errors.push(`security.pcmApi.accessTokenExpiresInSeconds must be an integer from 1 through ${tokenMaximumSeconds(config)} for the selected contract environment`);
    }
    return errors;
}

function strictContradictions(config, env = process.env) {
    const security = securityOverrides(config);
    const contradictions = [];
    if (config?.conformance?.mode !== 'strict') contradictions.push('conformance.mode must be strict when strict mode is selected');
    if (config?.conformance?.preset !== 'strict') contradictions.push('conformance.preset must be strict when strict mode is selected');
    if (config?.conformance?.policyVersion !== POLICY_VERSION) contradictions.push(`conformance.policyVersion must be ${POLICY_VERSION}`);
    const requiredRoles = {
        pcm: ['server'],
        presenceOrchestrator: ['mtls', 'assertion'],
        authenticationOrchestrator: ['mtls', 'assertion'],
        discoveryOrchestrator: ['mtls', 'assertion'],
        serviceProvider: ['mtls', 'assertion'],
        hospitalBServiceProvider: ['mtls', 'assertion'],
        referenceDataSource: ['server', 'mtls', 'assertion'],
        dsFhirServer: ['server'],
        untrustedClient: ['mtls']
    };
    for (const [participant, purposes] of Object.entries(requiredRoles)) {
        for (const purpose of purposes) {
            const role = config?.certificateRoles?.[participant]?.[purpose];
            if (!role?.cert || !role?.key) contradictions.push(`certificateRoles.${participant}.${purpose} requires cert and key in strict mode`);
        }
    }
    const requireValue = (actual, expected, path) => {
        if (actual !== undefined && actual !== expected) contradictions.push(`${path} must be ${JSON.stringify(expected)} in strict mode`);
    };
    requireValue(security.pcmApi?.clientAuth, 'mtls', 'security.pcmApi.clientAuth');
    requireValue(security.pcmApi?.allowAnyTokenResource, false, 'security.pcmApi.allowAnyTokenResource');
    requireValue(security.dataSourceGateway?.clientAuth, 'mtls', 'security.dataSourceGateway.clientAuth');
    requireValue(security.serviceProviderToDataSource?.verifyServerCertificate, true, 'security.serviceProviderToDataSource.verifyServerCertificate');
    requireValue(security.dsGatewayToFhirServer?.protocol, 'https', 'security.dsGatewayToFhirServer.protocol');
    requireValue(security.dsGatewayToFhirServer?.verifyServerCertificate, true, 'security.dsGatewayToFhirServer.verifyServerCertificate');
    requireValue(security.dsFhirServer?.enforceMappedPatients, true, 'security.dsFhirServer.enforceMappedPatients');
    if (configuredAdapters(config).length) contradictions.push('strict mode prohibits conformance.compatibilityAdapters');
    if (env.PCM_ALLOW_ANY_TOKEN_RESOURCE === 'true') contradictions.push('PCM_ALLOW_ANY_TOKEN_RESOURCE=true is prohibited in strict mode');
    if (env.PCM_INTROSPECTION_RETURNS_EXPIRED_TOKENS === 'true') contradictions.push('PCM_INTROSPECTION_RETURNS_EXPIRED_TOKENS=true is prohibited in strict mode');
    if (env.PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS && Number(env.PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS) !== (security.pcmApi?.accessTokenExpiresInSeconds || tokenMaximumSeconds(config))) {
        contradictions.push('PCM_ACCESS_TOKEN_EXPIRES_IN_SECONDS must match the configured environment lifetime in strict mode');
    }
    return contradictions;
}

function connectathonTransport(config) {
    const security = securityOverrides(config);
    return {
        pcmPublic: { clientAuth: security.pcmApi?.clientAuth || 'mtls', browserHttpsRequired: false },
        dataSourceGateway: { clientAuth: security.dataSourceGateway?.clientAuth || 'mtls' },
        serviceProviderToDataSource: {
            verifyServerCertificate: security.serviceProviderToDataSource?.verifyServerCertificate === true
        },
        dataSourceGatewayToFhir: {
            protocol: security.dsGatewayToFhirServer?.protocol || 'http',
            verifyServerCertificate: security.dsGatewayToFhirServer?.verifyServerCertificate === true
        }
    };
}

function strictTransport() {
    return {
        pcmPublic: { clientAuth: 'mtls', browserHttpsRequired: true },
        dataSourceGateway: { clientAuth: 'mtls' },
        serviceProviderToDataSource: { verifyServerCertificate: true },
        dataSourceGatewayToFhir: { protocol: 'https', verifyServerCertificate: true }
    };
}

function buildEffectivePolicy(config = {}, env = process.env) {
    const mode = requestedMode(config, env);
    const strict = mode === 'strict';
    const contradictions = [
        ...baseConfigurationErrors(config),
        ...(strict ? strictContradictions(config, env) : [])
    ];
    if (contradictions.length) {
        throw new Error(`Strict conformance policy rejected configuration: ${contradictions.join('; ')}`);
    }
    const adapters = strict ? [] : configuredAdapters(config);
    const simulation = simulationConfiguration(config, strict);
    const transport = strict ? strictTransport() : connectathonTransport(config);
    // Versioned simulation controls own source transport; retain old field-only
    // configurations for callers that have not opted into the preset model.
    if (!strict && (config.securitySimulation || config.conformance?.preset)) {
        transport.serviceProviderToDataSource.verifyServerCertificate = simulation.controls.serverCertificateVerification;
        transport.dataSourceGatewayToFhir.verifyServerCertificate = simulation.controls.serverCertificateVerification;
        transport.dataSourceGateway.clientAuth = simulation.controls.publicClientMtls ? 'mtls' : 'tls';
    }
    const configuredLifetime = Number(config?.security?.pcmApi?.accessTokenExpiresInSeconds);
    const policy = {
        version: POLICY_VERSION,
        mode,
        resultLabel: strict ? 'STRICT SANDBOX' : `${simulation.preset.toUpperCase()} — NON-CONFORMANT SIMULATION`,
        strictConformanceClaim: false,
        conformanceExceptions: [LOGGING_EXCEPTION],
        transport,
        trust: {
            generatedLocalMaterial: strict ? 'provisioning-only' : 'allowed',
            completeCertificateRoles: 'required'
        },
        assertion: {
            algorithms: [
                'ES256', 'ES384',
                ...(!strict && adapters.includes('legacy-rs256-assertion') ? ['RS256'] : [])
            ],
            requireTypJwt: true,
            forbidKeySelectionHeaders: strict || !adapters.includes('legacy-jose-kid'),
            exactAudience: strict || !adapters.includes('legacy-introspection-token-audience'),
            opaqueClientIds: strict || !adapters.includes('legacy-organization-url-client-id'),
            enforceCertificateBinding: true
        },
        input: {
            rejectUnknownFields: true,
            validateProfiles: true,
            vocabularyAliases: adapters.includes('legacy-management-scope-cruds') ? ['system/*.cruds'] : []
        },
        token: {
            opaqueAccessTokens: true,
            accessTokenExpiresInSeconds: Number.isSafeInteger(configuredLifetime) && configuredLifetime > 0 ? configuredLifetime : tokenMaximumSeconds(config),
            allowAnyResource: false
        },
        exposure: {
            adminAuthentication: strict ? 'required' : 'configurable',
            demoUi: strict ? 'isolated' : 'enabled',
            bannerClass: strict ? 'primary' : 'warning',
            notice: strict ? '' : 'This compatibility profile is not strict conformance evidence.'
        },
        debug: {
            allowAnyTokenResource: false,
            allowExpiredTokens: !strict && Number.isSafeInteger(configuredLifetime) && configuredLifetime < 0
        },
        compatibility: {
            enabledAdapters: adapters,
            warnings: adapters.map(adapter => COMPATIBILITY_ADAPTER_CATALOG[adapter].warning)
        },
        deferred: {
            advancedScopeExpressions: 'fail-closed-sprint-25-deferred'
        },
        authorizationCeiling: AUTHORIZATION_CEILING,
        simulation,
        grantPolicy: require('./sandbox-grant-policy').clinicalGrantPolicy(config),
        invariants: { awsCredentialIsolation: 'always-on' }
    };
    assertCompletePolicy(policy);
    return deepFreeze(policy);
}

function assertCompletePolicy(policy) {
    for (const [section, fields] of Object.entries(POLICY_SHAPE)) {
        if (!policy[section] || typeof policy[section] !== 'object') throw new Error(`Policy section ${section} is missing`);
        for (const field of fields) {
            if (!Object.hasOwn(policy[section], field)) throw new Error(`Policy field ${section}.${field} is missing`);
        }
    }
    return true;
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const nested of Object.values(value)) deepFreeze(nested);
    return Object.freeze(value);
}

function effectivePolicyReport(policy) {
    assertCompletePolicy(policy);
    return {
        version: policy.version,
        mode: policy.mode,
        resultLabel: policy.resultLabel,
        strictConformanceClaim: policy.strictConformanceClaim,
        transport: policy.transport,
        trust: policy.trust,
        assertion: policy.assertion,
        input: policy.input,
        token: policy.token,
        exposure: policy.exposure,
        debug: policy.debug,
        compatibility: policy.compatibility,
        deferred: policy.deferred,
        authorizationCeiling: policy.authorizationCeiling,
        simulation: policy.simulation,
        grantPolicy: policy.grantPolicy,
        invariants: policy.invariants
    };
}

function compatibilityAdapterEnabled(policy, adapter) {
    return policy.compatibility.enabledAdapters.includes(adapter);
}

function applyModeWarningHeaders(res, policy) {
    if (policy.compatibility.enabledAdapters.length || policy.mode === 'connectathon') {
        res.setHeader('X-PCM-Conformance-Mode', 'connectathon');
        res.setHeader('X-PCM-Simulation-Preset', policy.simulation.preset);
        res.setHeader('Warning', '299 pcm-sandbox "Connectathon compatibility profile; not strict conformance evidence"');
    }
}

function logPolicyBanner(logger, component, policy) {
    const details = {
        type: 'CONFORMANCE_MODE',
        category: 'lifecycle', visibility: 'diagnostic', causesSystemFlow: false,
        component,
        policy: effectivePolicyReport(policy)
    };
    const message = `PCM conformance mode: ${policy.mode} (${policy.version})`;
    if (logger?.info) logger.info(message, details);
    else console.info(message, details);
}

/** Permit the private source simulation only for an explicitly configured connectathon runtime. */
function sandboxSourceChangesAllowed(config, env = process.env) {
    if (config?.conformance?.mode !== 'connectathon' || config.conformance.preset === 'strict') return false;
    try { return requestedMode(config, env) === 'connectathon'; }
    catch (_) { return false; } // Ambiguous runtime mode cannot authorize a private mutation.
}

module.exports = {
    serviceProviderOwnTokenIntrospection,
    sandboxSourceChangesAllowed,
    effectiveControls, REQUIRED_AUTHORIZATION_CONTROLS, EFFECTIVE_CONTROLS, NATIVE_FILTER_CONTROLS, presetSourceDefaults, validateSimulationDependencies, sourceSimulationControls, simulationPolicyStamp,
    AUTHORIZATION_CEILING,
    COMPATIBILITY_ADAPTER_CATALOG,
    CONFORMANCE_MODES,
    PRESETS,
    SIMULATION_CONTROLS,
    POLICY_SHAPE,
    POLICY_VERSION,
    applyModeWarningHeaders,
    assertCompletePolicy,
    buildEffectivePolicy,
    compatibilityAdapterEnabled,
    effectivePolicyReport,
    logPolicyBanner,
    presetSimulationDefaults,
    requestedMode,
    strictContradictions
};
