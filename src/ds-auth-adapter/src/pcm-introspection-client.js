'use strict';

/** Network orchestration for the two supported PCM introspection caller modes. */

const { guardedAxiosConfig, parseOutboundUrl } = require('../../shared/outbound-destination');
const logger = require('./logger');
const { ActiveIntrospectionCache } = require('./authorization-cache');
const { validateIntrospectionResponse } = require('./introspection-contract');
const {
    IntrospectionCredentialCache,
    assertion,
    bearerIntrospectionForm,
    bearerTokenForm,
    directIntrospectionForm,
    validateBearerResponse
} = require('./oauth-client');

class PcmIntrospectionClient {
    constructor(options) {
        if (!['bearer', 'direct'].includes(options.authMode)) throw new Error('PCM introspection auth mode must be bearer or direct');
        this.http = options.http;
        this.controls = require('../../shared/conformance-policy').effectiveControls(options.controls || {});
        this.authenticationSimulation = options.authenticationSimulation;
        this.workflowIdentities = options.workflowIdentities;
        this.presenceLimits = options.presenceLimits;
        this.syntheticWorkflowFixtures = options.syntheticWorkflowFixtures || [];
        this.allowSandboxGuid = options.allowSandboxGuid === true;
        this.httpsAgent = options.httpsAgent;
        this.clientId = options.clientId;
        this.privateKey = options.privateKey;
        parseOutboundUrl(options.tokenEndpoint);
        parseOutboundUrl(options.introspectionEndpoint);
        this.tokenEndpoint = options.tokenEndpoint;
        this.introspectionEndpoint = options.introspectionEndpoint;
        this.tokenRequestEndpoint = options.tokenRequestEndpoint || this.tokenEndpoint;
        this.introspectionRequestEndpoint = options.introspectionRequestEndpoint || this.introspectionEndpoint;
        parseOutboundUrl(this.tokenRequestEndpoint);
        parseOutboundUrl(this.introspectionRequestEndpoint);
        this.expectedIssuer = options.expectedIssuer;
        this.acceptedIssuers = options.acceptedIssuers || [options.expectedIssuer];
        this.expectedAudience = options.expectedAudience;
        this.hoId = options.hoId;
        this.authMode = options.authMode;
        this.timeout = options.timeout;
        this.secondsClock = options.secondsClock || (() => Math.floor(Date.now() / 1000));
        this.cache = options.cache || new ActiveIntrospectionCache({ clock: options.millisClock });
        // Only the exact configured logical token endpoint selects the test maximum;
        // transport URLs and tolerated issuer aliases cannot enlarge credential lifetime.
        const environment = Object.values(require('../../shared/pcm-environment').ENVIRONMENTS)
            .find(value => this.tokenEndpoint === `${value.base}/token`);
        this.credentialMaximumSeconds = environment?.tokenMaximumSeconds || 30;
        this.credentialCache = options.credentialCache || new IntrospectionCredentialCache({ clock: options.millisClock, maximumSeconds: this.credentialMaximumSeconds });
        this.binding = Object.freeze({ hoId: this.hoId, expectedAudience: this.expectedAudience, policyStamp: options.policyStamp,
            normalizationStamp: JSON.stringify({ authenticationSimulation: this.authenticationSimulation, workflowIdentities: this.workflowIdentities, presenceLimits: this.presenceLimits,
                syntheticWorkflowFixtures: this.syntheticWorkflowFixtures, allowSandboxGuid: this.allowSandboxGuid }) });
        this.authorityRevision = 0;
        this.observer = options.observer || (record => logger.info('Data Source authorization observation', record));
    }

    /** Observer errors never change network, cache or authorization outcomes. */
    observe(type, fields) {
        try { this.observer({ type, visibility: 'default', hoId: this.hoId, mode: this.authMode, ...fields }); } catch (_) { /* Diagnostic only. */ }
    }

