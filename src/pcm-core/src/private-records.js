'use strict';

/** Versioned owner-private records inside FHIRStore, never a public FHIR projection. */
const { EXTENSIONS, SANDBOX_EXTENSIONS } = require('../../shared/pcm-contract');
const approval = require('../../shared/consent-scope-snapshot');
const serviceGrant = require('../../shared/service-grant');
const clone = value => value === undefined ? undefined : structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SCHEMA = 'pcm-private-state/1';
const TABLES = ['services', 'approvals', 'lifecycle', 'provisioning'];

/** A closed internal failure; callers map this to their existing public error contract. */
class PrivateRecordError extends Error {
    constructor(message, code = 'conflict') { super(message); this.name = 'PrivateRecordError'; this.code = code; this.status = 409; }
}
const fail = (message, code) => { throw new PrivateRecordError(message, code); };
/** Exact FHIR logical keys; reject prototype names and ambiguous paths. */
function key(type, id) {
    if (!['Organization', 'Endpoint', 'HealthcareService', 'Consent', 'Contract'].includes(type) || !/^[A-Za-z0-9.-]{1,64}$/.test(id || '')) fail('Exact resource identity required', 'invalid');
    return `${type}/${id}`;
}
/** Permission-bearing public facts, deliberately excluding mutable CST membership/status. */
function publicBinding(resource) {
    return clone({ identifier: resource.identifier, patient: resource.patient, dateTime: resource.dateTime,
        category: resource.category, scope: resource.scope, service: (resource.extension || []).filter(item => item.url === EXTENSIONS.pcmService),
        period: resource.provision?.period, type: resource.provision?.type, purpose: resource.provision?.purpose,
        actors: (resource.provision?.actor || []).filter(item => !item.role?.coding?.some(code => code.code === 'CST')) });
}
/** Validate a detached snapshot through the existing lossless parser, without a live compiler. */
function validateSnapshot(resource, snapshot) {
    const candidate = clone(resource);
    candidate.extension = (candidate.extension || []).filter(item => ![approval.URL, SANDBOX_EXTENSIONS.approvedTokenScope, SANDBOX_EXTENSIONS.approvedTokenScopeOrigin].includes(item.url));
    candidate.extension.push({ url: approval.URL, valueString: JSON.stringify(snapshot) },
        { url: SANDBOX_EXTENSIONS.approvedTokenScope, valueString: snapshot?.scope },
        { url: SANDBOX_EXTENSIONS.approvedTokenScopeOrigin, valueString: `${snapshot?.origin}: ${snapshot?.choice}` });
    approval.readApprovalSnapshot(candidate);
    if (snapshot.service.grant !== null) serviceGrant.readServiceGrant({ extension: [{ url: serviceGrant.URL, valueString: JSON.stringify(snapshot.service.grant) }] });
}
/** Empty logical tables; authority remains the single existing GrantAuthorityState owner. */
function emptyState(revision = 0) { return { schema: SCHEMA, revision, services: {}, approvals: {}, lifecycle: {}, provisioning: {} }; }

/** Retain closed legacy option payloads losslessly, rejecting conflicting option identities. */
function validateOptions(options) {
    if (!Array.isArray(options)) fail('Definition options must be an array', 'invalid');
    const ids = new Set();
    for (const option of options) {
        const children = option?.extension;
        if (option?.url !== 'urn:pcm:sandbox:approval-scope-option' || !Array.isArray(children)
            || children.map(item => item.url).sort().join('|') !== 'id|label|origin|scope'
            || children.some(item => Object.keys(item).sort().join('|') !== 'url|valueString' || typeof item.valueString !== 'string')) fail('Invalid private approval option', 'invalid');
        const id = children.find(item => item.url === 'id').valueString;
        if (!id || ids.has(id)) fail('Duplicate private approval option identity', 'invalid');
        ids.add(id);
        approval.approvalDiagnostics(children.find(item => item.url === 'scope').valueString);
    }
}

/** Reserved enrollment preferences are private bookkeeping, never service or grant authority. */
function validateProviderDefaults(value) {
    if (!value || value.schema !== 'pcm-provider-service-defaults/1' || Object.keys(value).sort().join('|') !== 'schema|services' || !value.services || typeof value.services !== 'object' || Array.isArray(value.services)) fail('Invalid provider service defaults', 'invalid');
    for (const [id, preference] of Object.entries(value.services)) {
        key('HealthcareService', id);
        if (!preference || Object.keys(preference).sort().join('|') !== 'initialized|override' || typeof preference.initialized !== 'boolean' || !['none', 'paused', 'disconnected'].includes(preference.override) || !preference.initialized && preference.override !== 'none') fail('Invalid provider service override', 'invalid');
    }
    return clone(value);
}

