'use strict';
/** Render the actual Doctor EJS with one lifecycle-created approval for focused UI tests. */
const fs = require('node:fs'), path = require('node:path'), ejs = require('ejs');
const { approvalPresentation } = require('../src/sp-client/src/approval-presentation');
const { clinicalTokenFixture, V } = require('./clinical-token-fixture');
const { ORDINARY, identifierTypes } = require('../src/sp-client/src/patient-choice');
const { FIXED } = require('../src/shared/sandbox-patients');
const scope = `patient/Patient.rs?${V} patient/Observation.s?${V} patient/Condition.r?${V}`;
/** Render one lifecycle-created saved approval separately from a changed composer. */
function render(outcome, status = 'active', overrides = {}) {
    const fixture = clinicalTokenFixture({ scope });
    const consent = fixture.approve({ system: ORDINARY.idSystem, value: ORDINARY.idValue }); consent.status = status;
    const source = 'https://source.example/fhir';
    consent.discoveredEndpoints = [{ url: source, name: 'Readable source' }];
    const data = outcome ? { resourceType: 'Bundle', entry: [], preview: { source, outcome, types: [{ type: 'Observation', count: 0, total: null, boundary: 'unknown' }], failures: outcome === 'partial' ? [{ type: 'Condition', outcome: 'denied', message: 'Approval refused' }] : [] } } : null;
    return ejs.render(fs.readFileSync(path.resolve(__dirname, '../src/sp-client/src/views/index.ejs'), 'utf8'), {
        teamId: 'ux-render', browserBase: '/doctor', identities: [{ id: 'hospital-a', label: 'Requesting application' }], currentIdentity: 'hospital-a',
        publicBaseUrls: { pcmUi: 'http://pcm.test', spClient: 'http://doctor.test/doctor' }, flash: null,
        conformance: { mode: 'connectathon', resultLabel: 'NON-CONFORMANT SIMULATION', warnings: [] }, services: [], selectedServiceId: 'different-composer-service',
        selectedPatientId: `${ORDINARY.idSystem}|000000026`, patients: [ORDINARY, ...FIXED], identifierTypes: identifierTypes(),
        consents: [{ id: consent.id, consent, data, approval: approvalPresentation(consent, {}, { querySelection: 'patient/Observation.s patient/Condition.r' }), service: { id: fixture.service.id, name: 'Historical service', available: true, readiness: 'Ready' } }],
        ...overrides
    });
}
module.exports = { render };
