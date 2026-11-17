'use strict';
/** Server-only ordinary provider FHIR transport; Admin privilege supplies no provider authority. */
const { authorizeProvider } = require('./consent-cancellation');
const { requestJson } = require('./system-workflow-client');
const { environmentEndpoints, pcmTransportUrl } = require('../../shared/pcm-environment');

/** Obtain fresh provider authorization and return a narrowly scoped HealthcareService client.
 * @param {object} options Configuration, provider role, retained tokens and optional test transport.
 * @returns {Promise<object>} Authenticated search/read/register methods; credentials stay in closures.
 */
async function providerManagementClient({ config, providerRole, tokenStore, transport = requestJson, clock, store = require('./fhir/store') }) {
    let accessToken, tls;
    try {
        const providerOrganization = store.get('Organization', config.organizations[providerRole]?.id);
        require('./fhir/healthcare-service-lifecycle').assertOperationalServiceProvider(store, providerOrganization);
        await authorizeProvider({ config, providerRole, providerOrganization, tokenStore, ...(clock ? { clock } : {}), transport: async (url, request) => {
            tls = request.tls;
            const response = await transport(url, request);
            accessToken = response.access_token;
            return response;
        } });
    } catch (error) {
        throw Object.assign(new Error('This provider’s credentials or management permission are unavailable. Ask the sandbox administrator to check its registration and certificates.'), { status: error.status || 503 });
    }
    const base = pcmTransportUrl(environmentEndpoints(config.contract.environment).fhirBase, config);
    /** Send one closed regular API operation, preserving FHIR errors without exposing credentials. */
    async function send(suffix = '', method = 'GET', body) {
        try {
            return await transport(`${base}/HealthcareService${suffix}`, { method, body, tls, timeoutMilliseconds: 10000,
                acceptedStatuses: [200, 201], headers: { Accept: 'application/fhir+json', Authorization: `Bearer ${accessToken}`,
                    ...(body ? { 'Content-Type': 'application/fhir+json' } : {}) } });
        } catch (error) {
            const detail = error.body?.issue?.map(issue => issue.diagnostics || issue.details?.text).filter(Boolean).join(' ');
            throw Object.assign(new Error(detail || 'The regular PCM service API is unavailable or refused this provider’s request.'), { status: error.status || 503 });
        }
    }
    return {
        nextPage: (link, current) => {
            const url = new URL(link), expected = new URL(`${environmentEndpoints(config.contract.environment).fhirBase}/HealthcareService`);
            const keys = [...url.searchParams.keys()];
            const cursor = url.searchParams.get('_page');
            if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash || url.username || url.password
                || keys.length !== 1 || keys[0] !== '_page' || !cursor || cursor.length > 4096 || cursor === current) {
                throw new Error('The service API returned an invalid or cyclic page link.');
            }
            return cursor;
        },
        search: page => send(page ? `?_page=${encodeURIComponent(page)}` : ''),
        read: id => { if (!/^[A-Za-z0-9.-]{1,64}$/.test(id)) throw new TypeError('Invalid service reference'); return send(`/${id}`); },
        register: body => send('', 'POST', body),
        /** Use only the existing closed owner-status PUT; ownership is supplied by authentication. */
        status: (id, state) => {
            if (!/^[A-Za-z0-9.-]{1,64}$/.test(id) || !['active', 'suspended', 'cancelled'].includes(state)) throw new TypeError('Invalid owner status request');
            return send(`/${id}`, 'PUT', { resourceType: 'HealthcareService', id,
                extension: [require('./fhir/healthcare-service-lifecycle').statusExtension(state)] });
        }
    };
}
module.exports = { providerManagementClient };
