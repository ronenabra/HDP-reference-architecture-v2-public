'use strict';

/**
 * Canonical structural and semantic validation for connectathon team files.
 *
 * The repository deliberately keeps this validator dependency-free so the
 * same contract runs in lifecycle CLIs and the small runtime containers.  The
 * structural evaluator implements the JSON Schema 2020-12 keywords used by
 * team-config.schema.json; semantic checks then enforce cross-field topology
 * and filesystem invariants that JSON Schema cannot express.
 */

const fs = require('fs');
const path = require('path');
const { buildEffectivePolicy, POLICY_VERSION, PRESETS } = require('./conformance-policy');
const { validateHealthOrganizations } = require('./health-organizations');
const { validateTeamContractConfig } = require('./pcm-contract');
const { PCM_PATH } = require('./pcm-environment');
const { validateSystemAuthorization } = require('./system-authorization-config');

const CONFIG_VERSION = 'pcm-team-config/5';

function valueType(value) {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    if (Number.isInteger(value)) return 'integer';
    return typeof value;
}

function resolvePointer(root, reference) {
    if (!reference.startsWith('#/')) throw new Error(`unsupported schema reference ${reference}`);
    return reference.slice(2).split('/').reduce((value, part) => value?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

function structuralErrors(value, schema, root = schema, field = '$') {
    if (schema === false) return [`${field} is prohibited`];
    if (!schema || typeof schema !== 'object') return [];
    if (schema.$ref) return structuralErrors(value, resolvePointer(root, schema.$ref), root, field);
    if (schema.anyOf && !schema.anyOf.some(candidate => structuralErrors(value, candidate, root, field).length === 0)) {
        return [`${field} does not match any allowed schema shape`];
    }
    if (schema.not && structuralErrors(value, schema.not, root, field).length === 0) return [`${field} uses a prohibited value`];
    const errors = (schema.allOf || []).flatMap(part => structuralErrors(value, part, root, field));
    if (schema.if) {
        const branch = structuralErrors(value, schema.if, root, field).length === 0 ? schema.then : schema.else;
        if (branch !== undefined) errors.push(...structuralErrors(value, branch, root, field));
    }
    if (schema.const !== undefined && value !== schema.const) errors.push(`${field} must equal ${JSON.stringify(schema.const)}`);
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${field} must be one of: ${schema.enum.join(', ')}`);
    if (schema.type) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        const actual = valueType(value);
        if (!types.includes(actual) && !(actual === 'integer' && types.includes('number'))) {
            errors.push(`${field} must be ${types.join(' or ')}`);
            return errors;
        }
    }
    if (typeof value === 'string') {
        if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push(`${field} exceeds maximum length ${schema.maxLength}`);
        if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${field} must not be empty`);
        if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${field} must match ${schema.pattern}`);
        if (schema.format === 'uri') {
            try {
                const parsed = new URL(value);
                if (!parsed.protocol) throw new Error('missing protocol');
            } catch (error) {
                errors.push(`${field} must be an absolute URI`);
            }
        }
    }
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${field} must be at least ${schema.minimum}`);
        if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${field} must be at most ${schema.maximum}`);
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${field} must contain at least ${schema.minItems} items`);
        if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${field} must contain at most ${schema.maxItems} items`);
        if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) errors.push(`${field} must contain unique items`);
        if (schema.items) value.forEach((item, index) => errors.push(...structuralErrors(item, schema.items, root, `${field}[${index}]`)));
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const required of schema.required || []) {
            if (!Object.hasOwn(value, required)) errors.push(`${field}.${required} is required`);
        }
        for (const [key, child] of Object.entries(value)) {
            if (schema.properties?.[key]) errors.push(...structuralErrors(child, schema.properties[key], root, `${field}.${key}`));
            else if (schema.additionalProperties === false) errors.push(`${field}.${key} is not allowed`);
            else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
                errors.push(...structuralErrors(child, schema.additionalProperties, root, `${field}.${key}`));
            }
        }
        if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) errors.push(`${field} must contain at least ${schema.minProperties} properties`);
    }
    return errors;
}

function safeRelative(value) {
    return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value)
        && !value.split(/[\\/]+/).includes('..');
}

function semanticErrors(config, options = {}) {
    const errors = [
        ...validateTeamContractConfig(config),
        ...validateHealthOrganizations(config),
        ...validateSystemAuthorization(config),
        ...(() => { try { require('./clinical-query-limits').clinicalQueryLimits(config); return []; } catch (error) { return [error.message]; } })()
    ];
    try { require('./source-registration-history').validateSourceRegistrationHistory(config); } catch (error) { errors.push(error.message); }
    if (!['connectathon-easy', 'connectathon-balanced'].includes(config.conformance?.preset) && (config.organizations?.dataSources || []).some(source => source.serverTrust?.mode === 'insecure-skip-verify')) errors.push('Source skip verification is unavailable in this security preset; choose verified server trust before changing presets');
    if (config.serviceCatalog) {
        if (!safeRelative(config.serviceCatalog.file)) errors.push('serviceCatalog.file requires a safe relative path');
        for (const binding of config.serviceCatalog.bindings || []) {
            if (!['serviceProvider', 'hospitalBServiceProvider'].includes(binding.providerRole)) errors.push('Catalog binding requires a registered Service Provider role');
            if (!/^[A-Za-z0-9.-]{1,64}$/.test(binding.instanceId || '')) errors.push('Catalog instanceId must be a FHIR logical ID');
        }
    }
    try { require('./log-event').configuredExtensionSources(config); } catch (error) { errors.push(error.message); }
    if (config.configVersion !== CONFIG_VERSION) errors.push(`configVersion must be ${CONFIG_VERSION}; legacy configuration requires coordinated scope migration (no startup conversion)`);
    try { require('./sandbox-grant-policy').clinicalGrantPolicy(config); } catch (error) { errors.push(error.message); }
    if (!PRESETS.includes(config.conformance?.preset)) errors.push(`conformance.preset must be one of: ${PRESETS.join(', ')}`);
    const expectedMode = config.conformance?.preset === 'strict' ? 'strict' : 'connectathon';
    if (config.conformance?.mode !== expectedMode) errors.push(`conformance.mode must be ${expectedMode} for ${config.conformance?.preset}`);
    if (config.conformance?.policyVersion !== POLICY_VERSION) errors.push(`conformance.policyVersion must be ${POLICY_VERSION}`);
    const presetValues = {
        'connectathon-easy': { pcmClientAuth: 'tls', gatewayClientAuth: 'tls', ttl: 300, upstream: 'https' },
        'connectathon-balanced': { pcmClientAuth: 'tls', gatewayClientAuth: 'tls', ttl: 300, upstream: 'https' },
        'connectathon-mtls': { pcmClientAuth: 'mtls', gatewayClientAuth: 'mtls', ttl: 300, upstream: 'https' },
        strict: { pcmClientAuth: 'mtls', gatewayClientAuth: 'mtls', ttl: 30, upstream: 'https' }
    }[config.conformance?.preset];
    if (presetValues) {
        if (config.security?.pcmApi?.clientAuth !== presetValues.pcmClientAuth) errors.push(`security.pcmApi.clientAuth must be ${presetValues.pcmClientAuth} for ${config.conformance.preset}`);
        if (config.security?.dataSourceGateway?.clientAuth !== presetValues.gatewayClientAuth) errors.push(`security.dataSourceGateway.clientAuth must be ${presetValues.gatewayClientAuth} for ${config.conformance.preset}`);
        if (config.security?.dsGatewayToFhirServer?.protocol !== presetValues.upstream) errors.push(`security.dsGatewayToFhirServer.protocol must be ${presetValues.upstream} for ${config.conformance.preset}`);
    }
    for (const [section, key] of [['publicBaseUrls', 'pcmApi'], ['publicBaseUrls', 'pcmMetadata'], ['internalBaseUrls', 'pcmAuth'], ['internalBaseUrls', 'pcmFhir']]) {
        try {
            const value = config[section]?.[key];
            const parsed = new URL(value);
            if (parsed.protocol !== 'https:' || value !== `${parsed.origin}${PCM_PATH}`) throw new Error('invalid operational transport');
        } catch (_) { errors.push(`${section}.${key} must be an exact HTTPS origin plus ${PCM_PATH}`); }
    }
    if (config.internalBaseUrls?.pcmAuth !== config.internalBaseUrls?.pcmFhir) errors.push('PCM internal OAuth and FHIR bases must match');
    const urls = [];
    for (const section of ['publicBaseUrls', 'internalBaseUrls']) {
        for (const [key, raw] of Object.entries(config[section] || {})) {
            const values = raw && typeof raw === 'object' ? Object.entries(raw) : [[key, raw]];
            for (const [nestedKey, value] of values) {
                const field = raw && typeof raw === 'object' ? `${section}.${key}.${nestedKey}` : `${section}.${key}`;
                if (value === '' && ['teamDataSource'].includes(key)) continue;
                try {
                    const parsed = new URL(value);
                    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
                    urls.push({ path: field, parsed });
                } catch (error) {
                    errors.push(`${field} must be an absolute HTTP or HTTPS URL`);
                }
            }
        }
    }
    for (const field of ['certsDir', 'logsDir', 'stateDir']) {
        const value = config.runtime?.[field];
        if (typeof value !== 'string' || !value.trim()) errors.push(`runtime.${field} is required`);
        if (options.requireRelativeRuntimePaths && !safeRelative(value)) errors.push(`runtime.${field} must be a safe relative path`);
    }
    const ports = urls.filter(item => /^(publicBaseUrls\.(spClient|pcmUi|pcmApi|pcmMetadata)|publicBaseUrls\.healthOrganizations\.)/.test(item.path))
        .filter(item => item.parsed.port).map(item => Number(item.parsed.port));
    const duplicates = ports.filter((port, index) => port && ports.indexOf(port) !== index);
    if (duplicates.length) errors.push(`configured public/gateway ports must be unique; duplicate ${duplicates[0]}`);
    if (typeof config.security?.dsFhirServer?.enforceMappedPatients !== 'boolean') errors.push('security.dsFhirServer.enforceMappedPatients must be boolean');
    const expectedPatientMapping = true;
    if (config.security?.dsFhirServer?.enforceMappedPatients !== expectedPatientMapping) errors.push(`security.dsFhirServer.enforceMappedPatients must be ${expectedPatientMapping} for ${config.conformance?.preset}`);
    try {
        buildEffectivePolicy(config, options.env || {});
    } catch (error) {
        errors.push(error.message);
    }
    if (options.checkFiles) {
        const certsDir = options.certsDir;
        if (!certsDir) errors.push('certificate validation requires certsDir');
        const names = new Set([
            config.certificates?.rootCaCert,
            ...Object.values(config.certificateRoles || {}).flatMap(participant => Object.values(participant || {}).flatMap(role => [role.cert, role.key])),
            ...(config.healthOrganizations || []).flatMap(ho => Object.values(ho.certificates || {}))
        ].filter(Boolean));
        for (const name of names) {
            if (!safeRelative(name)) errors.push(`certificate path ${name} must be safe and relative`);
            else if (certsDir && !fs.existsSync(path.join(certsDir, name))) errors.push(`certificate file is missing: ${name}`);
        }
    }
    return [...new Set(errors)];
}

function validateTeamConfig(config, options = {}) {
    const schemaPath = options.schemaPath || [
        path.resolve(__dirname, '../../pcm-connectathon/team-config.schema.json'),
        '/workspace/pcm-connectathon/team-config.schema.json'
    ].find(candidate => fs.existsSync(candidate));
    let schema;
    try {
        schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    } catch (error) {
        return { valid: false, errors: [`team configuration schema could not be loaded from ${schemaPath}: ${error.message}`] };
    }
    const errors = [
        ...structuralErrors(config, schema),
        ...semanticErrors(config, options)
    ];
    return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function assertValidTeamConfig(config, options = {}) {
    const result = validateTeamConfig(config, options);
    if (!result.valid) throw new TypeError(`team configuration is invalid: ${result.errors.join('; ')}`);
    return config;
}

/** Read one selected runtime file and apply the canonical current contract. */
function readTeamConfig(filePath, options = {}) {
    if (!filePath) throw new Error('A complete v4 team configuration is required; set TEAM_CONFIG_PATH');
    const config = assertValidTeamConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')), options);
    if (config.serviceCatalog) require('./service-catalog').loadServiceCatalog(config, { teamDirectory: path.dirname(filePath) });
    return config;
}

module.exports = {
    readTeamConfig,
    CONFIG_VERSION,
    PRESETS,
    assertValidTeamConfig,
    semanticErrors,
    structuralErrors,
    validateTeamConfig
};
