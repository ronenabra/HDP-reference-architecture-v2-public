'use strict';
/** Version-bound UI cancellation delegates to the same owning-provider lifecycle as public PUT. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { signingAlgorithm, jwkThumbprint, certificateConfirmation } = require('../../shared/assertion-keys');
const { SCOPES, CONSENT_POLICY } = require('../../shared/pcm-contract');
const { consentStatus } = require('../../shared/consent-status');
const { browserOrigin } = require('../../shared/browser-navigation');
const { environmentEndpoints, pcmTransportUrl } = require('../../shared/pcm-environment');
const { certPath } = require('./team-config');
const { requestJson } = require('./system-workflow-client');
const { cancelConsent, requesterId, consentBusinessStatus, ConsentLifecycleError, DEACTIVATE_PROFILE } = require('./fhir/consent-lifecycle');
const { organizationIsOperational, organizationRole } = require('./fhir/participant-lifecycle');
const secret = crypto.randomBytes(32);
const ROLES = ['serviceProvider', 'hospitalBServiceProvider'];

/** Bind the displayed version and selected provider to an unforgeable UI command. */
function csrf(id, version, providerRole) {
    return crypto.createHmac('sha256', secret).update(JSON.stringify([id, version, providerRole])).digest('base64url');
}

/** Describe eligibility from configured providers and current operational ownership. */
function cancellationView({ store, config, consent }) {
    const role = ROLES.find(key => config.organizations[key]?.id === requesterId(consent));
    const provider = role && store.get('Organization', config.organizations[role].id);
    const state = consentBusinessStatus(consent);
    const operational = role && organizationRole(provider) === 'service-provider' && organizationIsOperational(store, provider);
    return { providerRole: role || '', providerName: provider?.name || 'Unavailable provider',
        canCancel: Boolean(operational && ['requested', 'active'].includes(state)),
        reason: !operational ? 'The requesting organization is unavailable or is not currently authorized to cancel this consent.'
            : state === 'service-provider-cancelled' ? 'This consent has already been permanently cancelled.'
            : !['requested', 'active'].includes(state) ? 'Cancellation is unavailable for this consent status.' : '',
        version: consent.meta?.versionId, csrf: csrf(consent.id, consent.meta?.versionId, role || '') };
}

/** Obtain ordinary provider management authorization using its private backend credentials.
 * The resulting token remains on the server and is checked against the local issuance store.
 */
async function authorizeProvider({ config, providerRole, providerOrganization, tokenStore, transport = requestJson, clock = () => Date.now() }) {
    if (!Object.hasOwn(config.organizations, providerRole) || !config.organizations[providerRole]?.id || !config.organizations[providerRole]?.clientId || !config.certificateRoles?.[providerRole]) throw new ConsentLifecycleError('Provider credentials are unavailable', 403);
    const provider = config.organizations[providerRole];
    if (!ROLES.includes(providerRole) && (organizationRole(providerOrganization) !== 'service-provider' || providerOrganization.id !== provider.id)) throw new ConsentLifecycleError('Registered provider identity is required', 403);
    const endpoints = environmentEndpoints(config.contract.environment);
    const iat = Math.floor(clock() / 1000);
    const privateKey = fs.readFileSync(certPath(config, providerRole, 'key', 'assertion'));
    const assertion = jwt.sign({ iss: provider.clientId, sub: provider.clientId, aud: endpoints.tokenEndpoint,
        iat, exp: iat + 300, jti: crypto.randomUUID(), cnf: certificateConfirmation(fs.readFileSync(certPath(config, providerRole, 'cert', 'mtls'))) }, privateKey, { algorithm: signingAlgorithm(privateKey), header: { typ: 'JWT', kid: jwkThumbprint(privateKey) } });
    const tls = { ca: fs.readFileSync(path.join(process.env.CERTS_DIR || config.runtime.certsDir, config.certificates.rootCaCert)),
        cert: fs.readFileSync(certPath(config, providerRole, 'cert', 'mtls')), key: fs.readFileSync(certPath(config, providerRole, 'key', 'mtls')),
        rejectUnauthorized: require('../../shared/conformance-policy').buildEffectivePolicy(config).transport.serviceProviderToDataSource.verifyServerCertificate };
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion, scope: SCOPES.management, resource: endpoints.fhirBase });
    const response = await transport(pcmTransportUrl(endpoints.tokenEndpoint, config), { method: 'POST', body: body.toString(), tls,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeoutMilliseconds: 10000, maxBytes: 8192 });
    const issued = response.token_type === 'Bearer' && tokenStore.get(response.access_token);
    if (!issued || issued.kind !== 'management' || issued.exp <= iat || issued.aud !== endpoints.fhirBase
        || issued.client_id !== provider.clientId || issued.organization_id !== provider.id || issued.scope !== SCOPES.management) {
        throw new ConsentLifecycleError('Owning-provider authorization is unavailable', 403);
    }
    return { organizationId: issued.organization_id, clientId: issued.client_id };
}

