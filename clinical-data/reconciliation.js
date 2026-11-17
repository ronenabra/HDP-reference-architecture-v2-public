'use strict';
/** Read-only stopped-import recovery using recorded acceptance or complete-content proof. */
const crypto = require('crypto');
const fs = require('fs');
const { inspectTransactionBundle, MANAGED_CLINICAL_RESOURCE_TYPES, countSearchResults, readPrivateDataState, privateHistoryUrl, verifyTaggedCounts } = require('./transaction-bundle');
const { clinicalDeadlines, deadlineFetch, readOnlyStageFetch } = require('./deadlines');

/** Canonical JSON sorts object keys while preserving array order. */
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}

/** Compare exact resource content, allowing assigned identity and unordered FHIR metadata.
 * @param {object} resource Source or persisted FHIR resource.
 * @param {function} replaceReference Resolver for transaction-local references.
 * @returns {string} Canonical content with metadata set order normalized, never deduplicated.
 */
function normalizedResource(resource, replaceReference = value => value) {
    const visit = (value, root = false) => {
        if (Array.isArray(value)) return value.map(item => visit(item));
        if (!value || typeof value !== 'object') return value;
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            if (root && key === 'id') continue;
            if (root && key === 'meta') {
                const meta = { ...item };
                delete meta.versionId;
                delete meta.lastUpdated;
                // FHIR R4 defines these metadata lists as sets. HAPI stores their
                // members separately and returns them in its own order. Preserve
                // each complete member and duplicates so changed metadata fails.
                for (const field of ['tag', 'security', 'profile']) {
                    // Primitive extension companions must retain positional pairing.
                    if (Array.isArray(meta[field]) && !meta[`_${field}`]) {
                        meta[field] = [...meta[field]].sort((left, right) => {
                            const a = JSON.stringify(canonical(left));
                            const b = JSON.stringify(canonical(right));
                            return a < b ? -1 : a > b ? 1 : 0;
                        });
                    }
                }
                if (Object.keys(meta).length) result.meta = visit(meta);
                continue;
            }
            result[key] = key === 'reference' && typeof item === 'string' ? replaceReference(item) : visit(item);
        }
        return result;
    };
    return JSON.stringify(canonical(visit(resource, true)));
}

/** Fetch complete bodies within the validated row bound, independently of Bundle.total.
 * @param {object} transport Private endpoint, headers and fetch implementation.
 * @param {string} type Managed FHIR resource type to enumerate.
 * @param {number} maxEntries Expected maximum current rows from the inspected upload.
 * @returns {Promise<object[]>} Every live resource, including when the server caps page size.
 */
async function readAllResources({ endpoint, headers, fetchImpl }, type, maxEntries) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) throw new TypeError('invalid reconciliation entry limit');
    // _count is only a hint: permit one page per expected row and a final empty page.
    const maxPages = maxEntries + 1;
    let url = `${endpoint}/${type}?_count=1000`;
    const visited = new Set();
    const resources = [];
    for (let page = 0; page < maxPages; page += 1) {
        if (visited.has(url)) throw new Error(`${type} pagination repeated a page`);
        visited.add(url);
        const response = await fetchImpl(url, { headers });
        const bundle = await response.json();
        if (!response.ok || bundle?.resourceType !== 'Bundle' || !Array.isArray(bundle.entry || [])) {
            throw new Error(`${type} reconciliation search failed with HTTP ${response.status || 'unknown'}`);
        }
        for (const entry of bundle.entry || []) {
            if (entry?.resource?.resourceType !== type || !entry.resource.id) throw new Error(`${type} search returned malformed resource`);
            resources.push(entry.resource);
            if (resources.length > maxEntries) throw new Error(`${type} has extra or duplicate resources`);
        }
        const next = (bundle.link || []).find(link => link?.relation === 'next')?.url;
        if (!next) {
            if (Number.isSafeInteger(bundle.total) && bundle.total !== resources.length) throw new Error(`${type} total differs from enumerated resources`);
            return resources;
        }
        const parsed = new URL(next);
        const base = new URL(endpoint);
        const fhirPath = base.pathname.replace(/\/$/, '');
        if (parsed.pathname !== fhirPath && !parsed.pathname.startsWith(`${fhirPath}/`)) {
            throw new Error(`${type} pagination escaped the private FHIR base`);
        }
        base.pathname = parsed.pathname;
        base.search = parsed.search;
        url = base.toString();
    }
    throw new Error(`${type} reconciliation exceeded ${maxPages} pages`);
}

