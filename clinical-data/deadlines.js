'use strict';
/** Bounded, separately configurable private HAPI operation deadlines. */
const fs = require('fs');
const { guardedFetch } = require(fs.existsSync('/shared/outbound-destination.js')
    ? '/shared/outbound-destination' : '../src/shared/outbound-destination');

const DEFAULT_DEADLINES = Object.freeze({
    connectUploadMs: 120_000,
    transactionWaitMs: 3_600_000,
    verificationMs: 300_000
});

/** Parse positive finite deadlines once, so the ledger records the effective values. */
function clinicalDeadlines(env = process.env) {
    const names = {
        connectUploadMs: 'CLINICAL_DATA_CONNECT_UPLOAD_TIMEOUT_MS',
        transactionWaitMs: 'CLINICAL_DATA_TRANSACTION_WAIT_TIMEOUT_MS',
        verificationMs: 'CLINICAL_DATA_VERIFICATION_TIMEOUT_MS'
    };
    return Object.fromEntries(Object.entries(names).map(([key, name]) => {
        const value = env[name] === undefined ? DEFAULT_DEADLINES[key] : Number(env[name]);
        if (!Number.isSafeInteger(value) || value < 1000 || value > 3_600_000) {
            throw new TypeError(`${name} must be an integer from 1000 to 3600000 milliseconds`);
        }
        return [key, value];
    }));
}

/** Give read-only requests and the submitted transaction independent budgets. */
function deadlineFetch(fetchImpl = guardedFetch, deadlines = clinicalDeadlines()) {
    return async (url, init = {}) => {
        const stage = init.method === 'POST' ? 'hapi-transaction-wait' : 'read-only-verification';
        const milliseconds = stage === 'hapi-transaction-wait' ? deadlines.connectUploadMs + deadlines.transactionWaitMs : deadlines.verificationMs;
        try {
            if (stage === 'hapi-transaction-wait' && fetchImpl === guardedFetch) {
                return await guardedFetch(url, init, { stageTimeouts: deadlines });
            }
            return await fetchImpl(url, { ...init, signal: init.signal || AbortSignal.timeout(milliseconds) });
        } catch (error) {
            error.clinicalFailureStage ||= stage;
            error.clinicalDeadlineMs ||= milliseconds;
            throw error;
        }
    };
}

/** Bound a complete multi-request read-only phase, including pagination. */
function readOnlyStageFetch(fetchImpl = guardedFetch, deadlines = clinicalDeadlines()) {
    const signal = AbortSignal.timeout(deadlines.verificationMs);
    const bounded = deadlineFetch(fetchImpl, deadlines);
    return (url, init = {}) => bounded(url, { ...init, signal: init.signal || signal });
}

module.exports = { DEFAULT_DEADLINES, clinicalDeadlines, deadlineFetch, readOnlyStageFetch };
