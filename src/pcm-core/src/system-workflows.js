'use strict';

/** Local-only OTP authentication and bounded presence/dependent-discovery orchestration. */
const { hmoSources, resolveHmoSource, sourceFingerprint } = require('./hmo-sources');
const crypto = require('crypto');
const { normalizePatientIdentifier } = require('../../shared/identity-mapping');
const { LOGGING_EXCEPTION } = require('../../shared/pcm-environment');
const { presenceLimits, MAXIMA } = require('../../shared/presence-limits');
const { hash } = require('./system-flow-store');
const CONTACT_EVIDENCE = 'http://pcm.fhir.health.gov.il/sandbox/StructureDefinition/contact-verification';
const OTP_PURPOSE = 'http://hl7.org/fhir/StructureDefinition/contactpoint-purpose';
const PURPOSE_SYSTEM = 'http://fhir.health.gov.il/cs/il-core-contact-point-purpose';
const exactIdentity = (values, identifier) => Array.isArray(values) && values.some(value => value.system === identifier.system && value.value === identifier.value);
const fail = () => { throw new Error('The requested workflow could not be completed'); };

/** Select one currently usable, explicitly OTP-marked contact with local HMO freshness evidence. */
function selectOtpContact(patient, settings, now) {
    const eligible = (patient.telecom || []).filter(contact => {
        const purpose = (contact.extension || []).filter(extension => extension.url === OTP_PURPOSE);
        if (purpose.length !== 1 || !purpose[0].valueCodeableConcept?.coding?.some(coding => coding.system === PURPOSE_SYSTEM && coding.code === 'OTP')) return false;
        const evidence = (contact.extension || []).filter(extension => extension.url === CONTACT_EVIDENCE);
        if (evidence.length !== 1) return false;
        const verified = (evidence[0].extension || []).filter(item => item.url === 'verifiedAt');
        const verifiedAt = Date.parse(verified[0]?.valueDateTime) / 1000;
        if (verified.length !== 1 || !Number.isFinite(verifiedAt) || verifiedAt > now || now - verifiedAt > settings.contactMaxAgeSeconds) return false;
        if (contact.period?.start && !(Date.parse(contact.period.start) / 1000 <= now)) return false;
        if (contact.period?.end && !(Date.parse(contact.period.end) / 1000 > now)) return false;
        if (typeof contact.value !== 'string' || !contact.value || contact.use === 'old') return false;
        if (contact.system === 'sms') return settings.channels.includes('sms');
        if (contact.system === 'phone' && contact.use === 'mobile') {
            const usability = (evidence[0].extension || []).filter(item => item.url === 'smsUsable');
            return settings.channels.includes('sms') && usability.length === 1 && usability[0].valueBoolean === true;
        }
        return contact.system === 'email' && settings.channels.includes('email');
    });
    if (eligible.length !== 1) fail();
    return { channel: eligible[0].system === 'email' ? 'email' : 'sms', destination: eligible[0].value };
}

/** Validate a search response before any Patient demographics enter authentication state. */
function authenticationPatient(bundle, identifier, birthDate) {
    if (bundle?.resourceType !== 'Bundle' || bundle.type !== 'searchset' || bundle.link?.some(link => link.relation === 'next')
        || !Array.isArray(bundle.entry) || bundle.entry.length !== 1 || (bundle.total !== undefined && bundle.total !== 1)) fail();
    const entry = bundle.entry[0];
    const patient = entry.resource;
    if ((entry.search?.mode && entry.search.mode !== 'match') || patient?.resourceType !== 'Patient'
        || !exactIdentity(patient.identifier, identifier) || patient.birthDate !== birthDate) fail();
    return patient;
}

/** Refuse continuation aliases or links escaping the exact selected source. */
function continuationUrl(base, link, resourceType) {
    if (typeof link !== 'string') fail();
    let url;
    try { url = new URL(link); } catch (_) { fail(); }
    if (url.href !== link || url.username || url.password || url.hash || !link.startsWith(`${base}/`) && !link.startsWith(`${base}?`)) fail();
    const target = new URL(base);
    if (url.origin !== target.origin || ![target.pathname, `${target.pathname}/`, `${target.pathname}/${resourceType}`].includes(url.pathname)
        || /%2f|%5c|%2e/i.test(link)) fail();
    return link;
}

