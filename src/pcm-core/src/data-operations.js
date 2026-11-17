'use strict';

/** Persistent, target-bound Sprint 29 Admin data-operation registry. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class DataOperationRegistry {
    constructor(options = {}) {
        this.directory = options.directory || path.join(process.env.STATE_DIR || '/runtime/state', 'data-operations');
        this.clock = options.clock || (() => new Date().toISOString());
        this.owners = new Map();
    }

    file(id) { return path.join(this.directory, `${id}.json`); }

    create(serverId, kind, details = {}) {
        require('../../shared/migration-maintenance').assertAvailable(path.dirname(this.directory));
        if (!/^[a-z0-9][a-z0-9-]+$/.test(serverId || '') || !['import', 'reset', 'replace', 'bootstrap'].includes(kind)) throw new TypeError('invalid data operation target or kind');
        fs.mkdirSync(this.directory, { recursive: true });
        if (fs.existsSync(this.reconciliationFile(serverId)) || fs.existsSync(path.join(this.directory, `mutation-${serverId}`))) throw this.busy(serverId);
        const now = this.clock();
        const initialStage = kind === 'reset' ? 'reset-request-received' : 'upload-received';
        const operation = { ...details, schemaVersion: 2, id: crypto.randomUUID(), serverId, kind, phase: 'queued', status: 'accepted', createdAt: now, updatedAt: now, diagnostics: details.diagnostics || [],
            currentStage: initialStage, stageStartedAt: now, stageTimestamps: { [initialStage]: now },
            progressEvents: [{ event: initialStage, at: now }], lastCompletedStage: initialStage, verifiedTypes: [] };
        const token = crypto.randomUUID();
        try {
            fs.writeFileSync(this.lockFile(serverId), JSON.stringify({ operationId: operation.id, token }), { flag: 'wx', mode: 0o600 });
            try { require('../../shared/migration-maintenance').assertAvailable(path.dirname(this.directory)); }
            catch (error) { fs.unlinkSync(this.lockFile(serverId)); throw error; }
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            throw this.busy(serverId);
        }
        // Old unfinished records are not evidence of a safely stopped worker.
        const previous = this.list(serverId);
        operation.sequence = Math.max(0, ...previous.map(item => item.sequence || 0)) + 1;
        const legacy = previous.find(item => !['succeeded', 'failed'].includes(item.phase) || item.needsReconciliation);
        if (legacy) {
            fs.unlinkSync(this.lockFile(serverId));
            throw Object.assign(new Error(`target ${serverId} is busy; operation ${legacy.id} requires reconciliation`), { statusCode: 409, activeOperationId: legacy.id });
        }
        this.owners.set(operation.id, token);
        try { this.write(operation); }
        catch (error) { this.assertOwner(operation); fs.unlinkSync(this.lockFile(serverId)); this.owners.delete(operation.id); throw error; }
        return operation;
    }

    write(operation) {
        const target = this.file(operation.id);
        const temporary = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify(operation, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, target);
        return operation;
    }

    get(id) {
        if (!/^[0-9a-f-]{36}$/i.test(id || '')) return null;
        try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }

    /** Return an observation derived from server time without rewriting the ledger. */
    status(id) {
        const operation = this.get(id);
        if (!operation) return null;
        const observedAt = this.clock();
        const end = operation.completedAt || observedAt;
        const elapsed = start => start ? Math.max(0, Date.parse(end) - Date.parse(start)) : null;
        const waitEnd = operation.stageTimestamps?.['response-received'] || operation.completedAt || observedAt;
        return { ...operation, observedAt, elapsedMilliseconds: elapsed(operation.createdAt),
            stageElapsedMilliseconds: elapsed(operation.stageStartedAt),
            waitMilliseconds: operation.stageTimestamps?.['transaction-waiting']
                ? Math.max(0, Date.parse(waitEnd) - Date.parse(operation.stageTimestamps['transaction-waiting'])) : null };
    }

    /** Persist one bounded, non-clinical event under the target owner's lock. */
    recordProgress(id, event, options = {}) {
        const allowed = new Set(['bundle-check-started', 'bundle-check-complete', 'target-preflight-started',
            'target-preflight-complete', 'reset-started', 'reset-complete', 'transaction-waiting',
            'response-received', 'transaction-accepted', 'verification-started', 'type-verified', 'inventory-publication-started']);
        if (!allowed.has(event)) throw new TypeError('invalid data operation progress event');
        const current = this.get(id);
        if (!current) throw new TypeError('unknown data operation');
        const at = this.clock();
        const detail = event === 'type-verified' ? { type: options.type, count: options.count } : {};
        if (event === 'type-verified' && (!/^[A-Za-z]+$/.test(detail.type || '') || !Number.isSafeInteger(detail.count) || detail.count < 0)) {
            throw new TypeError('invalid verified type progress');
        }
        const activeStage = event === 'type-verified' ? 'verification-started' : event;
        const complete = ['bundle-check-complete', 'target-preflight-complete', 'reset-complete', 'response-received', 'transaction-accepted', 'type-verified'].includes(event);
        const deadlineAt = event === 'transaction-waiting' && Number.isSafeInteger(options.deadlineMs)
            ? new Date(Date.parse(at) + options.deadlineMs).toISOString() : current.transactionDeadlineAt;
        return this.transition(id, current.phase, {
            currentStage: activeStage,
            stageStartedAt: activeStage === current.currentStage ? current.stageStartedAt : at,
            stageTimestamps: { ...(current.stageTimestamps || {}), ...(!current.stageTimestamps?.[event] ? { [event]: at } : {}) },
            progressEvents: [...(current.progressEvents || []), { event, at, ...detail }],
            lastCompletedStage: complete ? event : current.lastCompletedStage,
            verifiedTypes: event === 'type-verified' ? [...(current.verifiedTypes || []), detail] : (current.verifiedTypes || []),
            ...(deadlineAt ? { transactionDeadlineAt: deadlineAt } : {})
        });
    }

    list(serverId) {
        let names;
        try { names = fs.readdirSync(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
        return names.filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8')))
            .filter(operation => !serverId || operation.serverId === serverId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (b.sequence || 0) - (a.sequence || 0));
    }

    /** One team state mount contains an exclusive lock for each managed target. */
    lockFile(serverId) { return path.join(this.directory, `lock-${serverId}`); }

    busy(serverId) {
        let lock;
        try { lock = JSON.parse(fs.readFileSync(this.lockFile(serverId), 'utf8')); } catch (_) { /* An initializing lock is still busy. */ }
        return Object.assign(new Error(`target ${serverId} is busy; reconcile operation ${lock?.operationId || 'pending'} before retry`), {
            statusCode: 409, activeOperationId: lock?.operationId || null
        });
    }

    /** Child helpers inherit the private owner token, never a new reservation. */
    adopt(id, token) {
        const operation = this.get(id);
        if (!operation || !token) throw new Error('operation owner is required');
        this.owners.set(id, token);
        this.assertOwner(operation);
        return operation;
    }

    ownerToken(id) { return this.owners.get(id); }

    assertOwner(operation) {
        if (fs.existsSync(this.reconciliationFile(operation.serverId))) throw new Error('data operation is fenced for reconciliation');
        let lock;
        try { lock = JSON.parse(fs.readFileSync(this.lockFile(operation.serverId), 'utf8')); } catch (_) { /* Fail closed. */ }
        if (!lock || lock.operationId !== operation.id || lock.token !== this.owners.get(operation.id)) throw new Error('data operation owner mismatch');
    }

    reconciliationFile(serverId) { return path.join(this.directory, `reconciling-${serverId}`); }

    /** Serialize final ledger writes with recovery fencing across local processes. */
    withTargetMutation(serverId, action) {
        const mutex = path.join(this.directory, `mutation-${serverId}`);
        try { fs.mkdirSync(mutex); } catch (error) {
            if (error.code === 'EEXIST') throw new Error('target operation state is being changed concurrently');
            throw error;
        }
        try { return action(); } finally { fs.rmdirSync(mutex); }
    }

    /**
     * Fence a saved owner before read-only proof or an explicitly scoped reset.
     * A killed worker cannot record its catch/failure transition. Only explicit
     * stopped-worker confirmation admits that unfinished submitted state; merely
     * reading it never changes ownership or treats the mutation as successful.
     */
    beginReconciliation(id, { workersStopped = false, targetIdentity } = {}) {
        const eligible = operation => operation?.needsReconciliation
            || (workersStopped === true && operation?.mutationSubmitted === true
                && ['loading', 'verifying', 'resetting'].includes(operation.phase));
        const existing = this.get(id);
        if (!eligible(existing)) throw new Error('operation does not require reconciliation');
        return this.withTargetMutation(existing.serverId, () => {
            const operation = this.get(id);
            if (!eligible(operation)) throw new Error('operation does not require reconciliation');
            if (targetIdentity !== undefined && operation.targetIdentity !== targetIdentity) throw new Error('managed target configuration changed');
            const lock = JSON.parse(fs.readFileSync(this.lockFile(operation.serverId), 'utf8'));
            if (lock.operationId !== id) throw new Error('another operation owns this target');
            const file = this.reconciliationFile(operation.serverId);
            fs.writeFileSync(file, JSON.stringify({ operationId: id, token: crypto.randomUUID() }), { flag: 'wx', mode: 0o600 });
            try {
                if (!operation.needsReconciliation) {
                    const at = this.clock();
                    this.write({ ...operation, phase: 'failed', status: 'reconciliation-required',
                        needsReconciliation: true, inventoryInvalidated: true, submittedOutcome: 'unknown',
                        failureStage: 'worker-stopped', stoppedWorkerConfirmedAt: at, updatedAt: at, completedAt: at,
                        elapsedMilliseconds: Math.max(0, Date.parse(at) - Date.parse(operation.createdAt)),
                        currentStage: 'reconciliation-required', stageStartedAt: at,
                        stageTimestamps: { ...(operation.stageTimestamps || {}), 'reconciliation-required': at },
                        progressEvents: [...(operation.progressEvents || []), { event: 'reconciliation-required', at }],
                        diagnostics: [...(operation.diagnostics || []), 'Operator confirmed stopped workers; interrupted submission remains unknown until read-only proof or explicit target-scoped reset.'] });
                }
            } catch (error) { fs.unlinkSync(file); throw error; }
            return () => fs.unlinkSync(file);
        });
    }

    /** Publish one verified result while the original target lock remains fenced. */
    completeReconciliation(id, evidence) {
        const existing = this.get(id);
        return this.withTargetMutation(existing.serverId, () => {
            const operation = this.get(id);
            const barrier = JSON.parse(fs.readFileSync(this.reconciliationFile(operation.serverId), 'utf8'));
            const lock = JSON.parse(fs.readFileSync(this.lockFile(operation.serverId), 'utf8'));
            if (barrier.operationId !== id || lock.operationId !== id || !operation.needsReconciliation) throw new Error('reconciliation owner changed');
            const updatedAt = this.clock();
            const prepared = this.write({ ...operation, ...evidence, phase: 'verifying', status: 'reconciliation-required',
                needsReconciliation: true, inventoryInvalidated: true, updatedAt,
                elapsedMilliseconds: Math.max(0, Date.parse(updatedAt) - Date.parse(operation.createdAt)),
                diagnostics: [...(operation.diagnostics || []), 'Read-only reconciliation proved the saved transaction; no POST was replayed.'] });
            fs.unlinkSync(this.lockFile(operation.serverId));
            const result = this.write({ ...prepared, phase: 'succeeded', status: 'completed', result: 'verified',
                needsReconciliation: false, inventoryInvalidated: false, completedAt: updatedAt,
                currentStage: 'completed', stageStartedAt: updatedAt, lastCompletedStage: 'completed',
                stageTimestamps: { ...(prepared.stageTimestamps || {}), completed: updatedAt },
                progressEvents: [...(prepared.progressEvents || []), { event: 'completed', at: updatedAt }] });
            this.owners.delete(id);
            return result;
        });
    }

    /** Release only after an explicitly scoped reset has verified zero data and history. */
    completeResetReconciliation(id, zeroCounts) {
        const existing = this.get(id);
        return this.withTargetMutation(existing.serverId, () => {
            const operation = this.get(id);
            const barrier = JSON.parse(fs.readFileSync(this.reconciliationFile(operation.serverId), 'utf8'));
            const lock = JSON.parse(fs.readFileSync(this.lockFile(operation.serverId), 'utf8'));
            if (barrier.operationId !== id || lock.operationId !== id || !operation.needsReconciliation) throw new Error('reconciliation owner changed');
            const updatedAt = this.clock();
            const prepared = this.write({ ...operation, phase: 'failed', status: 'reconciliation-required', result: 'not-completed',
                needsReconciliation: true, inventoryInvalidated: true, submittedOutcome: 'resolved-by-target-reset',
                zeroCounts, resetVerifiedAt: updatedAt, updatedAt,
                diagnostics: [...(operation.diagnostics || []), 'Explicit target-scoped reset verified zero resources and history; saved POST was not replayed.'] });
            fs.unlinkSync(this.lockFile(operation.serverId));
            const result = this.write({ ...prepared, status: 'failed', needsReconciliation: false, completedAt: updatedAt,
                currentStage: 'failed', stageStartedAt: updatedAt, lastCompletedStage: 'reset-complete',
                stageTimestamps: { ...(prepared.stageTimestamps || {}), 'reset-complete': updatedAt, failed: updatedAt },
                progressEvents: [...(prepared.progressEvents || []), { event: 'reset-complete', at: updatedAt }, { event: 'failed', at: updatedAt }] });
            this.owners.delete(id);
            return result;
        });
    }

    /** Retain ownership and the incident reason after failed read-only proof. */
    noteReconciliationFailure(id, error) {
        const existing = this.get(id);
        return this.withTargetMutation(existing.serverId, () => {
            const operation = this.get(id);
            const barrier = JSON.parse(fs.readFileSync(this.reconciliationFile(operation.serverId), 'utf8'));
            if (barrier.operationId !== id) throw new Error('reconciliation owner changed');
            this.write({ ...operation, status: 'reconciliation-required', needsReconciliation: true,
                reconciliationFailure: String(error.message), updatedAt: this.clock(),
                diagnostics: [...(operation.diagnostics || []), `Read-only reconciliation could not prove completion: ${error.message}. Target remains blocked; use target-scoped reset/replacement after review.`] });
        });
    }

    /** Explicit recovery requires operator-confirmed termination and reconciled HAPI state. */
    recover(id, { workersStopped = false, reconciled = false } = {}) {
        if (!workersStopped || !reconciled) throw new Error('recovery requires stopped workers and reconciled HAPI state');
        const existing = this.get(id);
        if (!existing) throw new Error('unknown data operation');
        return this.withTargetMutation(existing.serverId, () => {
            const operation = this.get(id);
            if (operation.mutationSubmitted || operation.needsReconciliation) throw new Error('submitted or uncertain mutation requires read-only reconciliation; target remains blocked');
            if (['succeeded', 'failed'].includes(operation.phase) && !operation.needsReconciliation) throw new Error('operation does not require recovery');
            let lock;
            try { lock = JSON.parse(fs.readFileSync(this.lockFile(operation.serverId), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (lock && lock.operationId !== id) throw new Error('another operation owns this target');
            const updatedAt = this.clock();
            const recovered = this.write({ ...operation, schemaVersion: 2, phase: 'failed', status: 'failed', needsReconciliation: false,
                inventoryInvalidated: true, updatedAt, completedAt: updatedAt,
                elapsedMilliseconds: Math.max(0, Date.parse(updatedAt) - Date.parse(operation.createdAt)),
                diagnostics: [...(operation.diagnostics || []), 'Explicit recovery: workers stopped and HAPI state reconciled; no transaction replayed.'],
                currentStage: 'failed', stageStartedAt: updatedAt,
                stageTimestamps: { ...(operation.stageTimestamps || {}), failed: updatedAt },
                progressEvents: [...(operation.progressEvents || []), { event: 'failed', at: updatedAt }] });
            if (lock) fs.unlinkSync(this.lockFile(operation.serverId));
            return recovered;
        });
    }

    transition(id, phase, patch = {}) {
        const existing = this.get(id);
        if (!existing) throw new TypeError('unknown data operation');
        return this.withTargetMutation(existing.serverId, () => {
            const operation = this.get(id);
            this.assertOwner(operation);
            const phases = ['queued', 'validating', 'resetting', 'loading', 'verifying', 'succeeded', 'failed'];
            if (!phases.includes(phase) || ['succeeded', 'failed'].includes(operation.phase) || (phase !== 'failed' && phases.indexOf(phase) < phases.indexOf(operation.phase))) throw new TypeError('invalid data operation transition');
            const updatedAt = this.clock();
            const terminal = ['succeeded', 'failed'].includes(phase);
            const terminalEvent = terminal ? (phase === 'succeeded' ? 'completed' : (patch.needsReconciliation ? 'reconciliation-required' : 'failed')) : null;
            const result = this.write({
                ...operation,
                ...patch,
                phase,
                status: patch.needsReconciliation ? 'reconciliation-required' : (phase === 'succeeded' ? 'completed' : (phase === 'failed' ? 'failed' : 'running')),
                updatedAt,
                ...(terminalEvent ? {
                    currentStage: terminalEvent, stageStartedAt: updatedAt,
                    stageTimestamps: { ...(operation.stageTimestamps || {}), [terminalEvent]: updatedAt },
                    progressEvents: [...(operation.progressEvents || []), { event: terminalEvent, at: updatedAt }],
                    lastCompletedStage: phase === 'succeeded' ? 'completed' : operation.lastCompletedStage
                } : {}),
                ...(terminal ? {
                    completedAt: updatedAt,
                    elapsedMilliseconds: Math.max(0, Date.parse(updatedAt) - Date.parse(operation.createdAt)),
                    result: phase === 'succeeded' ? (patch.result || 'verified') : 'not-completed'
                } : {})
            });
            if (terminal && !result.needsReconciliation) {
                this.assertOwner(result);
                fs.unlinkSync(this.lockFile(result.serverId));
                this.owners.delete(id);
            }
            return result;
        });
    }
}

/** Return current verified data state after accounting for later resets. */
function latestVerifiedLoad(registry, serverId) {
    for (const operation of registry.list(serverId)) {
        if (operation.inventoryInvalidated || operation.resetVerifiedAt || operation.needsReconciliation) {
            if (operation.phase !== 'succeeded' || operation.kind === 'reset') return null;
        }
        if (operation.phase !== 'succeeded' || operation.result === 'skipped') continue;
        if (operation.kind === 'reset') return null;
        return operation;
    }
    return null;
}

function managedFhirServers(config) {
    return (config.healthOrganizations || []).filter(ho => ho.clinicalData?.managed === true).map(ho => ({
        id: ho.clinicalData.serverId,
        healthOrganizationId: ho.id,
        name: ho.name,
        endpoint: ho.endpoint,
        bootstrap: ho.clinicalData.bootstrap,
        limits: ho.clinicalData.limits,
        management: { upload: true, deleteAll: true, legacyDataSource: false }
    }));
}

function requireManagedFhirServer(config, id) {
    const server = managedFhirServers(config).find(item => item.id === id);
    if (!server) throw new TypeError(`unknown managed HAPI FHIR server ${id}`);
    return server;
}

function confirmationToken(serverId, teamId) {
    return `delete-all:${teamId}:${serverId}`;
}

module.exports = { DataOperationRegistry, confirmationToken, latestVerifiedLoad, managedFhirServers, requireManagedFhirServer };
