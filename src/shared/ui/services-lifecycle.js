'use strict';
/** Sequence ordinary Disconnect calls without claiming an atomic operation or retrying a step. */
(function expose(root) {
    /** Pause active registration, inspect its new exact version, then end it.
     * @param {object} options Exact registration plus authenticated transition/inspect callbacks.
     * @returns {Promise<object>} Checked terminal result with independently confirmed steps.
     */
    async function disconnect({ registration, transition, inspect }) {
        const original = registration;
        let paused = false, stage = 'Pause';
        const checked = (result, state) => {
            if (result?.id !== original.id || result.state !== state) throw new Error('Unexpected lifecycle result.');
            return result;
        };
        try {
            if (!['active', 'suspended'].includes(registration.state)) throw new Error('This stored state cannot be disconnected.');
            if (registration.state === 'active') {
                checked(await transition(registration, 'suspended'), 'suspended');
                paused = true; stage = 'Inspect after Pause';
                const current = await inspect(registration);
                if (current?.id !== original.id || current.providerId !== original.providerId || current.role !== original.role
                    || current.state !== 'suspended' || !current.version || current.version === original.version || !current.csrf) throw new Error('The exact paused registration could not be confirmed.');
                registration = current;
            }
            stage = 'End';
            const result = checked(await transition(registration, 'cancelled'), 'cancelled');
            return { ...result, steps: { pause: paused ? 'confirmed' : 'already-paused', end: 'confirmed' },
                message: `Disconnected — ${paused ? 'Pause and End independently confirmed' : 'End confirmed for the paused registration'}. These calls are not atomic. Reconnect creates a new pending registration; old approvals stay terminal.` };
        } catch (cause) {
            throw Object.assign(new Error(`${paused ? 'Partial Disconnect: Pause confirmed; End is not confirmed. The registration may remain paused.' : `${stage} is not confirmed; Disconnect is incomplete.`} ${cause.message} The calls are not atomic. Refresh and inspect before another action.`), { cause, paused, stage });
        }
    }
    if (typeof module === 'object' && module.exports) module.exports = { disconnect };
    else root.PcmServiceLifecycle = { disconnect };
})(typeof globalThis === 'object' ? globalThis : this);
