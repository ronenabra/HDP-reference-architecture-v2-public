'use strict';

/**
 * PCM-IG 0.4.0 request parsing, independent of authentication/replay state.
 *
 * The parser returns an untrusted requested ceiling and business identifiers.
 * It never grants access: the policy evaluator must resolve the basis, scenario,
 * application entitlement, target and invocation context before issuance.
 */
const { TextDecoder } = require('util');
const { DEFAULTS } = require('../../shared/presence-limits');
const { normalizePatientIdentifier } = require('../../shared/identity-mapping');

const TYPE = 'https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access';
const ROLE_BASE = 'https://pcm.fhir.health.gov.il/fhir-context-role/';
const BASIS_SYSTEMS = Object.freeze({
    Consent: 'http://pcm.fhir.health.gov.il/identifier/pcm-consent-id',
    Contract: 'http://pcm.fhir.health.gov.il/identifier/pcm-data-access-authorization-id'
});
const RAR_BYTES = DEFAULTS.maxRarBytes;
const FORM_BYTES = DEFAULTS.maxFormBytes;
const RAW_BYTES = DEFAULTS.maxEncodedFormBytes;
const MAX_PATIENTS = DEFAULTS.maxPatients;

/** An OAuth error which can be returned without exposing resolved identities. */
class RequestError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'RequestError';
        this.code = code;
    }
}

/** Reject a closed-schema violation with the caller-selected OAuth error. */
function reject(code, message) { throw new RequestError(code, message); }

/** Return whether an ordinary JSON object has precisely the named members. */
function exactObject(value, members) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === members.length
        && members.every(member => Object.hasOwn(value, member));
}

/** Decode a bounded URL-encoded body once, retaining duplicate-field detection. */
function parseForm(raw, limits = DEFAULTS) {
    if (!Buffer.isBuffer(raw) && typeof raw !== 'string') reject('invalid_request', 'Expected an encoded form');
    if (Buffer.byteLength(raw) > limits.maxEncodedFormBytes) reject('invalid_request', 'Raw OAuth body exceeds its limit');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(raw)); }
    catch (_) { reject('invalid_request', 'OAuth form is not UTF-8'); }
    const values = Object.create(null);
    let decodedBytes = 0;
    const fields = text.split('&');
    for (const [index, field] of fields.entries()) {
        if (!field) reject('invalid_request', 'Empty OAuth form field');
        const separator = field.indexOf('=');
        if (separator < 1) reject('invalid_request', 'OAuth form fields require names and values');
        let name, value;
        try {
            name = decodeURIComponent(field.slice(0, separator).replace(/\+/g, ' '));
            value = decodeURIComponent(field.slice(separator + 1).replace(/\+/g, ' '));
        } catch (_) { reject('invalid_request', 'Invalid form encoding'); }
        decodedBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 1 + (index ? 1 : 0);
        if (decodedBytes > limits.maxFormBytes) reject('invalid_request', 'Decoded OAuth form exceeds its limit');
        if (Object.hasOwn(values, name)) {
            reject(name === 'resource' ? 'invalid_target' : 'invalid_request', 'Repeated singleton form parameter');
        }
        values[name] = value;
    }
    return values;
}

