'use strict';
/** Additional owned observations model split trace IDs and explicit correlation joins. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { gatewayCompletion } = require('./gateway-log-fixture');

/** Append synthetic adapter/gateway and diagnostic-only observations, refreshing file identities.
 * @param {string} root Disposable corpus directory.
 * @param {object} manifest Search corpus manifest to extend only in INSPECT fixtures.
 * @returns {object} Updated secret-free manifest with exact matching expectations.
 */
function extendInspectionCorpus(root, manifest) {
    // Keep the same physical volume while allowing complete no-match inspection
    // outcomes. SEARCH already qualifies oversized-line partial behavior.
    for (const file of manifest.files) {
        const filename = path.join(root, file.sourceId, file.logFile);
        const data = fs.readFileSync(filename, 'utf8');
        if (!data.includes('oversized-benchmark-marker-')) continue;
        const replaced = data.replace(/oversized-benchmark-marker-z{270000}/, value => value.slice(0, 135000) + '\n' + value.slice(135000));
        fs.writeFileSync(filename, replaced); file.records++;
        file.bytes = Buffer.byteLength(replaced); file.sha256 = crypto.createHash('sha256').update(replaced).digest('hex');
    }
    const otherTrace = 'fedcba9876543210fedcba9876543210';
    const adapterFile = manifest.files.find(file => file.sourceId === 'ho-b-adapter');
    const gatewayFile = manifest.files.find(file => file.sourceId === 'ho-b-gateway');
    const lateFile = manifest.files.findLast(file => file.sourceId === manifest.lateSource);
    if (!adapterFile || !gatewayFile || !lateFile) throw new Error('Inspection needs configured adapter, gateway and late sources');
    const append = (file, records) => {
        const filename = path.join(root, file.sourceId, file.logFile);
        fs.appendFileSync(filename, records.map(record => JSON.stringify(record)).join('\n') + '\n');
        const data = fs.readFileSync(filename);
        file.sha256 = crypto.createHash('sha256').update(data).digest('hex');
        file.bytes = data.length; file.records += records.length;
    };
    append(adapterFile, [{ timestamp: '2026-11-04T10:00:06Z', level: 'INFO', message: 'Synthetic auth-check split trace',
        details: { type: 'REQUEST', method: 'GET', url: '/auth-check', traceId: otherTrace, correlationId: 'late-match', flowId: 'shared-flow' } }]);
    const gateway = gatewayCompletion(1);
    gateway.details.correlationId = 'late-match'; gateway.details.flowId = 'shared-flow';
    delete gateway.details.traceId;
    append(gatewayFile, [gateway]);
    append(lateFile, [{ timestamp: '2026-11-04T10:00:07Z', level: 'INFO', message: 'Synthetic diagnostic-only observation',
        details: { type: 'HARNESS_RESULT', visibility: 'diagnostic', traceId: 'diagnostic-only-id', correlationId: 'diagnostic-only-request' } }]);
    manifest.bytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    manifest.records = manifest.files.reduce((sum, file) => sum + file.records, 0);
    return { ...manifest, inspection: { otherTrace, correlationId: 'late-match', flowId: 'shared-flow',
        traceRoles: ['doctor'], relatedRoles: ['adapter', 'gateway', 'doctor'], diagnosticOnly: 'diagnostic-only-id' } };
}
module.exports = { extendInspectionCorpus };