/** Return source-local qualified dependents using each same RelatedPerson record. */
function joinDependents(patients, relatedPeople, representative, eligibleRelationships, base, { syntheticFixture = false } = {}) {
    const byId = new Map();
    for (const patient of patients) {
        if (patient.resourceType !== 'Patient' || typeof patient.id !== 'string' || !patient.id || byId.has(patient.id)) fail();
        byId.set(patient.id, patient);
    }
    const result = new Map();
    for (const related of relatedPeople) {
        if (related.resourceType !== 'RelatedPerson') fail();
        if (!exactIdentity(related.identifier, representative) || related.active !== true) continue;
        if (!(related.relationship || []).some(concept => (concept.coding || []).some(coding =>
            eligibleRelationships.some(allowed => allowed.system === coding.system && allowed.code === coding.code)))) continue;
        const reference = related.patient?.reference;
        const local = typeof reference === 'string' && reference.startsWith(`${base}/`) ? reference.slice(base.length + 1) : reference;
        const match = /^Patient\/([A-Za-z0-9.-]{1,64})$/.exec(local || '');
        const patient = match && byId.get(match[1]);
        if (!match) continue;
        if (!patient) throw Object.assign(new Error('Relationship join changed during discovery'), { code: 'RACING_JOIN' });
        const strong = (patient.identifier || []).flatMap(value => {
            try { const normalized = normalizePatientIdentifier(value); return normalized.synthetic && !syntheticFixture ? [] : [normalized]; } catch (_) { return []; }
        });
        // Conflicting supported business identities are not silently reconciled.
        const identities = [...new Map(strong.map(value => [value.key, value])).values()];
        if (!identities.length) continue;
        if (identities.length !== 1) fail();
        strong.splice(0, strong.length, ...identities);
        if (!related.id) throw Object.assign(new Error('Relationship evidence has no logical id'), { code: 'RACING_JOIN' });
        const evidence = { relationshipId: related.id, relationshipVersion: related.meta?.versionId || null,
            patientVersion: patient.meta?.versionId || null, active: true,
            relationship: structuredClone(related.relationship), decision: 'eligible' };
        const existing = result.get(strong[0].key);
        if (existing && existing.patientId !== patient.id) fail();
        if (existing) existing.evidence.push(evidence);
        else result.set(strong[0].key, { identifier: { system: strong[0].system, value: strong[0].value },
            name: patient.name || [], patientId: patient.id, evidence: [evidence] });
    }
    return [...result.values()];
}

/** Replaceable fabricated transport: codes are visible only through explicit local diagnostics. */
class LocalOtpTransport {
    constructor({ clock = () => Date.now() / 1000, schedule = setTimeout, unschedule = clearTimeout } = {}) {
        Object.assign(this, { clock, schedule, unschedule });
        this.deliveries = new Map();
        this.timers = new Map();
    }

    /** Replace a current delivery and reclaim it at expiry without requiring another request. */
    async send(delivery) {
        this.clear(delivery.flowId);
        if (delivery.expiresAt <= this.clock() || delivery.isCurrent?.() === false) return;
        this.deliveries.set(delivery.flowId, { ...delivery, transport: 'local-synthetic' });
        const timer = this.schedule(() => this.clear(delivery.flowId), (delivery.expiresAt - this.clock()) * 1000);
        timer?.unref?.();
        this.timers.set(delivery.flowId, timer);
    }

    /** A code is inspectable only while its owning flow and OTP are both current. */
    inspect(flowId) {
        const delivery = this.deliveries.get(flowId);
        if (delivery && (delivery.expiresAt <= this.clock() || delivery.isCurrent?.() === false)) this.clear(flowId);
        return this.deliveries.get(flowId) || null;
    }

