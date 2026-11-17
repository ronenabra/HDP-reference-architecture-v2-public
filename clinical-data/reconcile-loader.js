#!/usr/bin/env node
'use strict';
/** Container-side read-only reconciliation for a stopped CLI import. */
const fs = require('fs');
const path = require('path');
const { DataOperationRegistry } = require(fs.existsSync('/pcm-core/data-operations.js')
    ? '/pcm-core/data-operations' : '../src/pcm-core/src/data-operations');
const { reconcileOperation, resetUncertainTarget } = require('./reconciliation');
const { guardedFetch } = require(fs.existsSync('/shared/outbound-destination.js')
    ? '/shared/outbound-destination' : '../src/shared/outbound-destination');

async function main() {
    const id = process.env.PCM_DATA_OPERATION_ID;
    const serverId = process.env.HO_ID;
    const registry = new DataOperationRegistry({ directory: path.join(process.env.STATE_DIR || '/runtime/state', 'data-operations') });
    const operation = registry.get(id);
    if (!operation || operation.serverId !== serverId) throw new Error('unknown managed operation target');
    const uploadPath = path.join(process.env.STATE_DIR || '/runtime/state', 'data-uploads', `${id}.json`);
    const common = { registry, operationId: id, workersStopped: process.env.PCM_WORKERS_STOPPED === 'true',
        targetIdentity: process.env.PCM_TARGET_IDENTITY,
        endpoint: process.env.HO_IMPORT_ENDPOINT,
        headers: { Accept: 'application/fhir+json', 'X-PCM-Import-Credential': process.env.PCM_IMPORT_CREDENTIAL },
        fetchImpl: guardedFetch };
    const result = process.env.PCM_RECOVERY_RESET === 'true'
        ? await resetUncertainTarget({ ...common, confirmation: process.env.PCM_RECOVERY_CONFIRMATION,
            expectedConfirmation: process.env.PCM_EXPECTED_CONFIRMATION })
        : await reconcileOperation({ ...common, uploadPath,
        limits: { maxBytes: Number(process.env.PCM_IMPORT_MAX_BYTES), maxEntries: Number(process.env.PCM_IMPORT_MAX_ENTRIES) },
        cleanup: async () => fs.unlinkSync(uploadPath) });
    console.log(JSON.stringify({ phase: result.phase, operationId: id, serverId, result: result.result,
        contentSha256: result.contentSha256, history: result.history }));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
