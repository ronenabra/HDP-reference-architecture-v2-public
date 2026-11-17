'use strict';
/** Shared managed clinical decisions. Callers retain transport and scoped worker cleanup. */
const fs = require('fs');
const path = require('path');
const { latestVerifiedLoad } = require('./operation-owner');
const { clinicalDeadlines, deadlineFetch, readOnlyStageFetch } = require('./deadlines');
const { verifyLiveTransaction } = require('./reconciliation');
const { sanitizeLogMessage } = require(fs.existsSync('/shared/log-policy.js') ? '/shared/log-policy' : '../src/shared/log-policy');
const { MANAGED_CLINICAL_RESOURCE_TYPES, inspectTransactionBundle, readPrivateDataState, verifyTaggedCounts: verifyCounts, validateTransactionResponse } = require('./transaction-bundle');

/** Parse a private FHIR response without treating an HTTP failure as verification.
 * @param {Response} response Private HTTP response.
 * @returns {Promise<object>} Parsed successful FHIR payload.
 */
async function parseFhirResponse(response) {
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch (_) { throw new Error(`HAPI returned malformed JSON with HTTP ${response.status}: ${text}`); }
    if (!response.ok) throw new Error(`HAPI returned HTTP ${response.status}: ${text}`);
    return body;
}

/** Publish only a verified ledger result, after the caller has completed cleanup.
 * @param {DataOperationRegistry} registry Owning ledger instance.
 * @param {object} operation Reserved operation identity.
 * @returns {object} Completed ledger record.
 */
function publishOperation(registry, operation) {
    const current = registry.get(operation.id);
    if (current?.phase !== 'verifying') throw new Error('clinical operation has no verified result to publish');
    registry.recordProgress(operation.id, 'inventory-publication-started');
    return registry.transition(operation.id, 'succeeded', { result: current.result || 'verified' });
}

/** Record uncertainty without releasing ownership after any submitted mutation.
 * @param {DataOperationRegistry} registry Owning ledger instance.
 * @param {object} operation Reserved operation identity.
 * @param {Error} error Failure diagnostic to retain.
 */
function failOperation(registry, operation, error, stage = error.clinicalFailureStage || 'unknown') {
    const current = registry.get(operation.id);
    if (current && !['succeeded', 'failed'].includes(current.phase)) {
        registry.transition(operation.id, 'failed', { needsReconciliation: current.mutationSubmitted === true || current.needsReconciliation === true,
            submittedOutcome: current.mutationSubmitted ? 'unknown' : 'not-submitted',
            failureStage: error.clinicalFailureStage || current.failureStage || stage,
            failureDeadlineMs: error.clinicalDeadlineMs || current.failureDeadlineMs || null,
            diagnostics: [...(current.diagnostics || []), sanitizeLogMessage(error.message)] });
    }
}

/** Inspect target state under an existing reservation without changing it.
 * @param {object} options Owner, inspected bundle, private transport and import policy.
 * @returns {Promise<object>} Before-state, skip decision, or existing marker to reconcile.
 */
async function preflightTarget({ registry, operation, inspected, transport, policy = 'manual', legacyStateDir }) {
    if (operation.kind === 'reset') return {};
    if (legacyStateDir && operation.kind !== 'replace') {
        const legacyMarker = path.join(legacyStateDir, `${inspected.sha256}.json`);
        if (fs.existsSync(legacyMarker)) return { legacyMarker };
    }
    const prior = latestVerifiedLoad(registry, operation.serverId);
    if (policy === 'manual' && prior?.sha256 === inspected.sha256 && operation.kind !== 'replace') {
        throw Object.assign(new Error('this POST-based bundle is already loaded; use explicit replace to prevent duplicates'), { statusCode: 409 });
    }
    const state = await readPrivateDataState(transport);
    const nonempty = state.currentResourceCount > 0 || state.hasHistory;
    if (nonempty && policy === 'manual' && operation.kind !== 'replace') {
        throw Object.assign(new Error('The target is non-empty; request explicit replace to avoid POST duplicates.'), { statusCode: 409 });
    }
    return { beforeCounts: state.counts, beforeResourceCount: state.currentResourceCount, hasHistory: state.hasHistory,
        ...(nonempty && policy === 'if-empty' ? { result: 'skipped',
            skipReason: state.currentResourceCount ? 'target-non-empty' : 'target-has-history' } : {}) };
}