    /** Idempotently dispose just this flow's delivery and expiry timer. */
    clear(flowId) {
        this.unschedule(this.timers.get(flowId));
        this.timers.delete(flowId);
        this.deliveries.delete(flowId);
    }

    /** Dispose old-team timers before replacing the runtime transport. */
    dispose() { for (const id of this.deliveries.keys()) this.clear(id); }
}

/** Orchestrate read-only source calls through an injected, mTLS-capable client. */
class SystemWorkflows {
    constructor({ config, flows, request, store = null, presenceStore = null, transport = null, clock = null, clockMilliseconds = null, codeGenerator = () => String(crypto.randomInt(100000, 1000000)), logger = { info() {} } }) {
        Object.assign(this, { config, flows, request, store, presenceStore, codeGenerator, logger });
        this.clock = clock || (() => Math.floor(Date.now() / 1000));
        this.clockMilliseconds = clockMilliseconds || (clock ? () => clock() * 1000 : () => Date.now());
        this.identityProvider = new (require('./sandbox-identity-provider').LocalTrustedSsoProvider)(config, { clock: this.clock });
        this.transport = transport || new LocalOtpTransport({ clock: this.clock });
        flows.registerCleanup(this.transport);
    }

    /** Fetch exactly one verified home-HMO Patient and send a local OTP without exposing demographics. */
    async authenticate(input, privateContext = {}) {
        const id = this.flows.begin(input, privateContext);
        const flow = this.flows.browserFlow(id, input.browserBinding, 'authenticating');
        try {
            const source = resolveHmoSource(this.config, flow.homeHmoId, { store: this.store });
            const query = new URLSearchParams({ identifier: `${flow.identifier.system}|${flow.identifier.value}`, _elements: 'identifier,name,telecom,birthDate' });
            const bundle = await this.request(source, { scenario: 'patient-authentication', flowId: id, patients: [flow.identifier], method: 'GET', url: `${source.endpoint}/Patient?${query}`, headers: { Prefer: 'handling=strict' } });
            if (!this.flows.isCurrent(flow)) fail();
            const patient = authenticationPatient(bundle, flow.identifier, flow.birthDate);
            flow.contact = selectOtpContact(patient, this.config.systemAuthorization.otp, this.clock());
            flow.patient = structuredClone(patient);
            await this.sendOtp(flow);
            return { flowId: id, status: 'otp-required', transport: 'local-synthetic' };
        } catch (error) {
            this.flows.cancel(id);
            this.logger.info('Authentication source lookup failed', { type: 'SYSTEM_AUTHENTICATION', flowId: id, sourceId: flow.homeHmoId, state: 'failed', reason: error.message });
            fail();
        }
    }

    /** Exercise HTEST lookup/OTP only through an explicitly enrolled sandbox fixture. */
    async authenticateFixture(subject, browserBinding) {
        const member = this.config.systemAuthorization.memberships.find(value => value.sandboxFixture === true
            && normalizePatientIdentifier(value.identifier).synthetic && value.identifier.value === subject);
        if (!member) fail();
        return this.authenticate({ identifier: member.identifier, birthDate: member.fixtureBirthDate, browserBinding }, { syntheticFixture: true });
    }

    /** Accept provider-owned evidence without repeating OTP after validated local SSO. */
    acceptSso(result, browserBinding) {
        const evidence = this.identityProvider.consume(result, browserBinding, this.config.oauthClients.discoveryOrchestrator.clientId);
        const id = this.flows.begin({ ...evidence, browserBinding }, { enrolled: true });
        const flow = this.flows.browserFlow(id, browserBinding, 'authenticating');
        flow.phase = 'authenticated';
        flow.authenticationMethod = 'local-trusted-sso-simulation';
        flow.patient = { name: evidence.name };
        flow.expiresAt = Math.min(flow.expiresAt, evidence.expiresAt,
            this.clock() + this.config.systemAuthorization.authentication.authenticatedLifetimeSeconds);
        this.logger.info('Local trusted SSO simulation authenticated', { type: 'SYSTEM_AUTHENTICATION', flowId: id,
            state: 'authenticated', simulation: true, method: flow.authenticationMethod, identifier: flow.identifier });
        return { flowId: id, status: 'authenticated', transport: 'local-trusted-sso-simulation' };
    }

