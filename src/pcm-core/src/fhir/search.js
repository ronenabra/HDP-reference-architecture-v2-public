/**
 * Typed FHIR search grammar, authorization-first execution, includes, and
 * authorization-bound opaque paging for the PCM management facade.
 */
const crypto = require('crypto');
const { EXTENSIONS } = require('../../../shared/pcm-contract');

const CONTROL_PARAMETERS = new Set(['_include', '_include:iterate', '_page']);
const INCLUDE_ALLOWLIST = Object.freeze({
    Contract: Object.freeze({ direct: new Set(), iterate: new Set() }),
    Organization: Object.freeze({
        direct: new Set(['Organization:endpoint', 'Organization:partof']),
        iterate: new Set(['Organization:endpoint', 'Organization:partof'])
    }),
    Endpoint: Object.freeze({ direct: new Set(), iterate: new Set() }),
    HealthcareService: Object.freeze({ direct: new Set(), iterate: new Set() }),
    Consent: Object.freeze({
        direct: new Set(['Consent:actor']),
        iterate: new Set(['Organization:endpoint', 'Organization:partof'])
    })
});

const SEARCH_PARAMETERS = Object.freeze({
    Contract: Object.freeze({
        _id: { type: 'code', values: resource => [resource.id] },
        identifier: { type: 'token', values: resource => resource.identifier || [] },
        status: { type: 'contract-status', values: resource => [resource.status] },
        issued: { type: 'date', values: resource => [resource.issued] },
        _lastUpdated: { type: 'date', values: resource => [resource.meta?.lastUpdated] }
    }),
    Organization: Object.freeze({
        _id: { type: 'code', values: resource => [resource.id] },
        identifier: { type: 'token', values: resource => resource.identifier || [] },
        active: { type: 'boolean', values: resource => [resource.active] },
        type: { type: 'token', values: resource => (resource.type || []).flatMap(value => value.coding || []) },
        partof: { type: 'reference', values: resource => [resource.partOf?.reference] },
        _lastUpdated: { type: 'date', values: resource => [resource.meta?.lastUpdated] }
    }),
    Endpoint: Object.freeze({
        _id: { type: 'code', values: resource => [resource.id] },
        _lastUpdated: { type: 'date', values: resource => [resource.meta?.lastUpdated] },
        thumbprint: {
            type: 'thumbprint',
            values: resource => (resource.extension || [])
                .filter(extension => extension.url === EXTENSIONS.applicableCertificates)
                .flatMap(extension => extension.extension || [])
                .filter(extension => extension.url === 'thumbprint')
                .map(extension => extension.valueString)
        }
    }),
    HealthcareService: Object.freeze({
        _id: { type: 'code', values: resource => [resource.id] },
        active: { type: 'boolean', values: resource => [resource.active] },
        identifier: { type: 'token', values: resource => resource.identifier || [] },
        'service-category': { type: 'token', values: resource => (resource.category || []).flatMap(value => value.coding || []) },
        'service-type': { type: 'token', values: resource => (resource.type || []).flatMap(value => value.coding || []) },
        name: { type: 'string', values: resource => [resource.name] },
        organization: { type: 'reference', values: resource => [resource.providedBy?.reference] },
        _tag: { type: 'token', values: resource => resource.meta?.tag || [] },
        'based-on': {
            type: 'reference',
            values: resource => (resource.extension || [])
                .filter(extension => extension.url === EXTENSIONS.basedOnCanonicalHealthcareService)
                .map(extension => extension.valueReference?.reference)
        },
        'pcm-business-status': {
            type: 'token',
            values: resource => (resource.extension || [])
                .filter(extension => extension.url === EXTENSIONS.serviceBusinessStatus)
                .map(extension => extension.valueCoding)
        },
        _lastUpdated: { type: 'date', values: resource => [resource.meta?.lastUpdated] }
    }),
    Consent: Object.freeze({
        _id: { type: 'code', values: resource => [resource.id] },
        identifier: { type: 'token', values: resource => resource.identifier || [] },
        status: { type: 'code', values: resource => [resource.status] },
        patient: { type: 'reference', values: resource => [resource.patient?.reference] },
        'patient:identifier': { type: 'token', values: resource => [resource.patient?.identifier] },
        'pcm-service': {
            type: 'reference',
            values: resource => (resource.extension || [])
                .filter(extension => extension.url === EXTENSIONS.pcmService)
                .map(extension => extension.valueReference?.reference)
        },
        'pcm-business-status': {
            type: 'token',
            values: resource => (resource.extension || [])
                .filter(extension => extension.url === EXTENSIONS.consentBusinessStatus)
                .map(extension => extension.valueCoding)
        },
        _lastUpdated: { type: 'date', values: resource => [resource.meta?.lastUpdated] }
    })
});

