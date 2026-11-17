'use strict';
/** Reproducible mixed JSONL corpus for owned search/browser/benchmark fixtures only. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const TRACE = '0123456789abcdef0123456789abcdef';
const RARE = 'needle-rare-733';

/** Generate approximately requested MiB across exactly 53 configured current/history files.
 * @param {string} root Empty, owned disposable log root.
 * @param {object[]} components Existing validated configured sources.
 * @param {number} mib Desired payload volume; final records add a few bounded bytes.
 * @returns {object} Secret-free manifest with file hashes, targets and expected visible matches.
 */
function createSearchCorpus(root, components, mib = 733) {
    const files = [];
    for (const component of components) {
        for (const file of ['current.log', 'history/2026-11-01/app.log', 'history/2026-11-02/app.log', 'history/2026-11-03/app.log']) {
            files.push({ component, logFile: file, filename: path.join(root, component.dir, file) });
        }
    }
    const selected = files.sort((a, b) => a.filename.localeCompare(b.filename, 'en')).slice(0, 53);
    // Include the lexically last configured source for source-order starvation checks.
    const last = files.at(-1);
    if (!selected.some(file => file.filename === last.filename)) selected[selected.length - 1] = last;
    if (selected.length !== 53) throw new Error('The qualification corpus requires at least 14 configured components');
    const padding = 'Fabricated FHIR Observation value Patient/123 bearer-non-AWS '.repeat(110);
    const record = (index, details = {}, message = 'Synthetic retained event') => ({
        timestamp: new Date(Date.UTC(2026, 10, 4, 10) + index % 3600 * 1000).toISOString(),
        level: 'INFO', message,
        details: { type: 'REQUEST', method: 'GET', url: '/fhir/Observation?_count=10', status: 200,
            body: { resourceType: 'Observation', valueString: padding }, ...details }
    });
    const target = Math.floor(mib * 1048576 / selected.length), manifest = [];
    for (const [index, file] of selected.entries()) {
        fs.mkdirSync(path.dirname(file.filename), { recursive: true });
        const fd = fs.openSync(file.filename, 'w'), hash = crypto.createHash('sha256');
        let bytes = 0, records = 0;
        const emit = value => {
            const data = (typeof value === 'string' ? value : JSON.stringify(value)) + '\n';
            fs.writeSync(fd, data); hash.update(data); bytes += Buffer.byteLength(data); records++;
        };
        if (!index) emit(record(0, { correlationId: 'early-match' }, 'Synthetic early match'));
        const line = JSON.stringify(record(index));
        // Batch writes avoid turning fixture construction into a small-write benchmark.
        const batch = (line + '\n').repeat(128);
        while (bytes + Buffer.byteLength(batch) < target) { fs.writeSync(fd, batch); hash.update(batch); bytes += Buffer.byteLength(batch); records += 128; }
        while (bytes < target) emit(line);
        if (index === selected.length - 1) {
            for (let match = 0; match < 4; match++) emit(record(match, { traceId: TRACE, correlationId: 'late-match', flowId: 'shared-flow', body: { valueString: `${RARE} Rare literal [x]`, token: 'non-AWS-synthetic', AWS_SECRET_ACCESS_KEY: 'FAKE_CORPUS_AWS_SECRET' } }, `Synthetic sparse match ${match}`));
            emit(record(10, { body: TRACE }, 'Synthetic payload-only trace false hit'));
            emit(record(11, { traceId: TRACE + 'x' }, 'Synthetic longer-ID false hit'));
            emit(record(12, { visibility: 'diagnostic', traceId: TRACE }, 'Synthetic diagnostic sparse match'));
            emit(record(13, { visibility: 'hidden', traceId: TRACE }, 'Synthetic hidden sparse match'));
            emit('{malformed-benchmark-record');
            emit('oversized-benchmark-marker-' + 'z'.repeat(270000));
        }
        fs.closeSync(fd);
        manifest.push({ sourceId: file.component.dir, logFile: file.logFile, bytes, records, sha256: hash.digest('hex') });
    }
    return { schemaVersion: 'log-search-corpus/1', files: manifest, bytes: manifest.reduce((sum, file) => sum + file.bytes, 0),
        records: manifest.reduce((sum, file) => sum + file.records, 0), traceId: TRACE, rare: RARE,
        earlySource: selected[0].component.dir, lateSource: selected.at(-1).component.dir,
        expected: { defaultTrace: 4, diagnosticTrace: 5, allTrace: 6, combined: 4, rare: 4, absent: 0,
            malformed: 1, oversized: 0 }, scope: '53 configured current/history files, three rotations at most per component' };
}
module.exports = { createSearchCorpus, TRACE, RARE };