/** Apply exactly one atomic cancellation; failures leave policy and first-use records unchanged. */
function applyCancellation({ store, consentId, expectedVersion, provider, operator, audit, clock = () => new Date() }) {
    return store.transaction(() => {
        const consent = store.get('Consent', consentId);
        if (!consent) throw new ConsentLifecycleError('Consent not found', 404);
        if (consent.meta?.versionId !== expectedVersion) throw new ConsentLifecycleError('Consent changed. Refresh and review the current record.', 409);
        const request = { resourceType: 'Consent', id: consentId, meta: { profile: [DEACTIVATE_PROFILE] }, status: 'inactive',
            scope: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'patient-privacy' }] },
            category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'INFA' }] }],
            policy: [{ authority: CONSENT_POLICY.authority, uri: CONSENT_POLICY.uri }] };
        const state = consentBusinessStatus(consent);
        const event = { consentId, operator, provider: provider.organizationId, providerClient: provider.clientId,
            previousState: state, newState: 'service-provider-cancelled', at: clock().toISOString(),
            previousVersion: expectedVersion, version: String(Number(expectedVersion) + 1) };
        const committed = cancelConsent({ store, consent, request, event, callerOrganization: store.get('Organization', provider.organizationId) });
        if (committed.meta.versionId !== expectedVersion) {
            const savedEvent = store.privateRecords.lifecycle.getEvents('Consent', consentId).at(-1);
            store.afterCommit(() => audit({ ...event, eventId: savedEvent.eventId }));
        }
        return committed;
    });
}

/** Build the private authenticated command; Admin middleware must precede this handler. */
function handler({ store, getConfig, tokenStore, audit, authorize = authorizeProvider }) {
    return async (req, res) => {
        const config = getConfig();
        try {
            const body = req.body;
            if (!body || Object.keys(body).length !== 3 || !['expectedVersion', 'providerRole', 'csrf'].every(key => typeof body[key] === 'string')
                || !/^[1-9][0-9]*$/.test(body.expectedVersion)) return res.status(400).json({ error: 'Closed version-bound cancellation command required' });
            const origin = req.get('origin');
            if (origin && origin !== browserOrigin(req)) return res.status(403).json({ error: 'Use the same-origin cancellation form' });
            const expected = csrf(req.params.id, body.expectedVersion, body.providerRole);
            if (Buffer.byteLength(expected) !== Buffer.byteLength(body.csrf) || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(body.csrf))) return res.status(403).json({ error: 'Refresh the Consent before cancelling' });
            const current = store.get('Consent', req.params.id);
            if (!current) return res.status(404).json({ error: 'Consent not found' });
            if (!ROLES.includes(body.providerRole) || config.organizations[body.providerRole]?.id !== requesterId(current)) return res.status(403).json({ error: 'Only the owning provider may cancel' });
            const provider = await authorize({ config, providerRole: body.providerRole, tokenStore });
            const committed = applyCancellation({ store, consentId: current.id, expectedVersion: body.expectedVersion, provider,
                operator: process.env.TEAM_ADMIN_PASSWORD ? 'team-admin' : 'sandbox-operator', audit });
            return res.json({ status: consentStatus(committed, Date.now(), store.privateRecords.lifecycle.getEvents('Consent', committed.id)), version: committed.meta.versionId });
        } catch (error) {
            return res.status(error.status || 503).json({ error: error.message, status: consentStatus(store.get('Consent', req.params.id), Date.now(), store.privateRecords.lifecycle.getEvents('Consent', req.params.id)) });
        }
    };
}
module.exports = { csrf, cancellationView, authorizeProvider, applyCancellation, handler };