class FHIRSearchError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FHIRSearchError';
        this.status = 400;
        this.code = 'invalid';
    }
}

const arrayValue = value => (Array.isArray(value) ? value : [value]);

function splitOrValues(value, name) {
    if (typeof value !== 'string' || value.length === 0) throw new FHIRSearchError(`${name} must not be empty`);
    const values = value.split(',');
    if (values.some(item => item.length === 0)) throw new FHIRSearchError(`${name} contains an empty OR value`);
    return values;
}

function parseToken(value, name) {
    const separator = value.indexOf('|');
    if (separator < 0) return { form: 'code', code: value };
    if (value.indexOf('|', separator + 1) >= 0) throw new FHIRSearchError(`${name} token contains multiple separators`);
    const system = value.slice(0, separator);
    const code = value.slice(separator + 1);
    if (!system && !code) throw new FHIRSearchError(`${name} token must contain a system or code`);
    if (!system) return { form: 'no-system', code };
    if (!code) return { form: 'system', system };
    return { form: 'system-code', system, code };
}

function parseReference(value, name) {
    if (/\s|\?|#|:\/\//.test(value)) throw new FHIRSearchError(`${name} must be a local literal reference`);
    const segments = value.split('/');
    if (segments.length > 2 || segments.some(segment => !segment)) throw new FHIRSearchError(`${name} is malformed`);
    return { type: segments.length === 2 ? segments[0] : null, id: segments.at(-1) };
}

function parseDate(value, name) {
    const match = /^(eq|ne|gt|lt|ge|le|sa|eb|ap)?(.+)$/.exec(value);
    const prefix = match?.[1] || 'eq';
    const literal = match?.[2];
    let start;
    let end;
    if (/^\d{4}$/.test(literal)) {
        start = Date.parse(`${literal}-01-01T00:00:00.000Z`);
        end = Date.parse(`${Number(literal) + 1}-01-01T00:00:00.000Z`);
    } else if (/^\d{4}-\d{2}$/.test(literal)) {
        const [year, month] = literal.split('-').map(Number);
        if (month < 1 || month > 12) throw new FHIRSearchError(`${name} contains an invalid date`);
        start = Date.UTC(year, month - 1, 1);
        end = Date.UTC(year, month, 1);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(literal)) {
        start = Date.parse(`${literal}T00:00:00.000Z`);
        end = start + 24 * 60 * 60 * 1000;
        if (new Date(start).toISOString().slice(0, 10) !== literal) throw new FHIRSearchError(`${name} contains an invalid date`);
    } else {
        start = Date.parse(literal);
        end = start + 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new FHIRSearchError(`${name} contains an invalid date`);
    return { prefix, start, end };
}

function parseValue(type, value, name) {
    if (type === 'token') return parseToken(value, name);
    if (type === 'reference') return parseReference(value, name);
    if (type === 'date') return parseDate(value, name);
    if (type === 'boolean') {
        if (!['true', 'false'].includes(value)) throw new FHIRSearchError(`${name} must be true or false`);
        return value === 'true';
    }
    if (type === 'thumbprint') {
        if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new FHIRSearchError(`${name} must be a base64url SHA-256 thumbprint`);
        return value;
    }
    if (name === 'status' && type === 'contract-status' && !['executed', 'revoked', 'terminated', 'entered-in-error', 'policy', 'draft'].includes(value)) {
        throw new FHIRSearchError('Unsupported Contract status');
    }
    return value;
}

/** Parse a closed resource-specific search request. */
function parseSearch(type, raw = {}) {
    const definitions = SEARCH_PARAMETERS[type];
    if (!definitions) throw new FHIRSearchError(`Unsupported search resource ${type}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new FHIRSearchError('Search parameters must be an object');
    const unknown = Object.keys(raw).filter(name => !Object.hasOwn(definitions, name) && !CONTROL_PARAMETERS.has(name)
        && !(type === 'Contract' && name === '_count'));
    if (unknown.length) throw new FHIRSearchError(`Unsupported ${type} search parameter(s): ${unknown.join(', ')}`);
    const clauses = [];
    for (const [name, definition] of Object.entries(definitions)) {
        if (!Object.hasOwn(raw, name)) continue;
        const repetitions = arrayValue(raw[name]);
        clauses.push({
            name,
            definition,
            groups: repetitions.map(repetition => splitOrValues(repetition, name)
                .map(value => parseValue(definition.type, value, name)))
        });
    }
    const includes = parseIncludes(type, raw);
    const pageValues = Object.hasOwn(raw, '_page') ? arrayValue(raw._page) : [];
    if (pageValues.length > 1 || (pageValues[0] !== undefined && (typeof pageValues[0] !== 'string' || !pageValues[0]))) {
        throw new FHIRSearchError('_page must be one non-empty opaque value');
    }
    let count;
    if (type === 'Contract' && Object.hasOwn(raw, '_count')) {
        if (typeof raw._count !== 'string' || !/^(?:[1-9]\d?|100)$/.test(raw._count)) throw new FHIRSearchError('_count must be one integer from 1 through 100');
        count = Number(raw._count);
    }
    return { type, clauses, includes, page: pageValues[0] || null, count };
}

function parseIncludes(type, raw) {
    const allowlist = INCLUDE_ALLOWLIST[type];
    const direct = Object.hasOwn(raw, '_include') ? arrayValue(raw._include) : [];
    const iterate = Object.hasOwn(raw, '_include:iterate') ? arrayValue(raw['_include:iterate']) : [];
    for (const value of [...direct, ...iterate]) {
        if (typeof value !== 'string' || !value) throw new FHIRSearchError('Include values must be non-empty strings');
    }
    const invalidDirect = direct.filter(value => !allowlist.direct.has(value));
    const invalidIterate = iterate.filter(value => !allowlist.iterate.has(value));
    if (invalidDirect.length || invalidIterate.length) {
        throw new FHIRSearchError(`Unsupported include path(s): ${[...invalidDirect, ...invalidIterate].join(', ')}`);
    }
    return { direct: [...new Set(direct)], iterate: [...new Set(iterate)] };
}

function tokenMatches(candidate, expected) {
    if (!candidate) return false;
    const system = candidate.system;
    const code = candidate.code ?? candidate.value;
    if (expected.form === 'code') return code === expected.code;
    if (expected.form === 'system') return system === expected.system;
    if (expected.form === 'no-system') return !system && code === expected.code;
    return system === expected.system && code === expected.code;
}

function referenceMatches(candidate, expected) {
    if (typeof candidate !== 'string') return false;
    const segments = candidate.split('/');
    const id = segments.at(-1);
    const type = segments.length > 1 ? segments.at(-2) : null;
    return id === expected.id && (!expected.type || type === expected.type);
}

function dateMatches(candidate, expected) {
    const instant = Date.parse(candidate);
    if (!Number.isFinite(instant)) return false;
    const { prefix, start, end } = expected;
    if (prefix === 'eq') return instant >= start && instant < end;
    if (prefix === 'ne') return instant < start || instant >= end;
    if (['gt', 'sa'].includes(prefix)) return instant >= end;
    if (['lt', 'eb'].includes(prefix)) return instant < start;
    if (prefix === 'ge') return instant >= start;
    if (prefix === 'le') return instant < end;
    const tolerance = Math.max(end - start, 1) * 0.1;
    return instant >= start - tolerance && instant < end + tolerance;
}

function valueMatches(type, candidate, expected) {
    if (type === 'token') return tokenMatches(candidate, expected);
    if (type === 'reference') return referenceMatches(candidate, expected);
    if (type === 'date') return dateMatches(candidate, expected);
    if (type === 'boolean') return candidate === expected;
    if (type === 'string') return typeof candidate === 'string' && candidate.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
    return candidate === expected;
}

/** FHIR repeats are AND; comma-separated values within a repeat are OR. */
function matchesSearch(resource, model) {
    return model.clauses.every(({ definition, groups }) => {
        const candidates = definition.values(resource).filter(value => value !== undefined && value !== null);
        return groups.every(group => group.some(expected =>
            candidates.some(candidate => valueMatches(definition.type, candidate, expected))));
    });
}

function canonicalRaw(raw) {
    return Object.fromEntries(Object.entries(raw)
        .filter(([name]) => name !== '_page')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [name, arrayValue(value).map(String)]));
}

class SearchPageCodec {
    constructor(secret = crypto.randomBytes(32)) {
        this.secret = Buffer.isBuffer(secret) ? secret : Buffer.from(secret);
    }

    signature(encoded) {
        return crypto.createHmac('sha256', this.secret).update(encoded).digest('base64url');
    }

    encode(payload) {
        const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
        return `${encoded}.${this.signature(encoded)}`;
    }

    decode(token) {
        const [encoded, signature, extra] = String(token).split('.');
        if (!encoded || !signature || extra || signature.length !== this.signature(encoded).length
            || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(this.signature(encoded)))) {
            throw new FHIRSearchError('Invalid or expired search page state');
        }
        try {
            const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
            if (!Number.isSafeInteger(payload.offset) || payload.offset < 0) throw new Error('invalid offset');
            return payload;
        } catch {
            throw new FHIRSearchError('Invalid or expired search page state');
        }
    }
}

const defaultPageCodec = new SearchPageCodec();

function queryBinding(type, raw, callerKey) {
    return crypto.createHash('sha256').update(JSON.stringify({ type, raw: canonicalRaw(raw), callerKey })).digest('base64url');
}

function referencesFor(resource, paths) {
    const references = [];
    if (resource.resourceType === 'Organization') {
        if (paths.includes('Organization:endpoint')) references.push(...(resource.endpoint || []).map(value => value.reference));
        if (paths.includes('Organization:partof')) references.push(resource.partOf?.reference);
    }
    if (resource.resourceType === 'Consent' && paths.includes('Consent:actor')) {
        references.push(...(resource.provision?.actor || []).map(actor => actor.reference?.reference));
    }
    return references.filter(Boolean);
}

function resolveReference(store, reference) {
    const [type, id, extra] = String(reference).split('/');
    if (!type || !id || extra) return null;
    return store.get(type, id);
}

function addAuthorizedInclude(entries, seen, store, reference, authorize) {
    const resource = resolveReference(store, reference);
    if (!resource || !authorize(resource)) return null;
    const key = `${resource.resourceType}/${resource.id}`;
    if (!seen.has(key)) {
        seen.add(key);
        entries.push({ resource, search: { mode: 'include' } });
    }
    return resource;
}

function encodeRaw(raw) {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(raw)) {
        if (name === '_page') continue;
        arrayValue(value).forEach(item => params.append(name, String(item)));
    }
    return params;
}

/** Execute one authorization-first FHIR search and return a searchset Bundle. */
function executeSearch({
    store,
    type,
    raw = {},
    authorize,
    baseUrl,
    callerKey,
    pageSize = 50,
    pageCodec = defaultPageCodec
}) {
    const model = parseSearch(type, raw);
    if (model.count !== undefined) pageSize = model.count;
    const binding = queryBinding(type, raw, callerKey);
    let offset = 0;
    if (model.page) {
        const payload = pageCodec.decode(model.page);
        if (payload.binding !== binding) throw new FHIRSearchError('Search page state does not match this caller or query');
        offset = payload.offset;
    }
    const authorized = store.getAll(type).filter(authorize);
    const matches = authorized.filter(resource => matchesSearch(resource, model));
    const page = matches.slice(offset, offset + pageSize);
    const entries = page.map(resource => ({ resource, search: { mode: 'match' } }));
    const seen = new Set(page.map(resource => `${resource.resourceType}/${resource.id}`));
    let includePool = [];
    for (const resource of page) {
        for (const reference of referencesFor(resource, model.includes.direct)) {
            const included = addAuthorizedInclude(entries, seen, store, reference, authorize);
            if (included) includePool.push(included);
        }
    }
    const visited = new Set();
    while (includePool.length) {
        const resource = includePool.shift();
        const key = `${resource.resourceType}/${resource.id}`;
        if (visited.has(key)) continue;
        visited.add(key);
        for (const reference of referencesFor(resource, model.includes.iterate)) {
            const included = addAuthorizedInclude(entries, seen, store, reference, authorize);
            if (included) includePool.push(included);
        }
    }
    const normalizedBase = String(baseUrl).replace(/\/$/, '');
    entries.forEach(entry => {
        entry.fullUrl = `${normalizedBase}/${entry.resource.resourceType}/${entry.resource.id}`;
    });
    const query = encodeRaw(raw);
    if (model.page) query.set('_page', model.page);
    const self = `${normalizedBase}/${type}${query.toString() ? `?${query}` : ''}`;
    const links = [{ relation: 'self', url: self }];
    if (offset + pageSize < matches.length) {
        const nextQuery = encodeRaw(raw);
        nextQuery.set('_page', pageCodec.encode({ binding, offset: offset + pageSize }));
        links.push({ relation: 'next', url: `${normalizedBase}/${type}?${nextQuery}` });
    }
    return {
        resourceType: 'Bundle',
        type: 'searchset',
        total: matches.length,
        link: links,
        entry: entries
    };
}

module.exports = {
    FHIRSearchError,
    INCLUDE_ALLOWLIST,
    SEARCH_PARAMETERS,
    SearchPageCodec,
    executeSearch,
    matchesSearch,
    parseSearch
};