/** Prove a one-to-one exact body/reference match and no foreign current data. */
async function verifyLiveTransaction({ endpoint, headers, fetchImpl, inspected }) {
    const expected = inspected.bundle.entry;
    const actual = [];
    const counts = {};
    for (const type of MANAGED_CLINICAL_RESOURCE_TYPES) {
        const resources = await readAllResources({ endpoint, headers, fetchImpl }, type, inspected.counts[type] || 0);
        if (resources.length !== (inspected.counts[type] || 0)) throw new Error(`${type} complete-content count mismatch`);
        if (resources.length) counts[type] = resources.length;
        actual.push(...resources);
    }
    if (actual.length !== inspected.entries) throw new Error('target contains partial or foreign data');
    const ids = new Set(actual.map(resource => `${resource.resourceType}/${resource.id}`));
    if (ids.size !== actual.length) throw new Error('target search contains duplicate resource identities');

    // First match independent fields. Ambiguous equal bodies cannot safely bind urn references.
    const available = new Map();
    const eraseReference = () => '__REFERENCE__';
    for (const resource of actual) {
        const key = normalizedResource(resource, eraseReference);
        if (!available.has(key)) available.set(key, []);
        available.get(key).push(resource);
    }
    const references = new Map();
    const pairs = [];
    for (const [index, entry] of expected.entries()) {
        const candidates = available.get(normalizedResource(entry.resource, eraseReference)) || [];
        if (candidates.length !== 1) throw new Error(
            `live ${entry.resource.resourceType} content at transaction entry ${index} is missing, changed, duplicated, or ambiguous`);
        const resource = candidates.pop();
        if (entry.request.method === 'PUT' && resource.id !== entry.resource.id) throw new Error('PUT resource identity changed');
        references.set(entry.fullUrl, `${resource.resourceType}/${resource.id}`);
        pairs.push([entry.resource, resource]);
    }
    for (const [source, live] of pairs) {
        const resolved = value => references.get(value) || value;
        if (normalizedResource(source, resolved) !== normalizedResource(live, value => {
            if (!/^https?:/.test(value)) return value;
            const parsed = new URL(value);
            const base = new URL(endpoint);
            if (parsed.origin !== base.origin) return value;
            return parsed.pathname.split('/').slice(-2).join('/');
        })) throw new Error('live references or resource content changed');
        if (live.meta?.versionId !== '1') throw new Error('live resource has an unexpected version history');
    }
    const history = await countSearchResults({ endpoint, initialUrl: privateHistoryUrl(endpoint, 1000),
        headers, fetchImpl, maxPages: inspected.entries + 1 });
    if (history !== inspected.entries) throw new Error(`target history differs from one transaction: expected ${inspected.entries}, received ${history}`);
    return { counts, history, contentSha256: crypto.createHash('sha256').update(actual.map(resource => normalizedResource(resource)).sort().join('\n')).digest('hex') };
}