    /** UI choice selects a configured fabricated identity; no wire result establishes authority. */
    authenticateSso(subject, browserBinding) {
        return this.acceptSso(this.identityProvider.issue(subject, browserBinding,
            this.config.oauthClients.discoveryOrchestrator.clientId), browserBinding);
    }

    /** Replace an OTP atomically before delivery so concurrent resends cannot race. */
    async sendOtp(flow) {
        if (flow.sending || !this.flows.isCurrent(flow) || flow.phase !== 'authenticating') fail();
        flow.sending = true;
        this.transport.clear?.(flow.id);
        const code = this.codeGenerator();
        if (!/^\d{6}$/.test(code)) { flow.sending = false; this.flows.cancel(flow.id); fail(); }
        const salt = crypto.randomBytes(16).toString('hex');
        flow.otpHash = hash(`${salt}:${code}`);
        flow.otpSalt = salt;
        flow.otpExpiresAt = Math.min(flow.expiresAt, this.clock() + this.config.systemAuthorization.otp.expirySeconds);
        flow.lastSent = this.clock();
        const isCurrent = () => this.flows.isCurrent(flow) && flow.phase === 'authenticating'
            && flow.otpSalt === salt && flow.otpExpiresAt > this.clock();
        try {
            await this.transport.send({ flowId: flow.id, code, ...flow.contact, expiresAt: flow.otpExpiresAt, isCurrent });
            // An asynchronous transport may finish after cancellation or flow replacement.
            if (!isCurrent()) { this.transport.clear?.(flow.id); fail(); }
        }
        catch (error) { this.flows.cancel(flow.id); throw error; }
        finally { flow.sending = false; }
        this.logger.info('Synthetic OTP delivered', { type: 'SYSTEM_OTP', conformanceException: LOGGING_EXCEPTION, flowId: flow.id, sourceId: flow.homeHmoId, scenario: 'patient-authentication', transport: 'local-synthetic', state: 'sent', contact: flow.contact, code, expiresAt: flow.otpExpiresAt, resends: flow.resends });
    }

    /** Bound retries across all codes in a flow; resending never resets failed attempts. */
    async resend(id, browserBinding) {
        const flow = this.flows.browserFlow(id, browserBinding, 'authenticating');
        const policy = this.config.systemAuthorization.otp;
        if (!flow.contact || flow.attempts >= policy.maxAttempts || flow.resends >= policy.maxResends || this.clock() - flow.lastSent < policy.resendSeconds) fail();
        flow.resends++;
        await this.sendOtp(flow);
        return { flowId: id, status: 'otp-required', transport: 'local-synthetic' };
    }

    /** Verify once, binding success and its deadline to this browser's private flow. */
    verify(id, browserBinding, code) {
        const flow = this.flows.browserFlow(id, browserBinding, 'authenticating');
        const policy = this.config.systemAuthorization.otp;
        if (flow.sending || !flow.otpHash || flow.otpExpiresAt <= this.clock() || flow.attempts >= policy.maxAttempts) {
            if (flow.otpExpiresAt <= this.clock()) this.transport.clear?.(id);
            this.logger.info('OTP verification denied', { type: 'SYSTEM_OTP', conformanceException: LOGGING_EXCEPTION, flowId: id, sourceId: flow.homeHmoId, state: 'denied', reason: 'not-current', attempts: flow.attempts });
            fail();
        }
        flow.attempts++;
        if (typeof code !== 'string' || !/^\d{6}$/.test(code) || !crypto.timingSafeEqual(Buffer.from(flow.otpHash), Buffer.from(hash(`${flow.otpSalt}:${code}`)))) {
            this.logger.info('OTP verification denied', { type: 'SYSTEM_OTP', conformanceException: LOGGING_EXCEPTION, flowId: id, sourceId: flow.homeHmoId, state: 'denied', reason: 'code-mismatch', attempts: flow.attempts, submittedCode: code });
            if (flow.attempts >= policy.maxAttempts) this.flows.cancel(id);
            fail();
        }
        flow.phase = 'authenticated';
        flow.expiresAt = Math.min(flow.expiresAt, this.clock() + this.config.systemAuthorization.authentication.authenticatedLifetimeSeconds);
        delete flow.otpHash; delete flow.otpSalt; delete flow.contact;
        this.transport.clear?.(id);
        this.logger.info('Patient authenticated with local OTP', { type: 'SYSTEM_AUTHENTICATION', flowId: id, state: 'authenticated' });
        return { flowId: id, status: 'authenticated', identifier: structuredClone(flow.identifier), name: structuredClone(flow.patient.name || []), expiresAt: flow.expiresAt };
    }

