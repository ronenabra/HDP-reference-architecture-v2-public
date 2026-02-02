/**
 * In-memory FHIR resource store with basic search and include support.
 */
const { v4: uuidv4 } = require('uuid');

const EXT_PCM_SERVICE = 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-pcm-service';
const EXT_APPLICABLE_CERTS = 'http://pcm.fhir.health.gov.il/StructureDefinition/ext-applicable-certificates';

/**
 * In-memory FHIR store for core PCM resources.
 */
class FHIRStore {
    constructor() {
        this.data = {
            Organization: new Map(),
            Endpoint: new Map(),
            HealthcareService: new Map(),
            VerificationResult: new Map(),
            Consent: new Map()
        };
    }

    /**
     * Add a resource to the store, generating an id if missing.
     * @param {object} resource
     * @returns {object}
     */
    add(resource) {
        if (!resource.id) {
            resource.id = uuidv4();
        }
        const type = resource.resourceType;
        if (!this.data[type]) {
            throw new Error(`Unsupported resource type: ${type}`);
        }
        this.data[type].set(resource.id, resource);
        return resource;
    }

    /**
     * Get a resource by type and id.
     * @param {string} type
     * @param {string} id
     * @returns {object|null}
     */
    get(type, id) {
        if (!this.data[type]) return null;
        return this.data[type].get(id);
    }

    /**
     * Update an existing resource in the store.
     * @param {object} resource
     * @returns {object}
     */
    update(resource) {
        const type = resource.resourceType;
        if (!this.data[type] || !this.data[type].has(resource.id)) {
            throw new Error(`Resource not found: ${type}/${resource.id}`);
        }
        this.data[type].set(resource.id, resource);
        return resource;
    }

    /**
     * Search resources by supported query parameters.
     * @param {string} type
     * @param {object} params
     * @returns {object[]}
     */
    search(type, params) {
        if (!this.data[type]) return [];
        const resources = Array.from(this.data[type].values());

        return resources.filter(res => {
            // Simplified search logic
            for (const [key, value] of Object.entries(params)) {
                if (key.startsWith('_') && key !== '_id') continue; // Skip control params except _id

                if (key === '_id') {
                    if (res.id !== value) return false;
                } else if (key === 'active') { // boolean string handling
                    const boolVal = value === 'true';
                    if (res.active !== boolVal) return false;
                } else if (key === 'status') {
                    if (res.status !== value) return false;
                } else if (key === 'identifier') {
                    // Check identifier system|value or just value
                    const parts = value.split('|');
                    const system = parts.length > 1 ? parts[0] : null;
                    const val = parts.length > 1 ? parts[1] : parts[0];

                    const identifiers = Array.isArray(res.identifier) ? res.identifier : (res.identifier ? [res.identifier] : []);
                    const found = identifiers.some(id =>
                        (!system || id.system === system) && id.value === val
                    );
                    if (!found) return false;
                } else if (key === 'name') {
                    if (!res.name || !res.name.toLowerCase().includes(value.toLowerCase())) return false;
                } else if (key === 'type') {
                    const codings = (res.type || []).flatMap(t => t.coding || []);
                    const found = codings.some(c => c.code === value || c.system === value);
                    if (!found) return false;
                } else if (key === 'category') {
                    const codings = (res.category || []).flatMap(t => t.coding || []);
                    const found = codings.some(c => c.code === value || c.system === value);
                    if (!found) return false;
                } else if (key === 'providedBy') {
                    const ref = res.providedBy?.reference || '';
                    if (!ref.endsWith(value) && ref !== value) return false;
                } else if (key === 'partof') {
                    const ref = res.partOf?.reference || '';
                    if (!ref.endsWith(value) && ref !== value) return false;
                } else if ((key === 'patient.identifier' || key === 'patient') && type === 'Consent') {
                    // Support chained patient search and direct patient parameter.
                    const parts = value.split('|');
                    const system = parts.length > 1 ? parts[0] : null;
                    const val = parts.length > 1 ? parts[1] : parts[0];
                    const pid = res.patient?.identifier;
                    if (!pid || pid.value !== val || (system && pid.system !== system)) return false;
                } else if (key === 'pcm-service' && type === 'Consent') {
                    const ext = (res.extension || []).find(e => e.url === EXT_PCM_SERVICE);
                    const ref = ext?.valueReference?.reference || '';
                    if (!ref.endsWith(value) && ref !== value) return false;
                } else if (key === 'thumbprint' && type === 'Endpoint') {
                    const ext = (res.extension || []).find(e => e.url === EXT_APPLICABLE_CERTS);
                    const thumbprints = (ext?.extension || []).map(e => e.valueString);
                    if (!thumbprints.includes(value)) return false;
                }
                // Add more specific param handling as needed
            }
            return true;
        });
    }

