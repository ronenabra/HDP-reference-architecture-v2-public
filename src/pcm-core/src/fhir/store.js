/**
 * In-memory FHIR resource store with basic search and include support.
 */
const { GrantAuthorityState } = require('../grant-authority-state');
const { PrivateRecords, emptyState } = require('../private-records');
const { randomUUID: uuidv4 } = require('crypto');
const { executeSearch, matchesSearch, parseSearch } = require('./search');

const RESOURCE_TYPES = Object.freeze(['Organization', 'Endpoint', 'HealthcareService', 'Consent', 'Contract']);

/**
 * Return an independent JSON-compatible copy of a FHIR value.
 *
 * The sandbox deliberately stores only FHIR JSON. Cloning at every boundary
 * prevents request handlers and tests from mutating committed state by holding
 * a reference returned from the store.
 *
 * @param {any} value
 * @returns {any}
 */
const deepClone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** Stable persistence-layer error for a rejected atomic store operation. */
class FHIRStoreError extends Error {
    constructor(message, status = 409, code = 'conflict') {
        super(message);
        this.name = 'FHIRStoreError';
        this.status = status;
        this.code = code;
    }
}

/**
 * In-memory FHIR store for core PCM resources.
 */
class FHIRStore {
    /**
     * @param {{clock?: () => Date, idGenerator?: () => string, getConfigRevision?: () => any}} options
     */
    constructor({ clock = () => new Date(), idGenerator = uuidv4, getConfigRevision = () => require('../team-config').loadTeamConfig().runtime.revision } = {}) {
        this.clock = clock;
        this.idGenerator = idGenerator;
        this.getConfigRevision = getConfigRevision;
        this.reset();
        this.privateRecords = new PrivateRecords(this);
    }

    /** @returns {Record<string, Map<string, object>>} */
    emptyData() {
        return Object.fromEntries(RESOURCE_TYPES.map(type => [type, new Map()]));
    }

    /**
     * Assert a supported resource shape before persistence.
     * @param {object} resource
     * @returns {string}
     */
    assertSupported(resource) {
        require('../public-fhir').assertPublic(resource);
        const type = resource?.resourceType;
        if (!this.data[type]) throw new Error(`Unsupported resource type: ${type}`);
        return type;
    }

    /**
     * Add server-owned version metadata to a candidate.
     * @param {object} candidate
     * @param {number} version
     * @returns {object}
     */
    withServerMetadata(candidate, version) {
        const resource = deepClone(candidate);
        resource.meta = {
            ...(resource.meta || {}),
            versionId: String(version),
            lastUpdated: this.clock().toISOString()
        };
        return resource;
    }

    /**
     * Add a resource to the store, generating an id if missing.
     * @param {object} resource
     * @returns {object}
     */
    add(resource) {
        const candidate = deepClone(resource);
        const type = this.assertSupported(candidate);
        candidate.id = candidate.id || this.idGenerator();
        const current = this.data[type].get(candidate.id);
        const version = Number(current?.meta?.versionId || 0) + 1;
        const committed = this.withServerMetadata(candidate, version);
        this.authorityState.changed(current, committed);
        this.data[type].set(committed.id, committed);
        return deepClone(committed);
    }

    /**
     * Atomically create a public FHIR resource with an authoritative id.
     * Client-supplied ids and server metadata are ignored.
     * @param {object} resource
     * @param {(candidate: object) => void} [validate]
     * @param {{id?: string}} [options]
     * @returns {object}
     */
    create(resource, validate = () => {}, { id = this.idGenerator() } = {}) {
        const candidate = deepClone(resource);
        this.assertSupported(candidate);
        delete candidate.id;
        if (candidate.meta) {
            delete candidate.meta.versionId;
            delete candidate.meta.lastUpdated;
            if (Object.keys(candidate.meta).length === 0) delete candidate.meta;
        }
        candidate.id = id;
        if (this.data[candidate.resourceType].has(candidate.id)) {
            throw new FHIRStoreError(`Resource already exists: ${candidate.resourceType}/${candidate.id}`);
        }
        validate(deepClone(candidate));
        const committed = this.withServerMetadata(candidate, 1);
        this.authorityState.changed(null, committed);
        this.data[committed.resourceType].set(committed.id, committed);
        return deepClone(committed);
    }

    /**
     * Get a resource by type and id.
     * @param {string} type
     * @param {string} id
     * @returns {object|null}
     */
    get(type, id) {
        if (!this.data[type]) return null;
        const resource = this.data[type].get(id);
        return resource ? deepClone(resource) : null;
    }

    /**
     * Update an existing resource in the store.
     * @param {object} resource
     * @returns {object}
     */
    update(resource, validate = () => {}) {
        const candidate = deepClone(resource);
        const type = this.assertSupported(candidate);
        const current = this.data[type].get(candidate.id);
        if (!current) {
            throw new Error(`Resource not found: ${type}/${resource.id}`);
        }
        validate(deepClone(candidate), deepClone(current));
        const version = Number(current.meta?.versionId || 0) + 1;
        const committed = this.withServerMetadata(candidate, version);
        this.authorityState.changed(current, committed);
        this.data[type].set(committed.id, committed);
        return deepClone(committed);
    }

