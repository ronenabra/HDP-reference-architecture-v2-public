'use strict';

/** Private, expiring PCM authentication state; browser handles never authorize data grants. */
const crypto = require('crypto');
const { normalizePatientIdentifier, isPatientLoginEligible } = require('../../shared/identity-mapping');
const { resolveHmoSource, sourceFingerprint } = require('./hmo-sources');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
/** Captured clocks and retry policy are never silently replaced on an existing flow. */
const workflowSettingsFingerprint = config => hash(JSON.stringify([config.systemAuthorization.otp,
    config.systemAuthorization.authentication, config.systemAuthorization.discovery]));

/** Isolated state for one PCM process; restart invalidates every outstanding flow. */
class SystemFlowStore {
    constructor(config, { clock = () => Math.floor(Date.now() / 1000), idGenerator = crypto.randomUUID, store = null } = {}) {
        this.config = config;
        this.store = store;
        this.clock = clock;
        this.idGenerator = idGenerator;
        this.flows = new Map();
        this.assertions = new Map();
        this.browserFeedback = new Map();
        this.cleanupOwners = new Set();
    }

    /** Remove expired state so completed and abandoned flows do not accumulate. */
    prune() {
        const now = this.clock();
        for (const [id, value] of this.flows) if (value.expiresAt <= now) this.cancel(id);
        for (const [id, value] of this.browserFeedback) if (value.expiresAt <= now) this.browserFeedback.delete(id);
        for (const [id, value] of this.assertions) if (value.expiresAt <= now) this.assertions.delete(id);
    }

    /** Keep bounded, expiring form feedback in the existing private browser state; it grants no authority. */
    feedback(browserBinding) {
        this.prune();
        const key = hash(browserBinding);
        if (!this.browserFeedback.has(key)) {
            if (this.browserFeedback.size >= 500) this.browserFeedback.delete(this.browserFeedback.keys().next().value);
            this.browserFeedback.set(key, { expiresAt: this.clock() + 600, generation: 0, input: {}, notice: null, showCodeFor: null });
        }
        return this.browserFeedback.get(key);
    }