/** Small typed adapters. All writes join the containing store's synchronous transaction. */
class PrivateRecords {
    constructor(store) {
        this.store = store;
        this.services = { getDefinition: id => this.getDefinition(id), createDefinition: command => this.createDefinition(command),
            getProviderDefaults: id => {
                const value = this.provisioning.get('Organization', id)?.serviceDefaults;
                return value ? validateProviderDefaults(value) : { schema: 'pcm-provider-service-defaults/1', services: {} };
            } };
        this.approvals = { getDecision: id => this.getDecision(id), createDecision: command => this.createDecision(command) };
        this.lifecycle = { getState: (type, id) => clone(this.state.lifecycle[key(type, id)]?.state || null),
            getEvents: (type, id) => clone(this.state.lifecycle[key(type, id)]?.events || []),
            command: command => this.lifecycleCommand(command) };
        this.provisioning = { get: (type, id) => clone(this.state.provisioning[key(type, id)] || null),
            put: command => this.putProvisioning(command) };
    }
    get state() { return this.store.privateState; }
    /** Root/config/resource revisions are checked inside the mutation, never just in a preview. */
    check({ expectedRevision, expectedVersions = {}, expectedConfigRevision } = {}) {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.state.revision) fail('Private revision changed; refresh the command');
        if (expectedConfigRevision !== undefined && this.store.getConfigRevision() !== expectedConfigRevision) fail('Configuration revision changed; refresh the command');
        for (const [identity, version] of Object.entries(expectedVersions)) {
            const [type, id] = identity.split('/'); key(type, id);
            if (typeof version !== 'string' || this.store.get(type, id)?.meta?.versionId !== version) fail(`Resource version changed: ${identity}`);
        }
    }
    /** Resolve a live registration to its frozen canonical version without reading a presentation copy. */
    getDefinition(id) {
        const service = this.store.get('HealthcareService', id);
        if (!service) return { status: 'missing' };
        const basedOn = service.extension?.find(item => item.url === EXTENSIONS.basedOnCanonicalHealthcareService)?.valueReference?.reference;
        const identity = basedOn || key('HealthcareService', id), record = this.state.services[identity];
        if (!record) return { status: 'missing' };
        const value = record.versions?.[record.currentVersion];
        if (!value || !this.store.get('HealthcareService', identity.split('/')[1])) return { status: 'invalid' };
        try { serviceGrant.readServiceGrant({ extension: [{ url: serviceGrant.URL, valueString: JSON.stringify(value.grant) }] }); }
        catch (_) { return { status: 'invalid' }; }
        return { status: 'ok', ...clone(value) };
    }
    /** Append an immutable definition version; permission changes cannot overwrite history. */
    createDefinition(command) {
        return this.store.transaction(() => {
            this.check(command);
            const { serviceId, grant, options = [], confidentialityPolicy = null, includeMasterData = false } = command;
            const identity = key('HealthcareService', serviceId), resource = this.store.get('HealthcareService', serviceId);
            if (!resource || command.expectedVersions?.[identity] !== resource.meta.versionId) fail('Current definition version required');
            if (resource.extension?.some(item => item.url === EXTENSIONS.basedOnCanonicalHealthcareService)) fail('Definitions belong to canonical services');
            serviceGrant.readServiceGrant({ extension: [{ url: serviceGrant.URL, valueString: JSON.stringify(grant) }] });
            if (confidentialityPolicy !== null) require('../../shared/service-confidentiality-policy').validatePolicy(confidentialityPolicy);
            validateOptions(options);
            if (typeof includeMasterData !== 'boolean') fail('Invalid definition policy', 'invalid');
            const version = resource.meta.versionId, previous = this.state.services[identity];
            if (previous?.versions[version]) fail('Definition version already exists');
            const value = clone({ recordRevision: this.state.revision + 1, definitionId: serviceId, definitionVersion: version, grant, options, confidentialityPolicy, includeMasterData });
            this.state.services[identity] = { currentVersion: version, versions: { ...previous?.versions, [version]: value } };
            this.store.authorityState.advance(identity); this.store._dirty = true;
            return clone(value);
        });
    }
    /** Return explicit missing/invalid/unusable state; never infer an approval from public text. */
    getDecision(id) {
        const identity = key('Consent', id), value = this.state.approvals[identity], resource = this.store.get('Consent', id);
        if (!value) return { status: 'missing' };
        try {
            if (!resource || !same(value.publicBinding, publicBinding(resource))) return { status: 'invalid' };
            validateSnapshot(resource, value.snapshot);
            const frozen = this.state.services[key('HealthcareService', value.snapshot.service.definitionId)]?.versions?.[value.snapshot.service.definitionVersion];
            if (value.snapshot.service.grant !== null && (!frozen || !same(frozen.grant, value.snapshot.service.grant))) return { status: 'invalid' };
            return { status: value.snapshot.usable ? 'ok' : 'invalid', ...clone(value) };
        } catch (_) { return { status: 'invalid' }; }
    }
    /** Freeze one exact decision after the public approval write in the same transaction. */
    createDecision(command) {
        return this.store.transaction(() => {
            this.check(command);
            const { consentId, snapshot } = command, identity = key('Consent', consentId), resource = this.store.get('Consent', consentId);
            if (!resource || resource.status !== 'active' || command.expectedVersions?.[identity] !== resource.meta.versionId) fail('Current active Consent version required');
            if (this.state.approvals[identity]) fail('Consent already has an immutable decision');
            validateSnapshot(resource, snapshot);
            for (const [id, version] of [[snapshot.service.id, snapshot.service.version], [snapshot.service.definitionId, snapshot.service.definitionVersion]]) {
                const currentVersion = this.store.get('HealthcareService', id)?.meta?.versionId;
                if (!currentVersion || command.expectedVersions?.[key('HealthcareService', id)] !== currentVersion
                    || (id === snapshot.service.id && currentVersion !== version)) fail('Service review changed');
            }
            const definition = this.state.services[key('HealthcareService', snapshot.service.definitionId)]?.versions?.[snapshot.service.definitionVersion];
            if (!definition || !same(definition.grant, snapshot.service.grant)) fail('Missing/inconsistent private definition authority', 'invalid');
            const value = clone({ decisionVersion: '1', publicVersionAtDecision: resource.meta.versionId, publicBinding: publicBinding(resource), snapshot });
            this.state.approvals[identity] = value;
            const sources = (resource.provision?.actor || []).filter(item => item.role?.coding?.some(code => code.code === 'CST')).map(item => item.reference?.reference).filter(Boolean);
            this.append('Consent', consentId, { kind: 'approval', at: snapshot.approvedAt, sources },
                { exactSourceMembership: sources.length === 0, sources });
            this.store.authorityState.advance(identity); this.store._dirty = true;
            return clone(value);
        });
    }
    /** Enforce private decision immutability on every public replacement path. */
    guard(resource) {
        const identity = key(resource.resourceType, resource.id);
        if (resource.resourceType === 'Organization' && resource.active && this.state.lifecycle[identity]?.state?.sourceRegistrationRemoved) fail('Removed source registration cannot be revived; create a new identity');
        if (this.state.lifecycle[identity]?.state?.deleted && (this.state.approvals[identity] || this.state.services[identity])) fail('Deleted private authority cannot be revived; create a new resource identity');
        const value = this.state.approvals[identity];
        if (value && !same(value.publicBinding, publicBinding(resource))) fail('Approved public binding is read-only');
        const current = resource.resourceType === 'Consent' && this.store.get('Consent', resource.id);
        if (current) {
            if (current.meta?.versionId !== resource.meta?.versionId) fail('Consent changed; refresh the current version');
            // A missing private decision denies authorization, and must not make
            // an already decided public identity/period editable again.
            if (!['proposed', 'draft'].includes(current.status) && !same(publicBinding(current), publicBinding(resource))) fail('Approved public binding is read-only');
        }
        if (value) {
            validateSnapshot(resource, value.snapshot);
        }
    }
    /** Append one authoritative event and flags in the same boundary as the public write. */
    append(type, id, event, flags = {}) {
        const identity = key(type, id), previous = this.state.lifecycle[identity] || { state: {}, events: [] };
        const eventId = `${this.state.revision + 1}:${Object.values(this.state.lifecycle).reduce((sum, item) => sum + item.events.length, 0) + 1}`;
        const value = clone({ ...event, eventId, revision: this.state.revision + 1 });
        this.state.lifecycle[identity] = { state: { ...previous.state, ...clone(flags) }, events: [...previous.events, value] };
        this.store._dirty = true;
        return clone(value);
    }
    /** Version-bound lifecycle command. A no-op must be detected by the owning producer. */
    lifecycleCommand(command) {
        return this.store.transaction(() => {
            this.check(command);
            const { type, id, resource, event, state = {} } = command;
            if (!event || !command.expectedVersions?.[key(type, id)] || resource?.resourceType !== type || resource.id !== id) fail('Version-bound lifecycle command required', 'invalid');
            const committed = this.store.update(resource);
            const saved = this.append(type, id, event, state);
            // Public semantic changes and exact source removals already advance their
            // original dependency keys in FHIRStore; source additions must not revoke
            // unrelated retained source grants. Private audit itself grants no authority.
            return { resource: committed, eventId: saved.eventId };
        });
    }
    /** Provisioning remains private bookkeeping and cannot create clinical authority. */
    putProvisioning(command) {
        return this.store.transaction(() => {
            this.check(command);
            const { type, id, value } = command, identity = key(type, id);
            if (!this.store.get(type, id) || !command.expectedVersions?.[identity] || !value || typeof value !== 'object' || Array.isArray(value)) fail('Version-bound provisioning record required', 'invalid');
            if (value.serviceDefaults !== undefined) {
                if (type !== 'Organization') fail('Provider defaults belong to an Organization', 'invalid');
                validateProviderDefaults(value.serviceDefaults);
            }
            this.state.provisioning[identity] = clone(value); this.store._dirty = true;
            return clone(value);
        });
    }
    /** Reject referenced deletion; retain frozen decisions/definitions and irreversible audit tombstones. */
    removing(type, id) {
        const identity = key(type, id);
        if (Object.values(this.state.approvals).some(value => type === 'HealthcareService' && [value.snapshot.service.id, value.snapshot.service.definitionId].includes(id))) fail('Service is referenced by a frozen approval');
        if (type === 'HealthcareService' && this.state.services[identity] && this.store.getAll(type).some(value => value.id !== id && value.extension?.some(item => item.valueReference?.reference === identity))) fail('Service is referenced by a registration');
        this.append(type, id, { kind: 'deleted', at: this.store.clock().toISOString() }, { deleted: true });
    }
}