    /** Maintain per-patient presence; failed entries retain their previously known value. */
    async presence(patients, previous = {}) {
        if (!Array.isArray(patients) || patients.length < 1 || patients.length > MAXIMA.maxPatients) fail();
        const keys = patients.map(patient => normalizePatientIdentifier(patient).key);
        if (new Set(keys).size !== keys.length) fail();
        const eligible = new Set(this.config.systemAuthorization.presenceEligiblePatients.map(patient => normalizePatientIdentifier(patient).key));
        const sources = require('./data-sources').getConfiguredDataSources(this.config).filter(source => source.enabled);
        const results = [];
        const correlationId = crypto.randomUUID();
        for (const source of sources) {
            const entries = new Array(patients.length);
            const limits = presenceLimits(this.config, { id: source.id });
            const deadlineMilliseconds = this.clockMilliseconds() + limits.timeoutMilliseconds;
            const query = patient => `Patient?${new URLSearchParams({ identifier: `${patient.system}|${patient.value}`, _summary: 'count', _count: '0' })}`;
            const candidates = patients.map((patient, index) => ({ patient, index })).filter(value => eligible.has(keys[value.index]));
            // Build source-specific batches without dropping patients or reclassifying failed entries as absence.
            for (let offset = 0; offset < candidates.length;) {
                let chunk = candidates.slice(offset, offset + limits.maxPatients);
                const body = values => ({ resourceType: 'Bundle', type: 'batch', entry: values.map(value => ({ request: { method: 'GET', url: query(value.patient) } })) });
                while (chunk.length > 1 && Buffer.byteLength(JSON.stringify(body(chunk))) > limits.maxPayloadBytes) chunk = chunk.slice(0, Math.ceil(chunk.length / 2));
                offset += chunk.length;
                try {
                    if (this.clockMilliseconds() >= deadlineMilliseconds) throw new Error('Presence source deadline exceeded');
                    if (Buffer.byteLength(JSON.stringify(body(chunk))) > limits.maxPayloadBytes) throw new Error('Presence entry exceeds source payload budget');
                    const common = { scenario: 'presence-check', correlationId, deadlineMilliseconds, patients: chunk.map(value => value.patient), headers: { Prefer: 'handling=strict' } };
                    const response = chunk.length === 1
                        ? await this.request(source, { ...common, method: 'GET', url: `${source.endpoint}/${query(chunk[0].patient)}` })
                        : await this.request(source, { ...common, method: 'POST', url: source.endpoint, body: body(chunk) });
                    if (this.clockMilliseconds() >= deadlineMilliseconds) throw new Error('Presence source deadline exceeded');
                    const returned = chunk.length === 1 ? [{ response: { status: '200' }, resource: response }]
                        : response?.resourceType === 'Bundle' && response.type === 'batch-response' && response.entry?.length === chunk.length ? response.entry : [];
                    chunk.forEach((value, index) => { entries[value.index] = returned[index]; });
                } catch (error) {
                    this.logger.info('Presence source request failed', { type: 'SYSTEM_PRESENCE', sourceId: source.id, state: 'unknown', reason: error.message });
                }
            }
            for (let index = 0; index < patients.length; index++) {
                const entry = entries?.[index];
                const bundle = entry?.resource;
                const complete = /^200(?: |$)/.test(entry?.response?.status || '') && bundle?.resourceType === 'Bundle' && bundle.type === 'searchset'
                    && [0, 1].includes(bundle.total) && !(bundle.entry || []).length && !(bundle.link || []).some(link => link.relation === 'next');
                const state = complete ? (bundle.total === 1 ? 'present' : 'absent') : 'unknown';
                let known = previous[`${source.id}|${keys[index]}`] ?? null;
                if (this.presenceStore) {
                    try {
                        known = this.presenceStore.get(patients[index], source.id);
                        if (complete) this.presenceStore.record(patients[index], source.id, state, this.clock());
                    } catch (error) {
                        this.logger.info('Presence persistence unavailable', { type: 'SYSTEM_PRESENCE', flowId: correlationId, sourceId: source.id, reason: error.message });
                    }
                }
                results.push({ sourceId: source.id, identifier: structuredClone(patients[index]), state, checkedAt: this.clock(),
                    ...(!eligible.has(keys[index]) ? { reason: 'patient-source-list-not-eligible' } : {}),
                    ...(complete ? {} : { previouslyKnown: known }) });
                this.logger.info('Presence entry evaluated', { type: 'SYSTEM_PRESENCE', conformanceException: LOGGING_EXCEPTION, flowId: correlationId, scenario: 'presence-check', entry: index, ...results.at(-1) });
            }
        }
        return { status: results.some(result => result.state === 'unknown') ? 'partial' : 'complete', results };
    }

