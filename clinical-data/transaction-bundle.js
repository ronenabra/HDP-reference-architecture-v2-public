'use strict';

/** Sprint 29 direct FHIR R4 synthetic transaction-bundle contract. */

const crypto = require('crypto');
const fs = require('fs');
const { guardedFetch } = require(fs.existsSync('/shared/outbound-destination.js')
    ? '/shared/outbound-destination' : '../src/shared/outbound-destination');
const path = require('path');
const { parseJsonBuffer } = require('./json-buffer');

function loadIdentityMapping() {
    for (const candidate of ['../src/shared/identity-mapping', '/shared/identity-mapping']) {
        try { return require(candidate); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
    throw new Error('shared identity-mapping contract is unavailable');
}
const { normalizePatientIdentifier } = loadIdentityMapping();

const DATASET_TAG_SYSTEM = 'urn:hdp-test-bundle:synthetic-dataset';
const SOURCE_TAG_SYSTEM = 'urn:hdp-test-bundle:synthetic-source';
const { DEFAULT_LIMITS, formatByteLimit, validateImportLimits } = require(fs.existsSync('/shared/clinical-import-limits.js')
    ? '/shared/clinical-import-limits' : '../src/shared/clinical-import-limits');
// Leave five seconds for the Admin response within the approved three-minute wait.
const PRIVATE_DATA_STATE_TIMEOUT_MS = 175_000;
// This is the single allowlist for managed-HAPI imports and target-wide probes.
// An import of a new type must add it here before any transaction can be sent.
const MANAGED_CLINICAL_RESOURCE_TYPES = Object.freeze([
    'AllergyIntolerance', 'Condition', 'DiagnosticReport', 'DocumentReference', 'Encounter', 'Immunization',
    'MedicationAdministration', 'MedicationDispense', 'MedicationRequest', 'MedicationStatement',
    'Observation', 'Organization', 'Patient', 'Practitioner',
    'PractitionerRole', 'Procedure', 'RelatedPerson', 'ServiceRequest', 'Specimen'
]);

function oneTag(resource, system, label) {
    const tags = (resource?.meta?.tag || []).filter(item => item?.system === system && typeof item.code === 'string' && item.code);
    if (tags.length !== 1) throw new TypeError(`${resource?.resourceType || 'resource'} must have exactly one ${label} tag`);
    return tags[0].code;
}

function collectReferences(value, output = []) {
    if (!value || typeof value !== 'object') return output;
    if (typeof value.reference === 'string' && value.reference.startsWith('urn:uuid:')) output.push(value.reference);
    for (const nested of Object.values(value)) collectReferences(nested, output);
    return output;
}

function validateTransactionResponse(response, expectedEntries) {
    if (!response || response.resourceType !== 'Bundle' || response.type !== 'transaction-response' || !Array.isArray(response.entry)) {
        throw new TypeError('HAPI response must be a transaction-response Bundle');
    }
    if (response.entry.length !== expectedEntries) throw new TypeError('HAPI transaction response entry count mismatch');
    response.entry.forEach((entry, index) => {
        const status = String(entry?.response?.status || '');
        if (!/^2\d\d(?:\s|$)/.test(status)) throw new TypeError(`HAPI rejected transaction entry ${index} with status ${status || 'missing'}`);
    });
    return true;
}

/** Count a private FHIR search exactly even when authorization omits Bundle.total. */
async function countSearchResults({ endpoint, initialUrl, headers, fetchImpl = guardedFetch, maxPages = 100 }) {
    let url = initialUrl;
    let count = 0;
    const visited = new Set();
    for (let page = 0; page < maxPages; page += 1) {
        if (visited.has(url)) throw new Error('FHIR count pagination repeated a page URL');
        visited.add(url);
        const response = await fetchImpl(url, { headers });
        const bundle = await response.json();
        if (!response.ok || bundle?.resourceType !== 'Bundle'
            || (bundle.entry !== undefined && !Array.isArray(bundle.entry))) {
            throw new Error(`FHIR count search failed with HTTP ${response.status || 'unknown'}: ${JSON.stringify(bundle)}`);
        }
        if (page === 0 && Number.isSafeInteger(bundle.total) && bundle.total >= 0) return bundle.total;
        count += bundle.entry?.length || 0;
        const next = (bundle.link || []).find(link => link?.relation === 'next')?.url;
        if (!next) return count;
        const parsed = new URL(next);
        const transport = new URL(endpoint);
        transport.pathname = parsed.pathname;
        transport.search = parsed.search;
        url = transport.toString();
    }
    throw new Error(`FHIR count pagination exceeded ${maxPages} pages`);
}

/** Read an exact private aggregate, falling back to ID pages only for known older HAPI images.
 * @param {object} options Private transport and a search URL including its scope filters.
 * @returns {Promise<number>} Exact matching-resource count; invalid aggregate responses fail closed.
 */
async function countExactSearch({ endpoint, initialUrl, headers, fetchImpl = guardedFetch }) {
    const url = new URL(initialUrl);
    url.searchParams.set('_summary', 'count');
    url.searchParams.set('_total', 'accurate');
    const countHeaders = { ...headers, 'Cache-Control': 'no-cache' };
    const response = await fetchImpl(url.toString(), { headers: countHeaders });
    const bundle = await response.json();
    const unsupported = response.status === 400 && bundle?.resourceType === 'OperationOutcome'
        && Array.isArray(bundle.issue)
        && bundle.issue.some(issue => /HAPI-203[78]:.*(?:_summary=count|_total=accurate) is not permitted on this server/.test(issue?.diagnostics || ''));
    if (!unsupported) {
        if (!response.ok || bundle?.resourceType !== 'Bundle' || !Number.isSafeInteger(bundle.total) || bundle.total < 0) {
            throw new Error(`Private HAPI exact count response is invalid (HTTP ${response.status || 'unknown'}): ${JSON.stringify(bundle)}`);
        }
        return bundle.total;
    }
    url.searchParams.delete('_summary');
    url.searchParams.delete('_total');
    url.searchParams.set('_elements', 'id');
    url.searchParams.set('_count', '1000');
    return countSearchResults({ endpoint, initialUrl: url.toString(), headers: countHeaders, fetchImpl });
}

/** Verify exact source/dataset counts after an accepted transaction without downloading resource bodies.
 * @param {object} transport Private endpoint, headers and fetch implementation.
 * @param {object} inspected Validated transaction metadata.
 * @param {function} onTypeVerified Progress callback for each managed type, including expected zeros.
 * @returns {Promise<object>} Verified populated counts by resource type.
 */
async function verifyTaggedCounts(transport, inspected, onTypeVerified = () => {}) {
    const counts = {};
    for (const type of MANAGED_CLINICAL_RESOURCE_TYPES) {
        const expected = inspected.counts[type] || 0;
        const initialUrl = `${transport.endpoint}/${type}?_tag=${encodeURIComponent(`${SOURCE_TAG_SYSTEM}|${inspected.source}`)}&_tag=${encodeURIComponent(`${DATASET_TAG_SYSTEM}|${inspected.version}`)}`;
        const actual = await countExactSearch({ ...transport, initialUrl });
        if (actual !== expected) throw new Error(`${type} verification count mismatch: expected ${expected}, received ${actual}`);
        if (expected) counts[type] = actual;
        onTypeVerified(type, actual);
    }
    return counts;
}

/** Validate the complete uploaded buffer before a target can be mutated. */
function inspectTransactionBundle(buffer, options = {}) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('transaction bundle must be supplied as a Buffer');
    const limits = validateImportLimits({ ...DEFAULT_LIMITS, ...(options.limits || {}) });
    if (!buffer.length) throw new TypeError('transaction bundle is empty');
    if (buffer.length > limits.maxBytes) throw new TypeError(`transaction bundle exceeds maxBytes ${formatByteLimit(limits.maxBytes)}`);
    let bundle;
    try { bundle = parseJsonBuffer(buffer); } catch (error) { throw new TypeError(`transaction bundle is not valid JSON: ${error.message}`); }
    if (bundle?.resourceType !== 'Bundle' || bundle?.type !== 'transaction' || !Array.isArray(bundle.entry) || !bundle.entry.length) {
        throw new TypeError('upload must be a non-empty FHIR R4 transaction Bundle');
    }
    if (bundle.entry.length > limits.maxEntries) throw new TypeError(`transaction bundle exceeds maxEntries ${limits.maxEntries}`);
    const fullUrls = new Set();
    const counts = {};
    const sources = new Set();
    const versions = new Set();
    const patients = [];
    for (const [index, entry] of bundle.entry.entries()) {
        const resource = entry?.resource;
        const resourceType = resource?.resourceType;
        if (!/^[A-Z][A-Za-z0-9]+$/.test(resourceType || '')) throw new TypeError(`entry ${index} resourceType is invalid`);
        if (!MANAGED_CLINICAL_RESOURCE_TYPES.includes(resourceType)
            || (options.supportedResourceTypes && !options.supportedResourceTypes.includes(resourceType))) {
            throw new TypeError(`entry ${index} resource type ${resourceType} is unsupported by managed-HAPI import`);
        }
        if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(entry.fullUrl || '')) throw new TypeError(`entry ${index} fullUrl must be a urn:uuid`);
        if (fullUrls.has(entry.fullUrl)) throw new TypeError(`entry ${index} duplicates fullUrl ${entry.fullUrl}`);
        fullUrls.add(entry.fullUrl);
        if (!['POST', 'PUT'].includes(entry?.request?.method)) throw new TypeError(`entry ${index} request method is unsupported`);
        const expectedUrl = entry.request.method === 'POST' ? resourceType : `${resourceType}/${resource.id || ''}`;
        if (entry.request.url !== expectedUrl) throw new TypeError(`entry ${index} request URL does not match its resource`);
        if (entry.request.method === 'PUT' && !resource.id) throw new TypeError(`entry ${index} PUT resource requires id`);
        sources.add(oneTag(resource, SOURCE_TAG_SYSTEM, 'synthetic source'));
        versions.add(oneTag(resource, DATASET_TAG_SYSTEM, 'synthetic dataset'));
        counts[resourceType] = (counts[resourceType] || 0) + 1;
        if (resourceType === 'Patient') {
            const stable = (resource.identifier || []).find(identifier => identifier?.system && identifier?.value);
            if (!stable) throw new TypeError(`entry ${index} Patient lacks a stable identifier`);
            // Producer bundles also carry internal UUID and cohort identifiers.
            // Only identifiers admitted by the pinned PCM contract are useful
            // in the Doctor consent flow, so keep the verified inventory
            // actionable without weakening the public Consent profile.
            const actionable = (resource.identifier || []).find(identifier => {
                try { normalizePatientIdentifier(identifier); return true; } catch (_error) { return false; }
            });
            if (actionable) {
                patients.push({
                    idSystem: actionable.system,
                    idValue: actionable.value,
                    display: resource.name?.[0]?.text || [resource.name?.[0]?.given?.join(' '), resource.name?.[0]?.family].filter(Boolean).join(' ') || actionable.value
                });
            }
        }
    }
    if (sources.size !== 1 || versions.size !== 1) throw new TypeError('transaction bundle must contain one consistent synthetic source and dataset version');
    if (options.expectedSource && [...sources][0] !== options.expectedSource) throw new TypeError(`Target expected source ${options.expectedSource}, received ${[...sources][0]}`);
    for (const [index, entry] of bundle.entry.entries()) {
        for (const reference of collectReferences(entry.resource)) {
            if (!fullUrls.has(reference)) throw new TypeError(`entry ${index} has unresolved local reference ${reference}`);
        }
    }
    return Object.freeze({
        bundle,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        bytes: buffer.length,
        entries: bundle.entry.length,
        source: [...sources][0],
        version: [...versions][0],
        counts: Object.freeze(Object.fromEntries(Object.entries(counts).sort())),
        patients: Object.freeze(patients)
    });
}

