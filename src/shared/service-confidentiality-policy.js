'use strict';

/** Sandbox-owned policy for newly authored services; absence retains legacy semantics. */
const URL = 'urn:pcm:sandbox:service-confidentiality-policy';
const SYSTEM = 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality';

/** Validate closed policy input, independently of clinical sensitivity categories. */
function validatePolicy(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== 1 || typeof value.allowRestricted !== 'boolean') {
        throw new Error('Confidentiality policy requires only an explicit allowRestricted boolean; V cannot be included.');
    }
    return { allowRestricted: value.allowRestricted };
}

/** Encode an explicit authoring policy in the existing sandbox extension boundary. */
function policyExtension(value = { allowRestricted: false }) {
    const policy = validatePolicy(value);
    return { url: URL, extension: [{ url: 'allowRestricted', valueBoolean: policy.allowRestricted }] };
}

/** Read canonical metadata without writing a default into a legacy definition. */
function readPolicy(service) {
    const values = (service?.extension || []).filter(item => item.url === URL);
    if (!values.length) return null;
    const item = values[0], children = item.extension;
    if (values.length !== 1 || Object.keys(item).some(key => !['url', 'extension'].includes(key))
        || !Array.isArray(children) || children.length !== 1 || children[0]?.url !== 'allowRestricted'
        || Object.keys(children[0]).some(key => !['url', 'valueBoolean'].includes(key))) {
        throw new Error('Invalid service confidentiality policy extension.');
    }
    return validatePolicy({ allowRestricted: children[0].valueBoolean });
}

/** Return mandatory predicates for every ordinary complete grant alternative. */
function confidentialityFilters(policy, { patient = false } = {}) {
    if (!policy && patient) return []; // Preserve the established legacy Patient branch.
    return [ ...(policy && !policy.allowRestricted ? [`_security:not=${SYSTEM}|R`] : []), `_security:not=${SYSTEM}|V` ];
}

module.exports = { URL, SYSTEM, validatePolicy, policyExtension, readPolicy, confidentialityFilters };
