'use strict';
/** Qualification-only commands use the existing frozen decision and six transport controls. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const shared = fs.existsSync(path.resolve(__dirname, '../../src/shared/service-grant.js')) ? '../../src/shared/' : '/shared/';
const { inspectScope } = require(`${shared}service-grant`);
const { PRESETS, SIMULATION_CONTROLS, presetSimulationDefaults, presetSourceDefaults } = require(`${shared}conformance-policy`);

/** Read the actual saved decision; missing or unusable decisions cannot supply a request ceiling. */
const observed = new Map();
/** Record a separately obtained, protected Admin oracle; never read authority from public FHIR. */
function rememberApproval(consent, decision) {
    assert.deepEqual(decision?.publicBinding?.identifier, consent.identifier);
    assert.deepEqual(decision?.publicBinding?.patient, consent.patient);
    assert.ok(decision.snapshot, 'Private diagnostic decision required');
    observed.set(consent.id, structuredClone(decision.snapshot));
}
function savedApproval(consent, owner) {
    const saved = owner ? owner.privateRecords.approvals.getDecision(consent.id).snapshot : observed.get(consent.id);
    assert.ok(saved?.usable, 'An actual usable approval snapshot is required');
    return saved;
}

/** Request every approved resource/action; the FHIR query remains independent of this ceiling. */
function requestCeiling(consent, owner) { return inspectScope(savedApproval(consent, owner).scope).requestCeiling; }

/** A successful issuance must retain the exact saved bytes, regardless of requested compatible ceiling. */
function assertIssuedApproval(consent, issued, owner) {
    assert.equal(issued.scope, savedApproval(consent, owner).scope, 'issued scope must equal the saved approval');
}

/** Construct only the supported explicit, optimistic-version-bound pending approval command. */
function approvalCommand(consent, { sourceIds, scopeChoice = 'service-provided', customScope } = {}) {
    assert.equal(consent.status, 'proposed', 'A new pending Consent is required');
    assert.equal(typeof consent.meta?.versionId, 'string');
    assert.ok(Array.isArray(sourceIds) && sourceIds.every(id => typeof id === 'string'));
    assert.ok(['service-provided', 'auto-resources', 'auto-buckets', 'custom'].includes(scopeChoice));
    assert.equal(customScope !== undefined, scopeChoice === 'custom');
    return { sourceIds, scopeChoice, expectedVersion: consent.meta.versionId,
        ...(scopeChoice === 'custom' ? { customScope } : {}) };
}

/** Select a named preset, optionally enabling its six transport checks; never submit retired authority controls. */
function presetCommand(config, options = {}) {
    assert.ok(options && typeof options === 'object' && !Array.isArray(options), 'Explicit transport options required');
    assert.ok(Object.keys(options).every(key => key === 'transportChecks'));
    assert.ok(options.transportChecks === undefined || typeof options.transportChecks === 'boolean');
    const preset = config.conformance.preset;
    assert.ok(PRESETS.includes(preset));
    return { preset, controls: options.transportChecks ? Object.fromEntries(SIMULATION_CONTROLS.map(key => [key, true]))
        : presetSimulationDefaults(preset), perSource: presetSourceDefaults(preset) };
}
module.exports = { savedApproval, rememberApproval, requestCeiling, assertIssuedApproval, approvalCommand, presetCommand };
