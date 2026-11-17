'use strict';
/** Keep only non-secret scalar fields on their exact failed Admin form. */
const allowed = new Set(['doctorBase', ...require('../admin-workflows').FIELDS.map(field => field.key), 'name', 'endpoint', 'clientId', 'institutionType', 'pcmClientAuthCertThumbprint',
    'serverTrustMode', 'serverTrustCaCert', 'serverTrustCertThumbprint', 'businessId', 'internalId',
    'dsGatewayToFhirServerCustomUrl', 'perSourceJson', 'preset', 'resetDefaults', 'accessTokenExpiresInSeconds', 'allowServiceProviderOwnTokenIntrospection', ...require('../../../shared/conformance-policy').SIMULATION_CONTROLS.map(name => `control.${name}`), 'credentialMode', 'credentialProfile', 'policy', 'bundleReference', 'expectedSource', ...[...require('../admin-source-limits').FIELDS, ...require('../admin-source-limits').QUERY_FIELDS].flatMap(field => [field.key, `mode.${field.key}`]), 'maxBytes', 'maxEntries']);

/** Files, passwords, keys, tokens and backup JSON are never part of returned form drafts. */
function draftValue(req, options, formPath, field, fallback = '') {
    if (!options.adminError || req?.path !== formPath || !allowed.has(field)) return fallback;
    return typeof req.body?.[field] === 'string' ? req.body[field] : fallback;
}
/** Keep checkbox draft choices only on the failed source/simulation form. */
function draftChecked(req, options, formPath, field, fallback = false) {
    const allowed = ['generateCertificate', 'reusePcmClientCertForServerTrust',
        ...require('../../../shared/conformance-policy').SIMULATION_CONTROLS.map(name => `control.${name}`)];
    if (!options.adminError || req?.path !== formPath || !allowed.includes(field)) return fallback;
    return req.body?.[field] === 'true' || req.body?.[field] === true;
}
module.exports = { draftValue, draftChecked };