    requestConfig(headers = {}) {
        // Read ALS at each real network call, never from the cached client or
        // token decision. Concurrent requests must not inherit another flow.
        return guardedAxiosConfig({
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...logger.getPropagationHeaders(), ...headers },
            httpsAgent: this.httpsAgent,
            timeout: this.timeout
        });
    }

    async getIntrospectionToken(attempt = 1) {
        const cached = this.credentialCache.get(value => this.observe('DS_CACHE_DECISION', value));
        if (cached) return cached;
        this.observe('DS_INTROSPECTION_ATTEMPT', { stage: 'credential', attempt, outcome: 'attempted' });
        const clientAssertion = assertion(this.clientId, this.tokenEndpoint, this.privateKey, this.secondsClock, this.httpsAgent?.options?.cert);
        const response = await this.http.post(
            this.tokenRequestEndpoint,
            bearerTokenForm(clientAssertion, this.introspectionEndpoint).toString(),
            this.requestConfig()
        );
        return this.credentialCache.put(validateBearerResponse(response.data, this.credentialMaximumSeconds));
    }

    async requestIntrospection(token, credential = null) {
        if (this.authMode === 'direct') {
            const clientAssertion = assertion(this.clientId, this.introspectionEndpoint, this.privateKey, this.secondsClock, this.httpsAgent?.options?.cert);
            return this.http.post(
                this.introspectionRequestEndpoint,
                directIntrospectionForm(token, clientAssertion).toString(),
                this.requestConfig()
            );
        }
        return this.http.post(
            this.introspectionRequestEndpoint,
            bearerIntrospectionForm(token).toString(),
            this.requestConfig({ Authorization: `Bearer ${credential}` })
        );
    }

    /**
     * Return a normalized decision. `fresh` independently evaluates current PCM
     * authority without reading or publishing an ordinary-search cache entry.
     * It must never join an older in-flight request if coalescing is added later.
     */
    async introspect(token, { fresh = false } = {}) {
        if (typeof token !== 'string' || !token) throw new Error('Opaque subject token is required');
        if (fresh) this.cache.invalidate(token, this.binding, value => this.observe('DS_CACHE_DECISION', value));
        const cached = fresh ? null : this.cache.get(token, this.binding, value => this.observe('DS_CACHE_DECISION', value));
        if (cached) return cached;
        const revision = this.authorityRevision;
        const attempts = this.authMode === 'bearer' ? 2 : 1;
        let response;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            let stage = 'credential';
            try {
                const credential = this.authMode === 'bearer' ? await this.getIntrospectionToken(attempt + 1) : null;
                stage = 'subject';
                this.observe('DS_INTROSPECTION_ATTEMPT', { stage: 'subject', attempt: attempt + 1, outcome: 'attempted' });
                response = await this.requestIntrospection(token, credential);
                this.observe('DS_INTROSPECTION_ATTEMPT', { stage: 'subject', attempt: attempt + 1, outcome: 'response', status: response.status });
                break;
            } catch (error) {
                const rejectedCredential = this.authMode === 'bearer'
                    && attempt === 0
                    && [401, 403].includes(error.response?.status);
                this.observe('DS_INTROSPECTION_ATTEMPT', { stage, attempt: attempt + 1, outcome: 'failed', status: error.response?.status, reasonCode: rejectedCredential ? 'CREDENTIAL_REJECTED' : error.reasonCode || 'PCM_TRANSPORT_FAILED' });
                if (!rejectedCredential) throw error;
                this.credentialCache.clear(value => this.observe('DS_CACHE_DECISION', value));
                this.observe('DS_INTROSPECTION_ATTEMPT', { stage: 'credential', attempt: attempt + 1, outcome: 'refresh-retry', reasonCode: 'CREDENTIAL_REFRESH' });
            }
        }
        if (!response) throw new Error('PCM introspection retry exhausted');
        const decision = validateIntrospectionResponse(response.data, {
            expectedIssuer: this.expectedIssuer,
            acceptedIssuers: this.acceptedIssuers,
            expectedAudience: this.expectedAudience,
            hoId: this.hoId,
            workflowIdentities: this.workflowIdentities, syntheticWorkflowFixtures: this.syntheticWorkflowFixtures, presenceLimits: this.presenceLimits,
            authenticationSimulation: this.authenticationSimulation,
            controls: this.controls, allowSandboxGuid: this.allowSandboxGuid,
            clock: this.secondsClock
        });
        if (!decision.active) {
            // An older in-flight active response must not republish a decision
            // after this actual authority loss. Unrelated tokens may simply miss cache.
            this.authorityRevision++;
            this.cache.invalidate(token, this.binding, value => this.observe('DS_CACHE_DECISION', value));
            return decision;
        }
        if (revision !== this.authorityRevision) return Object.freeze({ active: false });
        if (!fresh) this.cache.put(token, this.binding, decision);
        return decision;
    }
}

module.exports = { PcmIntrospectionClient };
