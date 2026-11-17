#!/usr/bin/env node
'use strict';

/** Extend the named CI transaction deterministically for real-HAPI preview qualification. */
const fs = require('node:fs');
const path = require('node:path');
const { inspectTransactionBundle } = require('../../clinical-data/transaction-bundle');

/** Return the unchanged CI identities plus >10 matching Observations and a second clinical type. */
function previewFixture(root = path.resolve(__dirname, '../..')) {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'clinical-data/ci/ho-a.source.transaction.json')));
    const observation = data.entry.find(entry => entry.resource.resourceType === 'Observation'
        && entry.resource.subject?.reference === 'Patient/patient-ho-a-0001');
    if (!observation) throw new Error('Missing named ordinary CI Observation prerequisite');
    for (let index = 0; index < 12; index++) {
        const entry = structuredClone(observation);
        entry.resource.id = `ui-preview-extra-${index}`;
        entry.fullUrl = `urn:uuid:00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
        entry.request.url = `Observation/${entry.resource.id}`;
        data.entry.push(entry);
    }
    data.entry.push({ fullUrl: 'urn:uuid:00000000-0000-4000-8000-000000000100',
        resource: { resourceType: 'DiagnosticReport', id: 'ui-preview-report', status: 'final',
            code: { text: 'Synthetic laboratory preview proof' }, effectiveDateTime: observation.resource.effectiveDateTime, subject: { reference: 'Patient/patient-ho-a-0001' },
            meta: structuredClone(observation.resource.meta) },
        request: { method: 'PUT', url: 'DiagnosticReport/ui-preview-report' } });
    const bytes = Buffer.from(JSON.stringify(data, null, 2) + '\n');
    inspectTransactionBundle(bytes);
    return bytes;
}
if (require.main === module) {
    if (!process.argv[2]) throw new Error('An explicit private output path is required');
    fs.writeFileSync(process.argv[2], previewFixture());
}
module.exports = { previewFixture };
