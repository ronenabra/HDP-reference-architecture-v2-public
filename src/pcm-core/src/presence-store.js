'use strict';

/** Durable, private per-patient source knowledge; failed lookups never erase a known result. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizePatientIdentifier } = require('../../shared/identity-mapping');

class PresenceStore {
    /** Keep source observations beneath the selected team's existing private state root. */
    constructor(directory) { this.directory = directory; fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); }

    /** Hash the full typed identity so identical values in different namespaces remain separate. */
    file(identifier) {
        return path.join(this.directory, `${crypto.createHash('sha256').update(normalizePatientIdentifier(identifier).key).digest('hex')}.json`);
    }

    /** Read only verified stored observations; corrupt state is unavailable, never absence. */
    get(identifier, sourceId) {
        let record;
        try { record = JSON.parse(fs.readFileSync(this.file(identifier), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Stored presence knowledge is unavailable'); }
        if (record.version !== 1 || !record.sources || typeof record.sources !== 'object') throw new Error('Stored presence knowledge is unavailable');
        const value = record.sources[sourceId];
        if (!value) return null;
        if (!['present', 'absent'].includes(value.state) || !Number.isSafeInteger(value.checkedAt)) throw new Error('Stored presence knowledge is unavailable');
        return structuredClone(value);
    }

    /** Atomically replace one successful observation while preserving other sources. */
    record(identifier, sourceId, state, checkedAt) {
        if (!/^[a-z0-9-]+$/.test(sourceId) || !['present', 'absent'].includes(state) || !Number.isSafeInteger(checkedAt)) throw new TypeError('Invalid presence observation');
        const file = this.file(identifier);
        let record = { version: 1, sources: {} };
        try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw new Error('Stored presence knowledge is unavailable'); }
        if (record.version !== 1 || !record.sources || typeof record.sources !== 'object') throw new Error('Stored presence knowledge is unavailable');
        record.sources[sourceId] = { state, checkedAt };
        const temporary = `${file}.${crypto.randomUUID()}.tmp`;
        try { fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
        finally { fs.rmSync(temporary, { force: true }); }
    }
}
module.exports = { PresenceStore };