    /**
     * Execute synchronous coupled writes atomically. Any exception restores the
     * complete prior store state before it is rethrown.
     * @param {() => any} work Synchronous mutation command.
     * @param {object} [expectations] Expected private, public and configuration revisions.
     * @returns {any}
     */
    transaction(work, expectations) {
        if (work?.constructor?.name === 'AsyncFunction') throw new FHIRStoreError('Store transactions must be synchronous');
        if (expectations) this.privateRecords.check(expectations);
        const snapshot = Object.fromEntries(RESOURCE_TYPES.map(type => [type,
            new Map(Array.from(this.data[type].entries(), ([id, resource]) => [id, deepClone(resource)]))]));
        const privateState = deepClone(this.privateState), owner = this.authorityState;
        const authority = { epoch: owner.epoch, generations: new Map(owner.generations), configuration: new Map(owner.configuration) };
        const previousDirty = this._dirty, callbacks = this._diagnostics?.length || 0;
        this._transactionDepth = (this._transactionDepth || 0) + 1;
        try {
            const result = work();
            if (result && typeof result.then === 'function') throw new FHIRStoreError('Store transactions must not return asynchronous work');
            if (this._transactionDepth === 1 && this._dirty) this.privateState.revision++;
            return result;
        } catch (error) {
            this.data = snapshot; this.privateState = privateState; this.authorityState = owner;
            Object.assign(owner, authority); this._dirty = previousDirty;
            if (this._diagnostics) this._diagnostics.length = callbacks;
            throw error;
        } finally {
            this._transactionDepth--;
            if (!this._transactionDepth) {
                this._dirty = false;
                if (!this.migrationCheckpointAttached) this.flushDiagnostics();
            }
        }
    }

    /** Stage only diagnostic notification; the authoritative event is already in private lifecycle state. */
    afterCommit(notify) {
        if (!this._transactionDepth) throw new FHIRStoreError('Diagnostic notifications require a transaction');
        (this._diagnostics ||= []).push(notify);
    }

    /** Best-effort delivery after durable publication; failure cannot undo committed authority. */
    flushDiagnostics() {
        const pending = this._diagnostics || []; this._diagnostics = [];
        for (const notify of pending) {
            try { notify(); } catch (error) { this.lastDiagnosticError = error; }
        }
    }

    /**
     * Search resources by supported query parameters.
     * @param {string} type
     * @param {object} params
     * @param {(resource: object) => boolean} [authorize]
     * @returns {object[]}
     */
    search(type, params, authorize = () => true) {
        if (!this.data[type]) return [];
        const resources = Array.from(this.data[type].values(), deepClone);
        const model = parseSearch(type, params);
        return resources.filter(authorize).filter(resource => matchesSearch(resource, model));
    }

    /**
     * Search with _include and _include:iterate support.
     * @param {string} type
     * @param {object} params
     * @param {{authorize?: (resource: object) => boolean}} [options]
     * @returns {Array<{resource: object, search: {mode: string}}>}
     */
    searchExpanded(type, params, { authorize = () => true } = {}) {
        return executeSearch({
            store: this,
            type,
            raw: params,
            authorize,
            baseUrl: 'https://pcm.local/r4',
            callerKey: 'store-search-expanded',
            pageSize: Number.MAX_SAFE_INTEGER
        }).entry;
    }

    /**
     * Get all resources of a given type.
     * @param {string} type
     * @returns {object[]}
     */
    getAll(type) {
        if (!this.data[type]) return [];
        return Array.from(this.data[type].values(), deepClone);
    }

    /** Remove one dependency-checked private sandbox resource and invalidate its authority.
     * Public FHIR routes deliberately expose no DELETE interaction.
     * @param {string} type Resource type.
     * @param {string} id Exact logical id.
     * @returns {boolean} Whether the record existed.
     */
    remove(type, id) {
        if (!this.data[type]?.has(id)) return false;
        this.privateRecords.removing(type, id);
        this.authorityState.advance(`${type}/${id}`);
        return this.data[type].delete(id);
    }

    /**
     * Remove all in-memory resources while keeping supported resource maps.
     * @returns {void}
     */
    clear() {
        this.reset();
    }

    /**
     * Restore deterministic empty state without replacing the store instance.
     * @returns {void}
     */
    reset() {
        this.privateState = emptyState(this.privateState?.revision || 0);
        this.data = this.emptyData();
        this.authorityState = new GrantAuthorityState();
    }
}

// Every public mutation participates, including direct replacements and standalone deletion.
for (const method of ['add', 'create', 'update', 'remove', 'clear', 'reset']) {
    const original = FHIRStore.prototype[method];
    FHIRStore.prototype[method] = function (...args) {
        // Constructor initialization precedes private adapter creation.
        if (!this.privateRecords) return original.apply(this, args);
        return this.transaction(() => {
            if (['add', 'update'].includes(method) && args[0]?.id) {
                this.privateRecords.guard(args[0]);
                const previous = this.data[args[0].resourceType]?.get(args[0].id);
                if (this.privateState.approvals[`${args[0].resourceType}/${args[0].id}`] && previous?.meta?.versionId !== args[0].meta?.versionId) {
                    throw new FHIRStoreError('Consent changed; refresh the current version');
                }
            }
            const result = original.apply(this, args);
            if (['add', 'create', 'update'].includes(method)) {
                this.privateRecords.guard(result);
            }
            if (result !== false) this._dirty = true;
            return result;
        });
    };
}

const store = new FHIRStore();

module.exports = store;
module.exports.FHIRStore = FHIRStore;
module.exports.FHIRStoreError = FHIRStoreError;
module.exports.deepClone = deepClone;
module.exports.RESOURCE_TYPES = RESOURCE_TYPES;