/** Serialize the one authority owner, including epoch and irreversible tombstones. */
function exportState(store) {
    return { ...clone(store.privateState), authority: { epoch: store.authorityState.epoch,
        generations: Object.fromEntries(store.authorityState.generations), configuration: Object.fromEntries(store.authorityState.configuration) } };
}
/** Validate the entire candidate against public facts before hydrating any live store. */
function validateState(state, resources) {
    if (state?.schema !== SCHEMA) fail('Unsupported private state version', 'unsupported-version');
    if (Object.keys(state).sort().join('|') !== ['schema', 'revision', ...TABLES, 'authority'].sort().join('|') || !Number.isSafeInteger(state.revision) || state.revision < 0) fail('Invalid private envelope', 'invalid');
    for (const table of TABLES) if (!state[table] || typeof state[table] !== 'object' || Array.isArray(state[table])) fail(`Invalid private table ${table}`, 'invalid');
    const authority = state.authority;
    if (!authority || typeof authority.epoch !== 'string' || !authority.epoch || !authority.generations || !authority.configuration || Array.isArray(authority.generations) || Array.isArray(authority.configuration)
        || Object.values(authority.generations).some(value => !Number.isSafeInteger(value) || value < 0)) fail('Invalid private authority', 'invalid');
    const lookup = identity => { const [type, id] = identity.split('/'); if (key(type, id) !== identity) fail('Invalid record key', 'invalid'); return resources[type]?.find(value => value.id === id); };
    for (const [identity, record] of Object.entries(state.services)) {
        lookup(identity);
        if (!identity.startsWith('HealthcareService/') || Object.keys(record || {}).sort().join('|') !== 'currentVersion|versions' || !record?.versions?.[record.currentVersion]) fail('Invalid private definition', 'invalid');
        for (const [version, value] of Object.entries(record.versions)) {
            if (Object.keys(value || {}).sort().join('|') !== 'confidentialityPolicy|definitionId|definitionVersion|grant|includeMasterData|options|recordRevision' || !/^[1-9][0-9]*$/.test(version) || value.recordRevision < 1 || value.definitionId !== identity.split('/')[1] || value.definitionVersion !== version || !Number.isSafeInteger(value.recordRevision) || value.recordRevision > state.revision) fail('Invalid definition version', 'invalid');
            serviceGrant.readServiceGrant({ extension: [{ url: serviceGrant.URL, valueString: JSON.stringify(value.grant) }] });
            validateOptions(value.options);
            if (typeof value.includeMasterData !== 'boolean') fail('Invalid definition policy', 'invalid');
            if (value.confidentialityPolicy !== null) require('../../shared/service-confidentiality-policy').validatePolicy(value.confidentialityPolicy);
        }
    }
    for (const [identity, value] of Object.entries(state.approvals)) {
        const resource = lookup(identity), tombstone = state.lifecycle[identity]?.state?.deleted;
        if (Object.keys(value || {}).sort().join('|') !== 'decisionVersion|publicBinding|publicVersionAtDecision|snapshot' || !identity.startsWith('Consent/') || value.decisionVersion !== '1' || !/^[1-9][0-9]*$/.test(value.publicVersionAtDecision || '')) fail('Invalid private approval', 'invalid');
        if (!resource && tombstone) {
            const binding = value.publicBinding;
            validateSnapshot({ ...binding, extension: binding.service,
                provision: { period: binding.period, type: binding.type, purpose: binding.purpose, actor: binding.actors } }, value.snapshot);
        } else if (!resource || !same(value.publicBinding, publicBinding(resource))) fail(`Inconsistent approval ${identity}; restore matching public/private checkpoint`, 'invalid');
        if (resource) validateSnapshot(resource, value.snapshot);
        const legacy = resource && approval.readApprovalSnapshot(resource);
        if (legacy && !same(legacy, value.snapshot)) fail('Legacy/private approval disagreement', 'invalid');
        const frozen = state.services[key('HealthcareService', value.snapshot.service.definitionId)]?.versions?.[value.snapshot.service.definitionVersion];
        if (value.snapshot.service.grant !== null && (!frozen || !same(frozen.grant, value.snapshot.service.grant))) fail('Missing/inconsistent frozen definition', 'invalid');
    }
    const ids = new Set();
    for (const [identity, value] of Object.entries(state.lifecycle)) {
        lookup(identity);
        if (!value?.state || !Array.isArray(value.events)) fail('Invalid lifecycle state', 'invalid');
        for (const event of value.events) {
            if (typeof event.eventId !== 'string' || ids.has(event.eventId) || !Number.isSafeInteger(event.revision) || event.revision > state.revision) fail('Invalid/duplicate lifecycle event', 'invalid');
            ids.add(event.eventId);
        }
    }
    for (const [identity, value] of Object.entries(state.provisioning)) {
        lookup(identity);
        if (value.serviceDefaults !== undefined) {
            if (!identity.startsWith('Organization/')) fail('Provider defaults belong to an Organization', 'invalid');
            validateProviderDefaults(value.serviceDefaults);
        }
    }
    return clone(state);
}
/** Refuse rollback of any later decision, generation, tombstone or authoritative event. */
function assertRestrictionsPreserved(store, candidate) {
    const before = exportState(store), after = exportState(candidate);
    if (before.revision > after.revision || (Object.keys(before.authority.generations).length && before.authority.epoch !== after.authority.epoch)) throw new PrivateRecordError('Unsafe restore: authority lineage/revision differs; preserve current checkpoint');
    for (const [key, generation] of Object.entries(before.authority.generations)) {
        if ((after.authority.generations[key] || 0) < generation) throw new PrivateRecordError(`Unsafe restore: later revocation at ${key}; preserve current checkpoint`);
    }
    for (const [identity, value] of Object.entries(before.provisioning)) {
        for (const [catalogId, preference] of Object.entries(value.serviceDefaults?.services || {})) {
            if (preference.initialized && !same(after.provisioning[identity]?.serviceDefaults?.services?.[catalogId], preference)) {
                throw new PrivateRecordError(`Unsafe restore: later provider choice ${identity}/${catalogId}`);
            }
        }
    }
    for (const [key, value] of Object.entries(before.approvals)) if (JSON.stringify(after.approvals[key]) !== JSON.stringify(value)) throw new PrivateRecordError(`Unsafe restore: immutable decision ${key}`);
    for (const [key, value] of Object.entries(before.lifecycle)) {
        if (value.events.some(event => !after.lifecycle[key]?.events.some(saved => JSON.stringify(saved) === JSON.stringify(event)))) throw new PrivateRecordError(`Unsafe restore: later lifecycle history ${key}`);
    }
}
module.exports = { assertRestrictionsPreserved, SCHEMA, TABLES, PrivateRecords, PrivateRecordError, emptyState, exportState, validateState, publicBinding, validateSnapshot, validateOptions, key };
