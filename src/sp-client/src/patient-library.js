'use strict';
/** Bounded per-identity patient convenience state; selections never prove source presence. */
const { FIXED, sampleSources, samplingConfigurationStamp } = require('../../shared/sandbox-patients');
const { ORDINARY, identifierTypes } = require('./patient-choice');
/** Project readable row facts without changing the exact identifier pair. */
function libraryPatient(patient) {
    return { ...patient, display: patient.display || 'Name unknown',
        identifierType: identifierTypes().find(type => type.system === patient.idSystem)?.label || 'Other identifier',
        review: patient.standardTest ? 'Automatic test approval' : 'Consent review required' };
}
/** Replace samples and discard late results after source/team/environment changes. */
class PatientLibrary {
    constructor() { this.states = new Map(); }
    /** Return only the current configured generation; runtime/team changes reset candidates. */
    get(identity, config) {
        const stamp = JSON.stringify([samplingConfigurationStamp(config), config.organizations, config.certificateRoles,
            config.healthOrganizations, config.security, config.securitySimulation]);
        let state = this.states.get(identity);
        if (!state || state.stamp !== stamp) {
            state = { stamp, generation: (state?.generation || 0) + 1, sourceId: sampleSources(config)[0]?.id || '', candidates: [], state: 'unloaded', refreshedAt: null, rejected: 0, error: '' };
            this.states.set(identity, state);
        }
        return state;
    }
    /** Clear previous candidates before issuing a request, so failure cannot show an old sample. */
    begin(identity, config, sourceId) {
        const state = this.get(identity, config);
        if (!sampleSources(config).some(source => source.id === sourceId)) throw new Error('Unsupported sandbox source');
        Object.assign(state, { generation: state.generation + 1, sourceId, candidates: [], state: 'loading', refreshedAt: null, rejected: 0, error: '' });
        return { state, generation: state.generation };
    }
    /** Publish only a current result from the same configured source and generation. */
    complete(identity, config, pending, result) {
        const current = this.get(identity, config);
        if (current !== pending.state || current.generation !== pending.generation || current.sourceId !== result.sourceId) throw new Error('Patient refresh superseded');
        const seen = new Set(this.offline().map(patient => `${patient.idSystem}|${patient.idValue}`));
        current.candidates = (result.patients || []).slice(0, 10).filter(patient => { const key = `${patient.idSystem}|${patient.idValue}`; if (seen.has(key)) return false; seen.add(key); return true; }).map(libraryPatient);
        Object.assign(current, { state: result.state, refreshedAt: result.refreshedAt, rejected: result.rejected || 0 });
        return current;
    }
    /** Invalidate pending responses on source change or explicit cancellation. */
    invalidate(identity, config, sourceId, cancelled = false) {
        const state = this.get(identity, config); state.generation++; state.candidates = []; state.state = cancelled ? 'cancelled' : 'unloaded'; state.refreshedAt = null; state.rejected = 0; state.error = '';
        if (sourceId !== undefined) state.sourceId = sourceId;
        return state;
    }
    /** Record failure only while this exact application/source generation still owns the load. */
    fail(identity, config, pending, error) {
        const state = this.get(identity, config);
        if (state !== pending?.state || state.generation !== pending.generation) return;
        state.state = error.message === 'Refresh cancelled' ? 'cancelled' : 'failed';
        state.error = state.state === 'cancelled' ? '' : error.message; state.candidates = [];
    }
    /** Offline membership never includes source candidates, including on cached reload. */
    offline() { return [ORDINARY, ...FIXED].map(libraryPatient); }
    choices(identity, config) { return [...this.offline(), ...this.get(identity, config).candidates]; }
    clear() { this.states.clear(); }
}
module.exports = { PatientLibrary, libraryPatient };
