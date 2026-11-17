'use strict';
/** Contextual deployment explanations use authored copy plus escaped row metadata. */
function deploymentHelpKey(endpoint) {
    const key = endpoint.key;
    if (key === 'spClient') return 'admin.endpoint-doctor';
    if (key === 'pcmUi') return 'admin.endpoint-pcm-ui';
    if (key === 'pcmMetadata' || key === 'dataSourceMetadata') return 'admin.endpoint-metadata';
    if (key === 'pcmApi' || key === 'pcmAuth' || key === 'pcmFhir') return 'admin.endpoint-pcm-api';
    if (key.endsWith('AdapterInternal') || key === 'dsAuthAdapter') return 'admin.endpoint-adapter';
    if (key.endsWith('HapiInternal')) return 'admin.endpoint-hapi';
    if (/Gateway|referenceDataSource|teamDataSource/.test(key)) return 'admin.endpoint-gateway';
    return 'admin.endpoint-private';
}

/** Explain a concrete field in the context of its service, transport and configuration origin. */
function deploymentContext(endpoint, field) {
    const contexts = {
        service: `${endpoint.label}: ${endpoint.audience === 'internal' ? 'private container service' : 'public team listener'}.`,
        scope: `${endpoint.label} is ${endpoint.audience === 'internal' ? 'reachable only inside the team container network' : 'advertised to host/browser clients'}.`,
        url: `${endpoint.label}: API/configuration base ${endpoint.url}. ${endpoint.diagnosticUrl ? `Separate diagnostic/application link: ${endpoint.diagnosticUrl}.` : 'No browser landing page is advertised.'}`,
        scheme: `${endpoint.label} uses ${endpoint.scheme}: ${endpoint.scheme === 'https' ? 'TLS transport; client certificate requirements follow effective policy' : 'local HTTP transport'}.`,
        host: `${endpoint.host} identifies the ${endpoint.label} listener${endpoint.audience === 'internal' ? ' on the private container network' : ' in the advertised team address'}.`,
        port: `Port ${endpoint.port} belongs to ${endpoint.label}'s ${endpoint.audience} ${endpoint.scheme} listener.`,
        source: endpoint.source === 'request' ? `The ${endpoint.label} origin is taken from this Admin request.`
            : endpoint.source === 'derived-service' ? `The ${endpoint.label} address is derived from its named Compose service.`
                : `The ${endpoint.label} address is loaded from validated team configuration.`
    };
    return contexts[field];
}
module.exports = { deploymentHelpKey, deploymentContext };
