'use strict';

/** Shared, presentation-only Admin wording for initial pages and polled results. */
(function expose(root) {
    /** Describe recorded outcomes without treating a lost connection as failed work. */
    function operationSummary(operation) {
        if (operation.resetVerifiedAt && operation.submittedOutcome === 'resolved-by-target-reset' && !operation.needsReconciliation) return 'All data and saved versions were deleted. You can import another file.';
        if (operation.needsReconciliation) return operation.kind === 'reset'
            ? "We couldn't confirm whether deletion finished. Ask the local operator to check before clearing this server again."
            : "We couldn't confirm whether the import finished. Check this import before trying again.";
        if (operation.phase === 'succeeded') {
            if (operation.result === 'skipped') return 'Startup import skipped. Existing data or history was preserved; no file was imported.';
            if (operation.kind === 'reset') return 'All data and saved versions were deleted.';
            if (operation.reconciliationVerifiedAt) return 'The saved import was checked and is complete. No file was imported again.';
            return 'Import complete. Source and dataset counts were checked; the private Admin inventory was recorded.';
        }
        if (operation.phase === 'failed') return operation.kind === 'reset'
            ? "Deletion did not finish. Check the technical details before trying again; some data may remain."
            : 'The import did not finish. Review the technical details before trying again.';
        const stages = {
            'upload-received': 'File received. Waiting to check it.',
            'reset-request-received': 'Deletion requested. Waiting to start.',
            'bundle-check-started': 'Checking the file before importing.',
            'bundle-check-complete': 'File checked. Preparing to import.',
            'target-preflight-started': 'Checking whether this server can accept the file.',
            'target-preflight-complete': 'Server checked. Preparing to import.',
            'reset-started': 'Deleting all data and saved versions from this server.',
            'reset-complete': 'Deletion checked. Finishing the request.',
            'transaction-waiting': 'Import in progress. Waiting for the server to respond.',
            'response-received': 'Server response received. Checking the result.',
            'transaction-accepted': 'The server accepted the file. Checking the saved data.',
            'verification-started': 'Checking saved source and dataset counts.',
            'inventory-publication-started': 'Data checked. Recording the private Admin inventory.'
        };
        return Object.hasOwn(stages, operation.currentStage) ? stages[operation.currentStage]
            : 'Work is still in progress. Wait for a confirmed result before trying again.';
    }

    /** Give a next step for a refused request while retaining the original error in details. */
    function requestFailure(error, busy = false) {
        if (/bundle filename must end in \.source\.transaction\.json/i.test(error)) return 'File rejected before import. Select a transaction bundle whose filename ends in .source.transaction.json, then try again.';
        if (busy) return 'Another import or deletion needs attention on this server. Review its latest result and recovery controls below before trying again.';
        if (/still running|stopped workers|stopped.*transaction/i.test(error)) return 'The earlier import must stop before you can check it or clear this server. Ask the local operator to confirm both the import process and database transaction have stopped.';
        if (/confirmation.*missing or stale/i.test(error)) return 'Deletion was not started. Reload Admin and check the deletion acknowledgement for this server again.';
        if (/configuration changed/i.test(error)) return 'This server’s settings changed. Ask the local operator to review the saved import and server settings before recovery.';
        return 'The request could not be completed. Review the technical details and this server’s latest result before trying again. A missing response does not prove that no data was saved.';
    }

    const feedback = { operationSummary, requestFailure };
    if (typeof module !== 'undefined' && module.exports) module.exports = feedback;
    else root.PCM_ADMIN_FEEDBACK = feedback;
})(globalThis);