    /**
     * Search with _include and _include:iterate support.
     * @param {string} type
     * @param {object} params
     * @returns {Array<{resource: object, search: {mode: string}}>}
     */
    searchExpanded(type, params) {
        const matches = this.search(type, params);
        const entries = matches.map(r => ({ resource: r, search: { mode: 'match' } }));
        const includedIds = new Set(matches.map(r => r.resourceType + '/' + r.id));

        // Helper to resolve reference
        const resolve = (refString) => {
            if (!refString) return null;
            const [refType, refId] = refString.split('/');
            return this.get(refType, refId);
        };

        const addInclude = (resource) => {
            const key = resource.resourceType + '/' + resource.id;
            if (!includedIds.has(key)) {
                includedIds.add(key);
                entries.push({ resource, search: { mode: 'include' } });
                return true; // Added new
            }
            return false; // Already present
        };

        // Process Includes
        let pool = [...matches];
        let newItems = [];

        // 1. Direct Includes
        const includes = params._include ? (Array.isArray(params._include) ? params._include : [params._include]) : [];

        if (includes.includes('Consent:actor')) {
            pool.forEach(res => {
                if (res.resourceType === 'Consent' && res.provision?.actor) {
                    res.provision.actor.forEach(actor => {
                        if (actor.reference?.reference) {
                            const target = resolve(actor.reference.reference);
                            if (target && addInclude(target)) newItems.push(target);
                        }
                    });
                }
            });
        }

        if (includes.includes('Organization:endpoint')) {
            pool.forEach(res => {
                if (res.resourceType === 'Organization' && res.endpoint) {
                    res.endpoint.forEach(ep => {
                        if (ep.reference) {
                            const target = resolve(ep.reference);
                            if (target && addInclude(target)) newItems.push(target);
                        }
                    });
                }
            });
        }

        if (includes.includes('Organization:partof')) {
            pool.forEach(res => {
                if (res.resourceType === 'Organization' && res.partOf && res.partOf.reference) {
                    const target = resolve(res.partOf.reference);
                    if (target && addInclude(target)) newItems.push(target);
                }
            });
        }

        pool = [...pool, ...newItems];
        newItems = [];

        // 2. Iterative Includes
        // Express might use key '_include:iterate' string literal
        const iterateKey = Object.keys(params).find(k => k === '_include:iterate');
        const iterateIncludes = iterateKey ? (Array.isArray(params[iterateKey]) ? params[iterateKey] : [params[iterateKey]]) : [];

        pool.forEach(res => {
            if (res.resourceType === 'Organization') {
                if (iterateIncludes.includes('Organization:endpoint') && res.endpoint) {
                    res.endpoint.forEach(ep => {
                        if (ep.reference) {
                            const target = resolve(ep.reference);
                            if (target && addInclude(target)) newItems.push(target);
                        }
                    });
                }
                if (iterateIncludes.includes('Organization:partof') && res.partOf && res.partOf.reference) {
                    const target = resolve(res.partOf.reference);
                    if (target && addInclude(target)) newItems.push(target);
                }
            }
        });

        return entries;
    }

    /**
     * Get all resources of a given type.
     * @param {string} type
     * @returns {object[]}
     */
    getAll(type) {
        if (!this.data[type]) return [];
        return Array.from(this.data[type].values());
    }
}

module.exports = new FHIRStore();