/** Execute preflight, optional reset, transaction submission and persisted-count verification.
 * @param {object} options Owner, bundle/transport, optional reset and cleanup callbacks.
 * @returns {Promise<object>} Verified pending record for a CLI child, or completed Admin record.
 */
async function executeOperation({ registry, operation, buffer, limits, policy = 'manual', endpoint, headers,
    fetchImpl, deadlines = clinicalDeadlines(), legacyStateDir, bundleName, reset, cleanup = async () => {},
    deferCompletion = false, onDiagnostic = () => {} }) {
    const boundedFetch = deadlineFetch(fetchImpl, deadlines);
    const transport = { endpoint, headers, fetchImpl: readOnlyStageFetch(fetchImpl, deadlines) };
    registry.assertOwner(operation);
    const preflightPhase = registry.get(operation.id).phase === 'resetting' ? 'resetting' : 'validating';
    registry.transition(operation.id, preflightPhase);
    const recordOnce = event => {
        if (!registry.get(operation.id).stageTimestamps?.[event]) registry.recordProgress(operation.id, event);
    };
    let legacyMarker;
    let verified = false;
    let failureStage = 'validation';
    try {
        registry.transition(operation.id, preflightPhase, { deadlines });
        if (operation.kind !== 'reset') recordOnce('bundle-check-started');
        const inspected = operation.kind === 'reset' ? null : inspectTransactionBundle(buffer, { limits });
        if (inspected && operation.sha256 && operation.sha256 !== inspected.sha256) throw new Error('queued upload checksum changed');
        const details = inspected ? { bundleName, sha256: inspected.sha256, bytes: inspected.bytes,
            entries: inspected.entries, source: inspected.source, version: inspected.version,
            counts: inspected.counts, patients: inspected.patients, verificationTypeTotal: MANAGED_CLINICAL_RESOURCE_TYPES.length } : {};
        registry.transition(operation.id, preflightPhase, details);
        if (inspected) recordOnce('bundle-check-complete');
        failureStage = 'read-only-preflight';
        recordOnce('target-preflight-started');
        const preflight = await preflightTarget({ registry, operation, inspected, transport, policy, legacyStateDir });
        registry.transition(operation.id, preflightPhase, preflight);
        recordOnce('target-preflight-complete');
        let reconciled = false;
        legacyMarker = preflight.legacyMarker;
        if (legacyMarker) {
            // A marker is a claim about an existing POST, never permission to replay it.
            registry.transition(operation.id, preflightPhase, { mutationSubmitted: true, inventoryInvalidated: true });
            const prior = JSON.parse(fs.readFileSync(legacyMarker, 'utf8'));
            if (prior.status !== 'complete' || prior.targetHo !== operation.serverId || prior.sha256 !== inspected.sha256
                || prior.entries !== inspected.entries || Object.entries(inspected.counts).some(([type, count]) => prior.verifiedCounts?.[type] !== count)) {
                throw new Error('legacy import evidence requires explicit reconciliation before another transaction');
            }
            failureStage = 'read-only-verification';
            registry.recordProgress(operation.id, 'verification-started');
            transport.fetchImpl = readOnlyStageFetch(fetchImpl, deadlines);
            const evidence = await verifyLiveTransaction({ ...transport, inspected });
            registry.transition(operation.id, 'verifying', { verifiedCounts: evidence.counts,
                contentSha256: evidence.contentSha256, history: evidence.history, result: 'verified', legacyMarker });
            reconciled = true;
        }
        if (!reconciled) {
            if (operation.kind === 'reset' || operation.kind === 'replace') {
                failureStage = 'target-reset';
                if (!reset) throw new Error('explicit reset implementation is required');
                registry.recordProgress(operation.id, 'reset-started');
                await reset();
                failureStage = 'read-only-verification';
                transport.fetchImpl = readOnlyStageFetch(fetchImpl, deadlines);
                const state = await readPrivateDataState(transport);
                if (state.currentResourceCount || state.hasHistory) throw new Error('delete-all verification expected zero resources/history');
                registry.transition(operation.id, 'resetting', { resetVerifiedAt: new Date().toISOString(), zeroCounts: state.counts });
                registry.recordProgress(operation.id, 'reset-complete');
                // Verified zero history retires all old import claims for this named target.
                if (legacyStateDir && fs.existsSync(legacyStateDir)) {
                    for (const name of fs.readdirSync(legacyStateDir)) {
                        if (/^[a-f0-9]{64}\.json$/.test(name)) fs.unlinkSync(path.join(legacyStateDir, name));
                    }
                }
            }
            if (preflight.result === 'skipped') registry.transition(operation.id, 'verifying', preflight);
            else if (inspected) {
                registry.transition(operation.id, 'loading', { mutationSubmitted: true, inventoryInvalidated: true });
                failureStage = 'hapi-transaction-wait';
                registry.recordProgress(operation.id, 'transaction-waiting', {
                    deadlineMs: deadlines.connectUploadMs + deadlines.transactionWaitMs
                });
                onDiagnostic('request', 'info', { endpoint, entries: inspected.entries,
                    deadlineMs: deadlines.connectUploadMs + deadlines.transactionWaitMs });
                const response = await boundedFetch(endpoint, {
                    method: 'POST', headers: { ...headers, 'X-PCM-Operation-Id': operation.id }, body: buffer
                });
                registry.recordProgress(operation.id, 'response-received');
                onDiagnostic('response', response.ok ? 'info' : 'error', { httpStatus: response.status });
                failureStage = 'transaction-response';
                validateTransactionResponse(await parseFhirResponse(response), inspected.entries);
                registry.recordProgress(operation.id, 'transaction-accepted');
                onDiagnostic('transaction-accepted', 'info', { httpStatus: response.status, entries: inspected.entries });
                registry.transition(operation.id, 'verifying');
                failureStage = 'read-only-verification';
                registry.recordProgress(operation.id, 'verification-started');
                transport.fetchImpl = readOnlyStageFetch(fetchImpl, deadlines);
                registry.transition(operation.id, 'verifying', { verifiedCounts: await verifyCounts(transport, inspected,
                    (type, count) => registry.recordProgress(operation.id, 'type-verified', { type, count })), result: 'verified' });
            } else registry.transition(operation.id, 'verifying', { verifiedCounts: {}, result: 'verified' });
        }
        verified = true;
        if (deferCompletion) return registry.get(operation.id);
        failureStage = 'publication';
        const completed = publishOperation(registry, operation);
        onDiagnostic('verified', 'info', { result: completed.result });
        // Keep the saved upload until the verified ledger result is durable.
        try {
            await cleanup();
            if (legacyMarker) fs.unlinkSync(legacyMarker);
        } catch (error) {
            return registry.write({ ...completed,
                diagnostics: [...(completed.diagnostics || []), `Verified cleanup failed: ${sanitizeLogMessage(error.message)}`] });
        }
        return completed;
    } catch (error) {
        error.clinicalFailureStage ||= failureStage;
        onDiagnostic(error.clinicalDeadlineMs ? 'timeout' : 'failure', 'error', {
            failureStage: error.clinicalFailureStage, deadlineMs: error.clinicalDeadlineMs || null,
            error: sanitizeLogMessage(error.message)
        });
        // Preserve child diagnostics in the shared ledger until the CLI parent stops its containers and finalizes failure.
        if (deferCompletion) registry.transition(operation.id, registry.get(operation.id).phase, {
            failureStage: error.clinicalFailureStage,
            failureDeadlineMs: error.clinicalDeadlineMs || null
        });
        if (!deferCompletion && verified) registry.transition(operation.id, 'verifying', { needsReconciliation: true });
        if (!deferCompletion) failOperation(registry, operation, error, failureStage);
        throw error;
    }
}

module.exports = { executeOperation, failOperation, parseFhirResponse, publishOperation, preflightTarget, verifyCounts };
