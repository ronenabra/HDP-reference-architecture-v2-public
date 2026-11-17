'use strict';

/** Source-specific request planning that never reuses a token across audiences. */
function planSourceAccess(consentId, endpoints, scope) {
    if (typeof consentId !== 'string' || !consentId) throw new TypeError('Consent id is required');
    if (!Array.isArray(endpoints) || new Set(endpoints.map(endpoint => endpoint.url)).size !== endpoints.length) {
        throw new TypeError('Discovered source endpoints must be a unique array');
    }
    if (typeof scope !== 'string' || !scope) throw new TypeError('Data Source scope is required');
    return endpoints.map(endpoint => ({
        consentId,
        sourceOrganizationId: endpoint.organizationId,
        endpointId: endpoint.endpointId,
        audience: endpoint.url,
        scope,
        tokenCachePartition: `${consentId}|${endpoint.url}|${scope}`
    }));
}

module.exports = { planSourceAccess };