function safeBundlePath(bundleRoot, reference) {
    if (typeof reference !== 'string' || !reference || path.isAbsolute(reference) || reference.split(/[\\/]+/).includes('..')) {
        throw new TypeError('bundle reference must be a safe path relative to bundleRoot');
    }
    const root = fs.realpathSync(bundleRoot);
    const candidate = fs.realpathSync(path.resolve(root, reference));
    if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) throw new TypeError('bundle reference escapes bundleRoot');
    if (!candidate.endsWith('.json')) throw new TypeError('bundle reference must identify a JSON file');
    return candidate;
}

/** Request the complete server history, including deleted versions.
 * HAPI's implicit history start can omit system/type versions. An explicit FHIR
 * instant at the earliest supported year includes all server-created history.
 * @param {string} endpoint Exact private FHIR base.
 * @param {number} count Requested history page size.
 * @returns {string} Full-history URL; continuation links preserve this origin.
 */
function privateHistoryUrl(endpoint, count) {
    return `${endpoint}/_history?_count=${count}&_since=0001-01-01T00%3A00%3A00Z`;
}

/** Inspect all managed resource types and history before deciding a target is empty.
 * @param {object} options Private endpoint, credential headers, and HTTP client.
 * @returns {Promise<object>} Current counts and whether any history remains.
 */
