'use strict';
/** Small per-provider loaded-page cache; Consent history remains owned by the existing dashboard. */
const { randomUUID } = require('node:crypto');
const { LIMITS } = require('./service-directory');
class ServiceListState {
    /** Inject ordinary page loading and the existing selection/result invalidation callback. */
    constructor(load, invalidate, revision = () => '', stamp = () => '') {
        this.load = load; this.invalidate = invalidate; this.revision = revision; this.stamp = stamp; this.values = new Map(); this.pending = new Map();
    }
    /** Return loaded choices, never interpreting a partial page as a complete inventory. */
    get(identity) {
        const value = this.values.get(identity);
        if (value && value.stamp !== this.stamp(identity)) {
            this.pending.get(identity)?.abort(); this.values.delete(identity); this.invalidate(identity);
            return undefined;
        }
        return value;
    }
    /** Compare an exact current service with prior visible state; identity/version changes fence old work. */
    observe(identity, service, previous) {
        previous ||= this.get(identity)?.services.find(item => item.id === service.id);
        if (previous && (previous.signature !== service.signature || previous.available !== service.available)) this.invalidate(identity, service.id);
        const current = this.get(identity);
        if (current?.services.some(item => item.id === service.id)) current.services = current.services.map(item => item.id === service.id ? service : item);
        return service;
    }
    /** Load or refresh one page with cancellation, opaque local continuation and stale-response protection. */
    async update(identity, { continuation, signal } = {}) {
        const previous = this.get(identity);
        if (continuation && (!previous?.continuation || continuation !== previous.continuation)) throw new Error('Service continuation does not match this provider or current list. Refresh to retry.');
        this.pending.get(identity)?.abort();
        const controller = new AbortController(), cancel = () => controller.abort();
        this.pending.set(identity, controller); signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        if (!continuation) for (const item of previous?.services || []) this.invalidate(identity, item.id);
        const revision = this.revision(identity), stamp = this.stamp(identity);
        try {
            const result = await this.load(identity, { signal: controller.signal, page: continuation ? previous.next : '',
                seen: continuation ? previous.seen : [], pages: continuation ? previous.pages : 0,
                used: continuation ? { ...previous.used } : { requests: 0, bytes: 0 } });
            if (controller.signal.aborted || this.pending.get(identity) !== controller || this.revision(identity) !== revision || stamp !== this.stamp(identity)) throw new Error('Service load superseded by a newer selection or refresh');
            for (const item of result.services) this.observe(identity, item);
            const services = continuation ? [...new Map([...previous.services, ...result.services].map(item => [item.id, item])).values()] : result.services;
            const next = result.next && result.pages < LIMITS.pages ? result.next : '';
            const warnings = [...new Set([...(continuation ? previous.warnings : []), ...result.warnings])];
            const value = { ...result, stamp, complete: result.complete && !warnings.length, warnings, services, next, continuation: next ? randomUUID() : '', seen: [...(continuation ? previous.seen : []), ...(next ? [next] : [])],
                refreshedAt: new Date().toISOString(), error: '', stale: false };
            this.values.set(identity, value);
            return value;
        } catch (error) {
            if (this.pending.get(identity) === controller && !controller.signal.aborted && this.revision(identity) === revision && stamp === this.stamp(identity)) {
                // Failed refresh is uncertainty, never deletion. A failed later page preserves earlier choices; exact pre-submit reads still apply.
                if (!continuation) for (const item of previous?.services || []) if (item.available) this.invalidate(identity, item.id);
                this.values.set(identity, { stamp, ...(previous || { services: [], pages: 0, warnings: [], used: { requests: 0, bytes: 0 } }),
                    services: continuation ? previous.services : (previous?.services || []).map(item => ({ ...item, available: false, readiness: 'Refresh failed; current readiness unknown' })),
                    next: '', continuation: '', complete: false, stale: !continuation, error: error.message });
            }
            throw error;
        } finally { signal?.removeEventListener('abort', cancel); if (this.pending.get(identity) === controller) this.pending.delete(identity); }
    }
    /** Abort owned loads and fence responses on the existing Doctor reset. */
    clear() { for (const controller of this.pending.values()) controller.abort(); this.pending.clear(); this.values.clear(); }
}
module.exports = { ServiceListState };