    /** Follow two independent streams under the same current representative grant. */
    async discoverySource(flow, source, deadlineMilliseconds) {
        const policy = this.config.systemAuthorization.discovery;
        const current = () => {
            this.requireDiscoveryBudget(flow, deadlineMilliseconds);
            const active = resolveHmoSource(this.flows.config, source.id, { store: this.store });
            if (sourceFingerprint(active) !== sourceFingerprint(source)) fail();
        };
        current();
        const token = `${flow.identifier.system}|${flow.identifier.value}`;
        const queries = [new URLSearchParams({ '_has:RelatedPerson:patient:identifier': token, _elements: 'identifier,name' }),
            new URLSearchParams({ identifier: token, _elements: 'identifier,patient,active,relationship' })];
        const types = ['Patient', 'RelatedPerson'];
        const options = { scenario: 'dependent-discovery', flowId: flow.id, deadlineMilliseconds };
        const batch = await this.request(source, { ...options, method: 'POST', url: source.endpoint, headers: { Prefer: 'handling=strict' }, body: {
            resourceType: 'Bundle', type: 'batch', entry: types.map((type, i) => ({ request: { method: 'GET', url: `${type}?${queries[i]}` } }))
        } });
        current();
        if (batch?.resourceType !== 'Bundle' || batch.type !== 'batch-response' || batch.entry?.length !== 2) fail();
        const collected = [[], []];
        for (let stream = 0; stream < 2; stream++) {
            const entry = batch.entry[stream];
            if (!/^200(?: |$)/.test(entry.response?.status || '')) fail();
            let page = entry.resource;
            const visited = new Set();
            let expectedTotal;
            for (let pages = 1; ; pages++) {
                current();
                this.logger.info('Discovery page evaluated', { type: 'SYSTEM_DISCOVERY_PAGE', conformanceException: LOGGING_EXCEPTION, flowId: flow.id, sourceId: source.id, scenario: 'dependent-discovery', stream: types[stream], page: pages, body: page });
                if (page?.resourceType !== 'Bundle' || page.type !== 'searchset' || !Array.isArray(page.entry || [])) fail();
                if (page.total !== undefined) {
                    if (!Number.isSafeInteger(page.total) || page.total < 0 || (expectedTotal !== undefined && expectedTotal !== page.total)) fail();
                    expectedTotal = page.total;
                }
                for (const item of page.entry || []) {
                    if (item.resource?.resourceType !== types[stream] || item.search?.mode === 'include') fail();
                    collected[stream].push(item.resource);
                }
                const links = (page.link || []).filter(link => link.relation === 'next');
                if (!links.length) {
                    if (expectedTotal !== undefined && collected[stream].length !== expectedTotal) fail();
                    break;
                }
                if (links.length !== 1 || pages >= policy.maxPagesPerSource) fail();
                const next = continuationUrl(source.endpoint, links[0].url, types[stream]);
                if (visited.has(next)) fail();
                visited.add(next);
                current();
                page = await this.request(source, { ...options, method: 'GET', url: next, headers: { Prefer: 'handling=strict' } });
            }
        }
        current();
        return joinDependents(collected[0], collected[1], flow.identifier, policy.eligibleRelationships, source.endpoint, { syntheticFixture: flow.syntheticFixture === true });
    }

