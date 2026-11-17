'use strict';

/** Audience- and HO-bound active-introspection cache with an injected clock. */

const crypto = require('crypto');
const { NORMALIZED_SCHEMA } = require('./introspection-contract');

class ActiveIntrospectionCache {
    constructor({ clock = () => Date.now(), ceilingMs = 30000 } = {}) {
        this.clock = clock;
        this.ceilingMs = ceilingMs;
        this.entries = new Map();
        this.expiryCursor = null;
    }

    /** Reclaim up to 16 entries without revisiting only the requested key. */
    reclaimExpired() {
        this.expiryCursor ||= this.entries.entries();
        const now = this.clock();
        for (let visited = 0; visited < 16; visited++) {
            const next = this.expiryCursor.next();
            if (next.done) { this.expiryCursor = null; break; }
            const [key, entry] = next.value;
            if (entry.expiresAtMs <= now) this.entries.delete(key);
        }
    }

    key(token, binding) {
        return crypto.createHash('sha256')
            .update(`${NORMALIZED_SCHEMA}\u0000${binding.policyStamp || "default"}\u0000${binding.normalizationStamp || "default"}\u0000${binding.hoId}\u0000${binding.expectedAudience}\u0000${token}`)
            .digest('base64url');
    }

    get(token, binding, observer = () => {}) {
        const key = this.key(token, binding);
        const before = this.entries.get(key);
        this.reclaimExpired();
        const entry = this.entries.get(key);
        const report = outcome => {
            try { observer({ cache: 'subject-decision', outcome, reasonCode: `CACHE_${outcome.toUpperCase()}`,
                ...(before ? { ageMs: Math.max(0, this.clock() - before.createdAtMs), remainingMs: Math.max(0, before.expiresAtMs - this.clock()) } : {}),
                hoId: binding.hoId, audience: binding.expectedAudience, policyFingerprint: binding.policyStamp,
                ...(outcome === 'hit' ? { networkCall: false } : {}) }); } catch (_) { /* Observer cannot affect cache decisions. */ }
        };
        if (!entry) { report(before && before.expiresAtMs <= this.clock() ? 'expired' : 'miss'); return null; }
        if (entry.expiresAtMs <= this.clock()
            || entry.context.schema !== NORMALIZED_SCHEMA
            || entry.context.hoId !== binding.hoId
            || entry.context.token.audience !== binding.expectedAudience) {
            this.entries.delete(key);
            report(entry.expiresAtMs <= this.clock() ? 'expired' : 'invalidated');
            return null;
        }
        report('hit');
        return entry.context;
    }

    put(token, binding, context) {
        this.reclaimExpired();
        if (!context?.active || context.schema !== NORMALIZED_SCHEMA) return false;
        if (context.hoId !== binding.hoId || context.token.audience !== binding.expectedAudience) return false;
        const now = this.clock();
        const expiresAtMs = Math.min((context.token.returnedExpiresAt ?? context.token.expiresAt) * 1000, context.token.expiresAt * 1000, now + this.ceilingMs);
        if (expiresAtMs <= now) return false;
        this.entries.set(this.key(token, binding), { context, expiresAtMs, createdAtMs: now });
        return true;
    }

    invalidate(token, binding, observer = () => {}) {
        const removed = this.entries.delete(this.key(token, binding));
        try { observer({ cache: 'subject-decision', outcome: 'invalidated', reasonCode: 'CACHE_INVALIDATED', removed,
            hoId: binding.hoId, audience: binding.expectedAudience, policyFingerprint: binding.policyStamp }); } catch (_) { /* Diagnostic only. */ }
    }

    clear() {
        this.entries.clear();
        this.expiryCursor = null;
    }
}

module.exports = { ActiveIntrospectionCache };