async function readPrivateDataState({ endpoint, headers, fetchImpl = guardedFetch, timeoutMs = PRIVATE_DATA_STATE_TIMEOUT_MS, signal }) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Private count timeout must be a positive integer');
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`Private HAPI count/history deadline exceeded after ${timeoutMs} ms; target state is unavailable`)), timeoutMs);
    const started = Date.now();
    const diagnostics = { requests: 0, responseBytes: 0, elapsedMs: 0 };
    const counts = {};
    const countHeaders = { ...headers, 'Cache-Control': 'no-cache' };
    let countOnlySupported = true;
    /** Account for decoded payload size and share one deadline across every page/type. */
    const request = async (url, init = {}) => {
        controller.signal.throwIfAborted();
        diagnostics.requests += 1;
        try {
            const response = await fetchImpl(url, { ...init, signal: controller.signal });
            const bundle = await response.json();
            diagnostics.responseBytes += Buffer.byteLength(JSON.stringify(bundle));
            controller.signal.throwIfAborted();
            return { ok: response.ok, status: response.status, json: async () => bundle };
        } catch (error) {
            // Native HTTP clients may replace the deadline reason with a generic AbortError.
            controller.signal.throwIfAborted();
            throw error;
        }
    };
    /** Use HAPI's exact aggregate without loading resources; retain older private servers. */
    const countResourceType = async resourceType => {
        if (countOnlySupported) {
            const response = await request(`${endpoint}/${resourceType}?_summary=count&_total=accurate`, { headers: countHeaders });
            const bundle = await response.json();
            // Older images apply ConsentInterceptor's count prohibition to private reads.
            // Only that known capability rejection permits the slower compatibility path.
            const unsupported = response.status === 400 && bundle?.resourceType === 'OperationOutcome'
                && Array.isArray(bundle.issue)
                && bundle.issue.some(issue => /HAPI-203[78]:.*(?:_summary=count|_total=accurate) is not permitted on this server/.test(issue?.diagnostics || ''));
            if (!unsupported) {
                if (!response.ok || bundle?.resourceType !== 'Bundle'
                    || !Number.isSafeInteger(bundle.total) || bundle.total < 0) {
                    throw new Error(`Private HAPI exact count response is invalid (HTTP ${response.status || 'unknown'}): ${JSON.stringify(bundle)}`);
                }
                return bundle.total;
            }
            countOnlySupported = false;
        }
        return countSearchResults({ endpoint,
            initialUrl: `${endpoint}/${resourceType}?_elements=id&_count=1000`, headers: countHeaders, fetchImpl: request });
    };
    try {
        const pending = [...MANAGED_CLINICAL_RESOURCE_TYPES];
        // Three workers bound private HAPI load while avoiding serial per-type latency.
        await Promise.all(Array.from({ length: 3 }, async () => {
            while (pending.length) {
                const resourceType = pending.shift();
                try {
                    counts[resourceType] = await countResourceType(resourceType);
                } catch (error) {
                    throw new Error(`Private HAPI count failed for ${resourceType}: ${error.message}`, { cause: error });
                }
            }
        }));
        const response = await request(privateHistoryUrl(endpoint, 1), { headers: countHeaders });
        if (!response.ok) throw new Error(`HAPI history probe failed with HTTP ${response.status}`);
        const history = await response.json();
        if (history.resourceType !== 'Bundle' || (history.entry !== undefined && !Array.isArray(history.entry))
            || (history.total !== undefined && (!Number.isSafeInteger(history.total) || history.total < 0))) {
            throw new Error('HAPI history probe response is malformed');
        }
        diagnostics.elapsedMs = Date.now() - started;
        return { counts, currentResourceCount: Object.values(counts).reduce((sum, count) => sum + count, 0),
            hasHistory: Boolean(history.entry?.length || history.total || history.link?.some(link => link?.relation === 'next')), diagnostics };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        controller.abort();
    }
}

module.exports = {
    DATASET_TAG_SYSTEM,
    DEFAULT_LIMITS,
    MANAGED_CLINICAL_RESOURCE_TYPES,
    PRIVATE_DATA_STATE_TIMEOUT_MS,
    SOURCE_TAG_SYSTEM,
    collectReferences,
    countSearchResults,
    countExactSearch,
    verifyTaggedCounts,
    inspectTransactionBundle,
    readPrivateDataState,
    privateHistoryUrl,
    safeBundlePath,
    validateTransactionResponse
};
