'use strict';
/** Meaningful copy projections preserve scope bytes, evidence and lifecycle distinctions. */
const test = require('node:test'), assert = require('node:assert/strict');
const presentation = require('../../shared/consent-presentation');
const { consentStatus } = require('../../shared/consent-status');
const { EXTENSIONS, CODE_SYSTEMS, IDENTIFIER_SYSTEMS, SECURITY } = require('../../shared/pcm-contract');

test('dates, history and saved permissions describe actual values without inventing grants', () => {
    assert.match(presentation.readableDate('2026-11-01T14:12:00Z'), /1 Nov 2026.*14:12:00.*UTC/);
    assert.equal(presentation.readableDate('unknown'), 'Not recorded');
    assert.equal(presentation.historyLabel({ value: 2, code: 'a' }), 'Past 2 years');
    assert.equal(presentation.historyLabel({ value: 1, code: 'mo' }), 'Past 1 month');
    assert.match(presentation.historyLabel({ value: 7, code: 'custom' }), /7 custom/);
    const scope = 'patient/Patient.rs patient/Observation.rs?_security=http://pcm.fhir.health.gov.il/cs/pcm-information-buckets|laboratoryTests patient/DiagnosticReport.s';
    assert.match(presentation.savedPermissions(scope), /Read and search patient records.*observations, filtered by laboratory tests.*Search diagnostic reports/);
    assert.equal(scope.endsWith('DiagnosticReport.s'), true);
    assert.match(presentation.savedPermissions('patient/MedicationRequest.r'), /Read medication requests/);
    assert.match(presentation.savedPermissions('  bad  '), /Unrecognized permission/);
    assert.match(presentation.savedPermissions('patient/Observation.rs?status=final'), /with saved filters/);
    assert.equal(presentation.savedPermissions(''), 'No permission text was saved.');
});

test('choice and source audit summaries retain unknown evidence and resolve actual source names', () => {
    assert.equal(presentation.permissionChoice('generated: All service buckets and resource types — Auto-generated'), "Generated from the service's data categories");
    assert.equal(presentation.permissionChoice('authored: Medication records only'), 'Service-defined permission option: Medication records only');
    assert.equal(presentation.permissionChoice('custom: Custom scope'), 'Custom permissions — advanced');
    assert.match(presentation.permissionChoice('mystery'), /not recorded/);
    assert.equal(presentation.sourceHistory({ at: 'invalid' }), null);
    assert.equal(presentation.sourceHistory(null), null);
    const audit = presentation.sourceHistory({ at: '2026-11-01T00:00:00Z', added: ['a', 'unknown'], removed: [] }, [{ id: 'a', name: 'Source A' }]);
    assert.equal(audit.added, 'Source A, unknown'); assert.equal(audit.removed, 'None');
});

test('elapsed approval and original exact typed test approval do not imply current usability or invent history', () => {
    const consent = { id: 'test', status: 'active', patient: { identifier: { system: IDENTIFIER_SYSTEMS.syntheticTest, value: '1' } },
        meta: { security: [{ system: SECURITY.system, code: SECURITY.syntheticTestCode }], lastUpdated: '2026-11-02T00:00:00Z' },
        provision: { period: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } },
        extension: [{ url: EXTENSIONS.consentBusinessStatus, valueCoding: { system: CODE_SYSTEMS.consentBusinessStatus, code: 'active' } }] };
    const view = consentStatus(consent, Date.parse('2026-11-05T00:00:00Z'));
    assert.match(view.description, /period has ended/); assert.doesNotMatch(view.description, /records this consent as active/);
    assert.equal(view.event, null); assert.match(view.changedAt, /Unrecorded/);
    assert.equal(presentation.isTestAutoApproved(consent), true);
    consent.status = 'inactive'; assert.equal(presentation.isTestAutoApproved(consent), true);
    consent.patient.identifier.system = 'urn:other'; assert.equal(presentation.isTestAutoApproved(consent), false);
    consent.patient.identifier.system = IDENTIFIER_SYSTEMS.syntheticTest;
    consent.patient.identifier.value = '3'; assert.equal(presentation.isTestAutoApproved(consent), false);
});