    /** Begin a declared local HMO test target; later unique Patient/DOB/contact and OTP checks establish local identity. */
    begin({ identifier, birthDate, browserBinding, homeHmoId }, { syntheticFixture = false, enrolled = false } = {}) {
        this.prune();
        const patient = normalizePatientIdentifier(identifier);
        if (typeof birthDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)
            || !Number.isFinite(Date.parse(birthDate)) || new Date(birthDate).toISOString().slice(0, 10) !== birthDate
            || typeof browserBinding !== 'string' || browserBinding.length < 32) throw new Error('Authentication could not be started');
        const members = this.config.systemAuthorization.memberships.filter(member => normalizePatientIdentifier(member.identifier).key === patient.key);
        const member = members.length === 1 ? members[0] : null;
        if (patient.synthetic ? !(syntheticFixture && member?.sandboxFixture === true)
            : !isPatientLoginEligible(identifier, member?.loginEligibility)) throw new Error('Authentication could not be started');
        const source = resolveHmoSource(this.config, homeHmoId ?? ((syntheticFixture || enrolled) ? member?.homeHmoId : undefined),
            { store: this.store, allowManagedAlias: syntheticFixture || enrolled });
        const flow = { id: this.idGenerator(), identifier: { system: patient.system, value: patient.value }, birthDate,
            settingsFingerprint: workflowSettingsFingerprint(this.config),
            homeHmoId: source.id, sourceFingerprint: sourceFingerprint(source), ...(patient.synthetic ? { syntheticFixture: true } : {}), phase: 'authenticating', browserHash: hash(browserBinding),
            expiresAt: this.clock() + this.config.systemAuthorization.authentication.flowLifetimeSeconds,
            attempts: 0, resends: 0, createdAt: this.clock() };
        for (const previous of this.flows.values()) if (previous.browserHash === flow.browserHash) this.cancel(previous.id);
        this.flows.set(flow.id, flow);
        return flow.id;
    }

    /** Resolve a browser interaction with constant-time binding verification. */
    browserFlow(id, browserBinding, phase) {
        this.prune();
        const flow = this.flows.get(id);
        if (flow && !this.sourceCurrent(flow)) { this.cancel(id); throw new Error('The workflow settings or selected HMO changed or became unavailable. Restart this test.'); }
        if (!flow || !crypto.timingSafeEqual(Buffer.from(flow.browserHash), Buffer.from(hash(browserBinding)))
            || (phase && flow.phase !== phase)) throw new Error('Authentication flow is unavailable');
        return flow;
    }

    /** Return only a fresh copy of the server-authorized invocation for one registered client. */
    invocation(id, clientId) {
        this.prune();
        const flow = this.flows.get(id);
        if (!flow || !this.sourceCurrent(flow)) { if (flow) this.cancel(id); return null; }
        const auth = this.config.oauthClients.authenticationOrchestrator.clientId;
        const discovery = this.config.oauthClients.discoveryOrchestrator.clientId;
        if (!((clientId === auth && flow.phase === 'authenticating') || (clientId === discovery && flow.phase === 'authenticated'))) return null;
        return { id, clientId, identifier: structuredClone(flow.identifier), homeHmoId: flow.homeHmoId,
            phase: flow.phase, expiresAt: flow.expiresAt, ...(flow.syntheticFixture ? { syntheticFixture: true } : {}) };
    }

    /** Bind a freshly created private assertion to a flow before its mTLS HTTP exchange. */
    bindAssertion(id, clientId, jti) {
        const invocation = this.invocation(id, clientId);
        if (!invocation || typeof jti !== 'string' || !jti) throw new Error('Invocation cannot be bound');
        const key = `${clientId}\u0000${jti}`;
        if (this.assertions.has(key)) throw new Error('Invocation assertion already bound');
        this.assertions.set(key, { id, expiresAt: Math.min(invocation.expiresAt, this.clock() + 300) });
    }

    /** Inspect private invocation for budget validation without consuming its assertion binding. */
    peekAssertion(clientId, jti) {
        this.prune();
        const binding = this.assertions.get(`${clientId}\u0000${jti}`);
        return binding ? this.invocation(binding.id, clientId) : null;
    }

    /** Consume only server-created assertion bindings; no OAuth form handle is trusted. */
    consumeAssertion(clientId, jti) {
        this.prune();
        const key = `${clientId}\u0000${jti}`;
        const binding = this.assertions.get(key);
        this.assertions.delete(key);
        return binding ? this.invocation(binding.id, clientId) : null;
    }

    /** Invalidate current flow tokens immediately on cancellation or failed authentication. */
    cancel(id) {
        const flow = this.flows.get(id);
        if (flow) {
            delete flow.selectedPatient;
            flow.refreshGeneration = (flow.refreshGeneration || 0) + 1;
        }
        this.flows.delete(id);
        for (const [key, binding] of this.assertions) if (binding.id === id) this.assertions.delete(key);
        for (const owner of this.cleanupOwners) owner.clear?.(id);
    }

    /** Register once per process-local transport, even when request wrappers are recreated. */
    registerCleanup(owner) { this.cleanupOwners.add(owner); }

    /** Check object ownership as well as expiry before publishing asynchronous results. */
    isCurrent(flow) {
        this.prune();
        return this.flows.get(flow.id) === flow && this.sourceCurrent(flow);
    }

    /** Re-resolve current classification, endpoint and configured source trust before continuation. */
    sourceCurrent(flow) {
        try { return flow.settingsFingerprint === workflowSettingsFingerprint(this.config)
            && sourceFingerprint(resolveHmoSource(this.config, flow.homeHmoId, { store: this.store })) === flow.sourceFingerprint; }
        catch (_) { return false; }
    }

    /** Adopt current saved settings and clear obsolete flows/deliveries before new requests. */
    updateConfiguration(config) {
        this.config = config;
        for (const flow of this.flows.values()) if (!this.sourceCurrent(flow)) this.cancel(flow.id);
    }

    /** Dispose one team's transient state when the configured runtime is replaced. */
    dispose() {
        for (const id of this.flows.keys()) this.cancel(id);
        this.browserFeedback.clear();
        this.cleanupOwners.clear();
        this.assertions.clear();
    }
}

let configured;
/** Return the process-local replaceable identity-provider state for the loaded team. */
function getSystemFlowStore(config) {
    if (!configured || configured.config.teamId !== config.teamId) {
        configured?.dispose();
        configured = new SystemFlowStore(config, { store: require('./fhir/store') });
    }
    configured.updateConfiguration(config);
    return configured;
}

module.exports = { SystemFlowStore, getSystemFlowStore, hash, workflowSettingsFingerprint };
