'use strict';
/** Local Doctor selection boundary; changing identity context cannot reuse old tokens/results. */
class SelectionState {
    /** Create isolated selection storage with an access-cache invalidation callback. */
    constructor(onChange = () => {}) { this.values = new Map(); this.onChange = onChange; this.revisions = new Map(); this.epoch = 0; }
    /** Store exact business identifier/service context and invalidate only on a change. */
    select(identity, patientId, serviceId) {
        const value = { patientId, serviceId };
        if (JSON.stringify(this.values.get(identity)) !== JSON.stringify(value)) {
            this.values.set(identity, value); this.revisions.set(identity, (this.revisions.get(identity) || 0) + 1); this.onChange(identity);
        }
        return value;
    }
    /** Fence a changed service even when the selected logical ID remains unchanged. */
    invalidate(identity, serviceId) {
        this.revisions.set(identity, (this.revisions.get(identity) || 0) + 1);
        this.onChange(identity, serviceId);
    }
    /** Return the current context for an explicitly named application. */
    get(identity) { return this.values.get(identity); }
    /** Capture a context generation for asynchronous discovery, including reset fencing. */
    revision(identity) { return `${this.epoch}:${this.revisions.get(identity) || 0}`; }
    /** Clear all local selections on the existing Doctor reset action. */
    clear() { this.values.clear(); this.revisions.clear(); this.epoch++; }
}
module.exports = { SelectionState };