/** Parse JSON without silently accepting duplicate members or excessive nesting. */
function parseUniqueJson(text) {
    let result;
    try { result = JSON.parse(text); }
    catch (_) { reject('invalid_authorization_details', 'Malformed authorization details JSON'); }
    // JSON.parse already proved lexical correctness. Token traversal detects
    // duplicate decoded keys (including escaped aliases) before any claim use.
    const tokens = text.match(/"(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,]/g) || [];
    let position = 0;
    function visit(depth) {
        if (depth > 32) reject('invalid_authorization_details', 'Authorization details nesting exceeds its limit');
        const token = tokens[position++];
        if (token === '{') {
            const keys = new Set();
            if (tokens[position] === '}') { position++; return; }
            do {
                const key = JSON.parse(tokens[position++]);
                if (keys.has(key)) reject('invalid_authorization_details', 'Duplicate authorization details member');
                keys.add(key);
                position++; // colon, already checked by JSON.parse
                visit(depth + 1);
            } while (tokens[position++] === ',');
        } else if (token === '[') {
            if (tokens[position] === ']') { position++; return; }
            do { visit(depth + 1); } while (tokens[position++] === ',');
        }
    }
    visit(0);
    return result;
}

/** Parse the one RAR value into a closed, semantically distinct request shape. */
function parseAuthorizationDetails(encoded, limits = DEFAULTS) {
    if (typeof encoded !== 'string') reject('invalid_request', 'Exactly one authorization_details value is required');
    if (Buffer.byteLength(encoded) > limits.maxRarBytes) reject('invalid_request', 'Decoded authorization details exceeds its limit');
    const details = parseUniqueJson(encoded);
    if (!Array.isArray(details) || details.length !== 1
        || !exactObject(details[0], ['type', 'fhirContext']) || details[0].type !== TYPE) {
        reject('invalid_authorization_details', 'Expected exactly one PCM authorization details object');
    }
    const context = details[0].fhirContext;
    if (!Array.isArray(context) || context.length < 1 || context.length > limits.maxPatients + 1) {
        reject('invalid_authorization_details', 'Invalid authorization context cardinality');
    }
    let basis = null;
    const patients = [];
    const seen = new Set();
    for (const item of context) {
        if (!exactObject(item, ['type', 'role', 'identifier'])
            || !exactObject(item.identifier, ['system', 'value'])
            || typeof item.identifier.system !== 'string' || !item.identifier.system
            || typeof item.identifier.value !== 'string' || !item.identifier.value) {
            reject('invalid_authorization_details', 'Invalid context item or identifier');
        }
        const identity = JSON.stringify([item.type, item.identifier.system, item.identifier.value]);
        if (seen.has(identity)) reject('invalid_authorization_details', 'Duplicate context identity');
        seen.add(identity);
        if (Object.hasOwn(BASIS_SYSTEMS, item.type)) {
            if (basis || item.role !== `${ROLE_BASE}authorization-basis`
                || item.identifier.system !== BASIS_SYSTEMS[item.type]
                || [...item.identifier.value].length > 128) {
                reject('invalid_authorization_details', 'Invalid authorization basis');
            }
            basis = item;
        } else if (item.type === 'Patient' && item.role === `${ROLE_BASE}authorization-patient`) {
            try { normalizePatientIdentifier(item.identifier, { maxLength: 128 }); }
            catch (_) { reject('invalid_authorization_details', 'Unsupported Patient identifier'); }
            patients.push(item.identifier);
        } else {
            reject('invalid_authorization_details', 'Caller context type or role is prohibited');
        }
    }
    if (!basis || (basis.type === 'Consent' && patients.length)) {
        reject('invalid_authorization_details', 'Context does not match a supported request shape');
    }
    return {
        details,
        basis,
        patients,
        shape: basis.type === 'Consent' ? 'consent' : patients.length ? 'patient-policy' : 'contract-only'
    };
}

/** Validate syntax and optionally supported resource types for an unfiltered ceiling. */
function parseScopeCeiling(scope, supportedTypes = null) {
    if (typeof scope !== 'string' || !/^(?:patient|system)\/[A-Z][A-Za-z]+\.(?:r|s|rs)(?: (?:patient|system)\/[A-Z][A-Za-z]+\.(?:r|s|rs))*$/.test(scope)) {
        reject('invalid_scope', 'Expected an unfiltered resource and interaction ceiling');
    }
    const seen = new Set();
    let family;
    return scope.split(' ').map(value => {
        const [, context, resource, interaction] = /^(patient|system)\/([A-Za-z]+)\.(r|s|rs)$/.exec(value);
        if ((family && context !== family) || seen.has(resource)
            || (supportedTypes && !supportedTypes.has(resource))) {
            reject('invalid_scope', 'Duplicate, mixed or unsupported resource ceiling');
        }
        family = context;
        seen.add(resource);
        return { context, resource, interaction };
    });
}

/** Validate scenario-specific cardinality after trusted Contract subtype resolution. */
function validateScenarioRequest(request, scope, scenario, { syntheticFixture = false } = {}) {
    const ceiling = parseScopeCeiling(scope);
    if (scenario === 'consent-access') {
        if (request.shape !== 'consent') {
            reject('invalid_authorization_details', 'Consent context does not match the scenario');
        }
        if (ceiling.some(item => item.context !== 'patient')) reject('invalid_scope', 'Consent requires patient ceilings');
    } else if (scenario === 'presence-check' || scenario === 'patient-authentication') {
        if (request.shape !== 'patient-policy' || (scenario === 'patient-authentication' && request.patients.length !== 1)) {
            reject('invalid_authorization_details', 'Patient context does not match the scenario');
        }
        const expected = scenario === 'presence-check' ? 'system/Patient.s' : 'patient/Patient.s';
        if (scope !== expected) reject('invalid_scope', 'Scope does not match the system scenario');
        if (scenario === 'patient-authentication' && !syntheticFixture
            && request.patients[0].system === 'http://fhir.health.gov.il/identifier/il-hdp-test-id') {
            reject('invalid_authorization_details', 'Test identifiers cannot authenticate a person');
        }
    } else if (scenario === 'sandbox-patient-sample') {
        if (request.shape !== 'contract-only') reject('invalid_authorization_details', 'Sampling accepts only its Contract');
        if (scope !== 'system/Patient.s') reject('invalid_scope', 'Sampling permits only Patient search');
    } else if (scenario === 'dependent-discovery') {
        if (request.shape !== 'contract-only') reject('invalid_authorization_details', 'Discovery accepts only its Contract');
        if (ceiling.length !== 2 || ceiling.some(item => item.context !== 'system' || item.interaction !== 's')
            || !ceiling.some(item => item.resource === 'Patient') || !ceiling.some(item => item.resource === 'RelatedPerson')) {
            reject('invalid_scope', 'Discovery requires both prescribed search ceilings');
        }
    } else { reject('invalid_authorization_details', 'Unsupported authorization scenario'); }
    return ceiling;
}

module.exports = {
    BASIS_SYSTEMS, FORM_BYTES, MAX_PATIENTS, RAR_BYTES, RAW_BYTES, ROLE_BASE, TYPE, RequestError,
    parseAuthorizationDetails, parseForm, parseScopeCeiling, parseUniqueJson, validateScenarioRequest
};