    /** Flow expiry is stored in seconds; discovery owns a private millisecond deadline. */
    requireDiscoveryBudget(flow, deadlineMilliseconds) {
        if (!this.flows.isCurrent(flow) || flow.phase !== 'authenticated'
            || this.clockMilliseconds() >= Math.min(deadlineMilliseconds, flow.expiresAt * 1000)) {
            throw Object.assign(new Error('Workflow deadline exceeded'), { code: 'ETIMEDOUT' });
        }
    }

    /** Preserve partial source outcomes; only verified strong identifiers deduplicate results. */
    async discover(id, browserBinding) {
        const flow = this.flows.browserFlow(id, browserBinding, 'authenticated');
        const sources = hmoSources(this.flows.config, this.store, { includeUnavailable: true });
        const outcomes = [];
        const dependents = new Map();
        for (const source of sources) {
            const deadlineMilliseconds = Math.min(this.clockMilliseconds() + this.config.systemAuthorization.discovery.timeoutMilliseconds, flow.expiresAt * 1000);
            try {
                let matches;
                try { matches = await this.discoverySource(flow, source, deadlineMilliseconds); }
                catch (error) {
                    if (error.code !== 'RACING_JOIN') throw error;
                    this.requireDiscoveryBudget(flow, deadlineMilliseconds);
                    matches = await this.discoverySource(flow, source, deadlineMilliseconds);
                }
                this.requireDiscoveryBudget(flow, deadlineMilliseconds);
                outcomes.push({ sourceId: source.id, state: 'complete', count: matches.length, checkedAt: new Date(this.clock() * 1000).toISOString() });
                this.logger.info('Dependent relationships evaluated', { type: 'SYSTEM_DISCOVERY', conformanceException: LOGGING_EXCEPTION, flowId: id, sourceId: source.id, scenario: 'dependent-discovery', state: 'complete', matches });
                for (const match of matches) {
                    const key = normalizePatientIdentifier(match.identifier).key;
                    if (!dependents.has(key)) dependents.set(key, { identifier: match.identifier, name: match.name, sources: [] });
                    dependents.get(key).sources.push({ sourceId: source.id, patientId: match.patientId, checkedAt: new Date(this.clock() * 1000).toISOString(), evidence: match.evidence });
                }
            } catch (error) {
                outcomes.push({ sourceId: source.id, state: 'unknown', checkedAt: new Date(this.clock() * 1000).toISOString(),
                    reason: 'This HMO could not complete its checks. Review source readiness, credentials, HTTPS trust and workflow policy, then retry.' });
                this.logger.info('Dependent discovery source failed', { type: 'SYSTEM_DISCOVERY', flowId: id, sourceId: source.id, state: 'unknown', reason: error.message });
            }
        }
        return { flowId: id, status: outcomes.every(source => source.state === 'complete') ? 'complete' : 'partial', sources: outcomes, dependents: [...dependents.values()] };
    }
}

module.exports = { CONTACT_EVIDENCE, LocalOtpTransport, OTP_PURPOSE, PURPOSE_SYSTEM, SystemWorkflows,
    authenticationPatient, continuationUrl, joinDependents, selectOtpContact };
