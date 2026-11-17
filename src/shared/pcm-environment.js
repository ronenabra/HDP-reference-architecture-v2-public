'use strict';

/** Exact PCM 0.4.0 logical identities, independent of local transport/security presets. */
const PCM_PATH = '/api/fhir-service/r4';
const ENVIRONMENTS = Object.freeze({
    production: Object.freeze({ base: `https://pcm2m.health.gov.il${PCM_PATH}`, tokenMaximumSeconds: 30 }),
    test: Object.freeze({ base: `https://pcm2mtest.health.gov.il${PCM_PATH}`, tokenMaximumSeconds: 86400 })
});
const LOGGING_EXCEPTION = 'PCM-SANDBOX-FULL-DIAGNOSTICS';
const AUTHORIZATION_DETAILS_TYPE = 'https://pcm.fhir.health.gov.il/authorization-details/fhir-data-access';

/** Return the exact shared operational base and OAuth endpoints for one environment. */
function environmentEndpoints(environment) {
    const selected = ENVIRONMENTS[environment];
    if (!selected) throw new TypeError('contract.environment must be production or test');
    return Object.freeze({
        oauthBase: selected.base,
        fhirBase: selected.base,
        authorizationEndpoint: `${selected.base}/authorize`,
        tokenEndpoint: `${selected.base}/token`,
        introspectionEndpoint: `${selected.base}/introspect`
    });
}

/** Return the environment's token lifetime maximum; sparse policy inputs default to production. */
function tokenMaximumSeconds(config = {}) {
    const environment = config.contract?.environment || 'production';
    environmentEndpoints(environment);
    return ENVIRONMENTS[environment].tokenMaximumSeconds;
}

/** Reject mixed logical environments and every URI alias instead of normalizing them. */
function validateEnvironment(config) {
    const errors = [];
    let endpoints;
    try { endpoints = environmentEndpoints(config?.contract?.environment); }
    catch (error) { return [error.message]; }
    for (const key of ['oauthBase', 'fhirBase']) {
        if (config.contract.operational?.[key] !== endpoints[key]) {
            errors.push(`contract.operational.${key} must exactly equal ${endpoints[key]}`);
        }
    }
    return errors;
}

/** Map only exact known logical PCM endpoints onto the selected local back-channel. */
function pcmTransportUrl(logicalUrl, config, { browser = false } = {}) {
    const endpoints = environmentEndpoints(config.contract.environment);
    const base = browser ? config.publicBaseUrls.pcmApi : config.internalBaseUrls.pcmAuth;
    if (typeof base !== 'string' || !base.endsWith(PCM_PATH)) throw new TypeError('PCM transport must use the shared operational path');
    const allowed = new Set(Object.values(endpoints));
    if (!allowed.has(logicalUrl)) throw new TypeError('Unrecognized or mixed-environment PCM endpoint');
    return `${base}${logicalUrl.slice(endpoints.oauthBase.length)}`;
}

module.exports = { AUTHORIZATION_DETAILS_TYPE, ENVIRONMENTS, LOGGING_EXCEPTION, PCM_PATH,
    environmentEndpoints, pcmTransportUrl, tokenMaximumSeconds, validateEnvironment };
