'use strict';
/** Container entry point for the shared, parent-owned clinical workflow. */
const fs = require('fs');
const path = require('path');
const { guardedFetch } = require(fs.existsSync('/shared/outbound-destination.js')
    ? '/shared/outbound-destination' : '../src/shared/outbound-destination');
const { executeOperation } = require('./workflow');
const { operationOwner } = require('./operation-owner');
const { DEFAULT_LIMITS } = require('./transaction-bundle');

/** Execute a transaction with the parent's reservation; publication follows container cleanup. */
async function runTransactionBundleImport({ bundlePath, expectedHo, endpoint, credential, stateDir, limits,
    policy = 'manual', expectedSha256, fileName = path.basename(bundlePath), fetchImpl = guardedFetch, owner }) {
    if (typeof credential !== 'string' || credential.length < 32) throw new TypeError('import credential must contain at least 32 characters');
    if (!['manual', 'if-empty', 'replace'].includes(policy)) throw new TypeError('transaction import policy is invalid');
    if (!owner) throw new Error('transaction loader requires the managed lifecycle operation owner');
    if (expectedSha256 && owner.operation.sha256 !== expectedSha256) throw new Error('queued upload checksum changed');
    const result = await executeOperation({ ...owner, buffer: fs.readFileSync(bundlePath), limits, policy,
        endpoint, headers: { Accept: 'application/fhir+json', 'Content-Type': 'application/fhir+json', 'X-PCM-Import-Credential': credential },
        fetchImpl, legacyStateDir: stateDir, bundleName: fileName, deferCompletion: true,
        // The host completed the database reset under this same reservation.
        reset: policy === 'replace' ? async () => {
            if (!owner.registry.get(owner.operation.id).resetVerifiedAt) throw new Error('parent database reset was not verified');
        } : undefined });
    return result;
}

async function main() {
    const expectedHo = process.env.HO_ID;
    if (!expectedHo || !process.env.PCM_TRANSACTION_BUNDLE || !process.env.PCM_DATA_OPERATION_ID) throw new Error('HO_ID, PCM_TRANSACTION_BUNDLE and managed lifecycle owner are required');
    const owner = operationOwner({ stateDir: process.env.STATE_DIR || '/runtime/state', serverId: expectedHo, kind: 'import' });
    const result = await runTransactionBundleImport({ owner, expectedHo,
        bundlePath: process.env.PCM_TRANSACTION_BUNDLE, expectedSha256: owner.operation.sha256,
        endpoint: process.env.HO_IMPORT_ENDPOINT || `https://${expectedHo}-hapi:8080/fhir`,
        credential: process.env.PCM_IMPORT_CREDENTIAL,
        stateDir: process.env.PCM_IMPORT_STATE_DIR || '/runtime/import-state',
        limits: { maxBytes: Number(process.env.PCM_IMPORT_MAX_BYTES || DEFAULT_LIMITS.maxBytes), maxEntries: Number(process.env.PCM_IMPORT_MAX_ENTRIES || DEFAULT_LIMITS.maxEntries) },
        policy: process.env.PCM_IMPORT_POLICY || 'manual',
        fileName: process.env.PCM_TRANSACTION_BUNDLE_NAME || path.basename(process.env.PCM_TRANSACTION_BUNDLE)
    });
    console.log(JSON.stringify({ phase: result.phase, operationId: owner.operation.id, serverId: result.serverId, result: result.result, sha256: result.sha256, skipReason: result.skipReason }));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { runTransactionBundleImport };