/** Reconcile one stopped owner; failed proof retains the target reservation. */
async function reconcileOperation({ registry, operationId, workersStopped, targetIdentity, uploadPath,
    limits, endpoint, headers, fetchImpl, deadlines = clinicalDeadlines(), cleanup = async () => {} }) {
    const operation = registry.get(operationId);
    if (!operation) throw new Error('unknown data operation');
    if (workersStopped !== true) throw new Error('reconciliation requires confirmed stopped workers');
    if (!operation.mutationSubmitted || (!operation.needsReconciliation && !['loading', 'verifying'].includes(operation.phase))
        || !['import', 'bootstrap', 'replace'].includes(operation.kind)) {
        throw new Error('operation has no uncertain submitted transaction to verify');
    }
    if (operation.targetIdentity !== targetIdentity) throw new Error('managed target configuration changed');
    if (!fs.existsSync(uploadPath)) throw new Error('saved upload is missing; target remains blocked for scoped reset/replacement');
    const inspected = inspectTransactionBundle(fs.readFileSync(uploadPath), { limits });
    if (inspected.sha256 !== operation.sha256 || inspected.entries !== operation.entries || inspected.bytes !== operation.bytes
        || inspected.source !== operation.source || inspected.version !== operation.version) throw new Error('saved upload differs from reserved operation');
    const releaseBarrier = registry.beginReconciliation(operationId, { workersStopped, targetIdentity });
    try {
        const transport = { endpoint, headers, fetchImpl: readOnlyStageFetch(fetchImpl, deadlines) };
        let evidence;
        // Acceptance is recorded only after every transaction-response entry passes
        // validation. A later count/publication failure does not require body proof.
        // Keep the stronger proof for lost responses and all uncertain submissions.
        const accepted = operation.stageTimestamps?.['transaction-accepted']
            && ['read-only-verification', 'publication'].includes(operation.failureStage)
            && operation.beforeResourceCount === 0 && operation.hasHistory === false;
        if (accepted) {
            const counts = await verifyTaggedCounts(transport, inspected);
            const state = await readPrivateDataState(transport);
            for (const type of MANAGED_CLINICAL_RESOURCE_TYPES) {
                if (state.counts[type] !== (inspected.counts[type] || 0)) throw new Error(`${type} target count mismatch after accepted transaction`);
            }
            if (!state.hasHistory) throw new Error('accepted transaction has no persisted history');
            evidence = { counts, hasHistory: state.hasHistory, verificationMethod: 'accepted-transaction-counts',
                verifiedTypes: MANAGED_CLINICAL_RESOURCE_TYPES.map(type => ({ type, count: counts[type] || 0 })),
                verificationTypeTotal: MANAGED_CLINICAL_RESOURCE_TYPES.length };
        } else evidence = { ...await verifyLiveTransaction({ ...transport, inspected }), verificationMethod: 'complete-content' };
        const completed = registry.completeReconciliation(operationId, { ...evidence, deadlines, verifiedCounts: evidence.counts,
            patients: inspected.patients, reconciliationVerifiedAt: new Date().toISOString(), submittedOutcome: 'verified-complete' });
        try { await cleanup(); } catch (error) { registry.write({ ...completed,
            diagnostics: [...completed.diagnostics, `Verified upload cleanup failed: ${error.message}`] }); }
        return registry.get(operationId);
    } catch (error) {
        if (registry.get(operationId)?.needsReconciliation) registry.noteReconciliationFailure(operationId, error);
        throw error;
    } finally { releaseBarrier(); }
}

/** Explicitly resolve an unprovable import by resetting only its reserved target. */
async function resetUncertainTarget({ registry, operationId, workersStopped, confirmation, expectedConfirmation,
    targetIdentity, endpoint, headers, fetchImpl, deadlines = clinicalDeadlines() }) {
    const operation = registry.get(operationId);
    if (!operation?.mutationSubmitted || (!operation.needsReconciliation && !['loading', 'verifying', 'resetting'].includes(operation.phase))) throw new Error('operation has no uncertain submitted mutation');
    if (workersStopped !== true) throw new Error('target reset requires confirmed stopped workers and HAPI transaction');
    if (operation.targetIdentity !== targetIdentity) throw new Error('managed target configuration changed');
    if (!confirmation || confirmation !== expectedConfirmation) throw new Error('target-specific reset confirmation is missing or stale');
    const releaseBarrier = registry.beginReconciliation(operationId, { workersStopped, targetIdentity });
    try {
        const boundedFetch = deadlineFetch(fetchImpl, deadlines);
        const response = await boundedFetch(`${endpoint}/$expunge`, { method: 'POST', headers,
            body: JSON.stringify({ resourceType: 'Parameters', parameter: [
                { name: 'expungeDeletedResources', valueBoolean: true },
                { name: 'expungePreviousVersions', valueBoolean: true },
                { name: 'expungeEverything', valueBoolean: true }
            ] }) });
        if (!response.ok) throw new Error(`target-scoped expunge returned HTTP ${response.status}`);
        const state = await readPrivateDataState({ endpoint, headers, fetchImpl: readOnlyStageFetch(fetchImpl, deadlines) });
        if (state.currentResourceCount || state.hasHistory) throw new Error('target-scoped reset did not verify zero resources and history');
        return registry.completeResetReconciliation(operationId, state.counts);
    } catch (error) {
        registry.noteReconciliationFailure(operationId, error);
        throw error;
    } finally { releaseBarrier(); }
}

module.exports = { reconcileOperation, resetUncertainTarget, verifyLiveTransaction, readAllResources, normalizedResource };
