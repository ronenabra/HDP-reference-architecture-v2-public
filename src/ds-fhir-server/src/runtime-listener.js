'use strict';

/**
 * Coordinate validated listener candidates without committing a failed revision.
 * @param {object} options Selected-file reader, server factory, port, logger and activation hook.
 * @returns {object} Explicit start/check/stop operations and the last successfully bound snapshot.
 */
function createRuntimeListener({ readSnapshot, createServer, port, logger, configPath, onActive = () => {} }) {
    let server = null;
    let active = null;
    let pending = null;
    let stopping = false;

    /** Bind a prepared Node server; return a promise that rejects any bind failure. */
    function listen(candidate) {
        return new Promise((resolve, reject) => {
            const failed = error => {
                candidate.removeListener('listening', ready);
                reject(error);
            };
            const ready = () => {
                candidate.removeListener('error', failed);
                resolve();
            };
            candidate.once('error', failed);
            candidate.once('listening', ready);
            try { candidate.listen(port); } catch (error) {
                candidate.removeListener('error', failed);
                candidate.removeListener('listening', ready);
                reject(error);
            }
        });
    }

    /** Drain the owned listener before rebinding its port. */
    function close(candidate) {
        if (!candidate?.listening) return Promise.resolve();
        return new Promise((resolve, reject) => candidate.close(error => error ? reject(error) : resolve()));
    }

    /** Include the selected file and actual active/candidate revisions in diagnostics. */
    function details(snapshot, stage) {
        return { service: 'ds-fhir-server', configPath, pid: process.pid, stage,
            activeRevision: active?.revision ?? null, attemptedRevision: snapshot?.revision ?? null };
    }

    /** Report listener failure separately from selected-file validation rejection. */
    function listenerFailed(error, snapshot, stage = 'listener') {
        logger.error(`DS FHIR server reload failed: ${error.message}`, {
            type: 'PROCESS_RELOAD_FAILED', category: 'lifecycle', visibility: 'default',
            causesSystemFlow: false, ...details(snapshot, stage), error: error.message
        });
    }

    /** Publish a revision only after the matching listener has bound successfully. */
    function activate(candidate, snapshot, previousRevision) {
        server = candidate;
        active = snapshot;
        candidate.on('error', error => logger.error(`DS FHIR server error: ${error.message}`, {
            type: 'PROCESS_LISTENER_ERROR', category: 'lifecycle', visibility: 'default',
            causesSystemFlow: false, ...details(snapshot, 'listener'), error: error.message
        }));
        onActive(snapshot);
        logger.info(previousRevision === null ? 'DS FHIR listener ready' : 'DS FHIR config reload complete', {
            type: previousRevision === null ? 'PROCESS_LISTENING' : 'PROCESS_RELOAD_COMPLETE',
            category: 'lifecycle', visibility: 'diagnostic', causesSystemFlow: false,
            ...details(snapshot, 'active'), previousRevision
        });
    }

    /** Start the supplied/read snapshot; return a promise rejecting any startup failure. */
    async function start(snapshot = readSnapshot()) {
        const candidate = createServer(snapshot);
        await listen(candidate);
        activate(candidate, snapshot, null);
    }

    /** Try one revision and restore the old listener if the new bind fails. */
    async function reload() {
        let snapshot;
        try { snapshot = readSnapshot(); } catch (error) {
            // Keep every rejected snapshot for diagnostics without obscuring request evidence.
            logger.error('DS FHIR config reload rejected', {
                type: 'PROCESS_RELOAD_FAILED', category: 'lifecycle', visibility: 'diagnostic',
                causesSystemFlow: false, ...details(null, 'config'), error: error.message
            });
            return;
        }
        if (snapshot.revision === active?.revision && server?.listening) return;
        let candidate;
        try {
            // Read/parse TLS material before draining a working listener.
            candidate = createServer(snapshot);
        } catch (error) {
            listenerFailed(error, snapshot, 'prepare-listener');
            return;
        }
        const previous = server;
        logger.info(`Reloading DS FHIR server (config revision ${snapshot.revision})`, {
            type: 'PROCESS_RELOAD', category: 'lifecycle', visibility: 'diagnostic',
            causesSystemFlow: false, ...details(snapshot, 'listener')
        });
        try {
            await close(previous);
            if (stopping) return;
            await listen(candidate);
            activate(candidate, snapshot, active?.revision ?? null);
        } catch (error) {
            listenerFailed(error, snapshot);
            await close(candidate);
            // Reuse the old server's already validated TLS material; never reread a bad file.
            if (!stopping && previous && !previous.listening) {
                try {
                    await listen(previous);
                    logger.info('DS FHIR prior listener restored', {
                        type: 'PROCESS_RELOAD_ROLLBACK', category: 'lifecycle', visibility: 'diagnostic',
                        causesSystemFlow: false, ...details(snapshot, 'rollback')
                    });
                } catch (restoreError) { listenerFailed(restoreError, snapshot, 'rollback'); }
            }
        }
    }

    /** Serialize watcher work, including listener drain and asynchronous bind errors. */
    function check() {
        if (stopping) return Promise.resolve();
        if (!pending) pending = reload().finally(() => { pending = null; });
        return pending;
    }

    /** Finish any in-flight transition before draining the final owned listener. */
    async function stop() {
        stopping = true;
        await pending;
        await close(server);
    }

    return { start, check, stop, getActive: () => active };
}

module.exports = { createRuntimeListener };
