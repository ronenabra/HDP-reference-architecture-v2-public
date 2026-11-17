'use strict';
/** Focused qualification-helper checks use real lifecycle decisions, never patched approvals. */
const test = require('node:test'), assert = require('node:assert/strict');
const { dataGrantFixture } = require('../../test-support/data-grants');
const { resolveGrant } = require('../../src/pcm-core/src/data-grant');
const { PRESETS, SIMULATION_CONTROLS, buildEffectivePolicy } = require('../../src/shared/conformance-policy');
const { savedApproval, requestCeiling, assertIssuedApproval, approvalCommand, presetCommand } = require('./demo-approval-contract');

test('whole saved ceiling yields exact issued authority; narrower query scope is never substituted', () => {
    const f = dataGrantFixture(), saved = savedApproval(f.consent, f.store);
    assert.equal(requestCeiling(f.consent, f.store), f.request.scope);
    assert.ok(requestCeiling(f.consent, f.store).includes('patient/Patient.rs'));
    const grant = resolveGrant({ ...f.request, scope: requestCeiling(f.consent, f.store) });
    assertIssuedApproval(f.consent, grant, f.store);
    assert.equal(grant.scope, saved.scope);
    assert.ok(saved.scope.includes('v3-Confidentiality|R'));
    assert.ok(saved.scope.includes('v3-Confidentiality|V'));
    assert.equal(resolveGrant({ ...f.request, scope: 'patient/Observation.rs' }).scope, saved.scope);
    assert.throws(() => assertIssuedApproval(f.consent, { scope: 'patient/Observation.rs' }, f.store), /saved approval/);
    assert.throws(() => requestCeiling(dataGrantFixture({ legacy: true }).consent), /snapshot/);
});

test('approval command requires an explicit new pending version and sources', () => {
    const pending = { status: 'proposed', meta: { versionId: '1' } };
    assert.deepEqual(approvalCommand(pending, { sourceIds: ['source-a'] }), {
        sourceIds: ['source-a'], scopeChoice: 'service-provided', expectedVersion: '1'
    });
    const customScope = 'patient/Patient.rs?_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V';
    assert.deepEqual(approvalCommand(pending, { sourceIds: ['source-a'], scopeChoice: 'custom', customScope }), {
        sourceIds: ['source-a'], scopeChoice: 'custom', expectedVersion: '1', customScope
    });
    assert.throws(() => approvalCommand(dataGrantFixture().consent, { sourceIds: ['source-a'] }), /pending/);
    assert.throws(() => approvalCommand(pending, { sourceIds: ['source-a'], scopeChoice: 'custom' }));
    assert.throws(() => approvalCommand({ status: 'proposed' }, { sourceIds: ['source-a'] }));
});

test('every preset command contains only the six supported controls and retains mandatory authority', () => {
    for (const preset of PRESETS) for (const transportChecks of [false, true]) {
        const config = require('../../test-support/team-config').buildTeamConfig({}, preset), command = presetCommand({ conformance: { preset } }, { transportChecks });
        assert.deepEqual(Object.keys(command).sort(), ['controls', 'perSource', 'preset']);
        assert.deepEqual(Object.keys(command.controls).sort(), [...SIMULATION_CONTROLS].sort());
        assert.deepEqual(command.perSource, {});
        config.securitySimulation = { global: command.controls, perSource: command.perSource };
        const policy = buildEffectivePolicy(config);
        assert.equal(policy.simulation.controls.smartScopes, true);
        assert.equal(policy.simulation.controls.patientMapping, true);
        assert.equal(policy.grantPolicy.grantFullClinicalAccess, false);
    }
    assert.throws(() => presetCommand({ conformance: { preset: 'strict' } }, false));
    assert.throws(() => presetCommand({ conformance: { preset: 'strict' } }, { grantFullClinicalAccess: true }));
});


test('explicit broader new lifecycle decision retains V-only bytes and cannot widen an older decision', () => {
    const v = '_security:not=http://terminology.hl7.org/CodeSystem/v3-Confidentiality|V';
    const broad = ['Patient', 'Observation', 'DiagnosticReport', 'Condition'].map(type => `patient/${type}.rs?${v}`).join(' ');
    const f = require('../../test-support/clinical-token-fixture').clinicalTokenFixture({ scope: broad });
    const original = savedApproval(f.consent, f.store);
    assert.equal(original.scope, broad);
    assert.equal(original.origin, 'manual');
    assert.ok(!original.scope.includes('v3-Confidentiality|R'), 'the explicit broader choice permits R');
    assertIssuedApproval(f.consent, resolveGrant(f.request), f.store);
    const newer = f.approve(undefined, `${broad} patient/Encounter.rs?${v}`);
    assert.notEqual(newer.id, f.consent.id);
    assert.equal(savedApproval(newer, f.store).scope, `${broad} patient/Encounter.rs?${v}`);
    assert.deepEqual(savedApproval(f.store.get('Consent', f.consent.id), f.store), original);
});

test('the owned Condition positive is bound to the actual ordinary national-id Patient and dataset manifest', () => {
    const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
    const root = path.resolve(__dirname, '../demo-qualification');
    const bytes = fs.readFileSync(path.join(root, 'ho-a.source.transaction.json'));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), manifest.bundles[0].sha256);
    const bundle = JSON.parse(bytes), positive = bundle.entry.find(e => e.resource.id === 'qualification-ho-a-condition-national');
    const patient = bundle.entry.find(e => e.resource.id === 'patient-ho-a-0001').resource;
    assert.ok(patient.identifier.some(id => id.system === 'http://fhir.health.gov.il/identifier/il-national-id' && id.value === '000000018'));
    assert.equal(positive.resource.resourceType, 'Condition');
    assert.equal(positive.resource.subject.reference, `Patient/${patient.id}`);
    assert.ok(positive.resource.meta.tag.some(tag => tag.code === 'ho-a'));
    assert.ok(!positive.resource.meta.security.some(label => label.code === 'HTEST'));
    assert.equal(bundle.entry.filter(e => e.resource.resourceType === 'Condition' && e.resource.subject?.reference === `Patient/${patient.id}`).length, 1);
});
