'use strict';
/** Owned real Logs listener and corpus. No retained service or token lookup. */
const fs = require('node:fs'), path = require('node:path');
require('../../test-support/team-config').installTestRuntime();
const runtime = path.dirname(process.env.TEAM_CONFIG_PATH), root = process.env.SHARED_LOGS_DIR;
const { writeStructuredCorpus } = require('../../test-support/log-structured-corpus');
let corpus = writeStructuredCorpus(root);
const app = require('../../src/pcm-core/src/index').createUiApp();
app.get('/fixture/manifest', (_req, res) => res.json({ bytes: corpus.bytes, lines: corpus.lines, token: corpus.token, jwt: corpus.jwt,
    ids: Object.fromEntries(corpus.emitted.map(entry => [entry.message, entry.id])) }));
app.post('/fixture/reset', (_req, res) => { corpus = writeStructuredCorpus(root); res.json({ reset: true }); });
// Add bounded browsing/ID fixtures only when the Columns qualification requests them.
app.post('/fixture/columns', (_req, res) => {
    const now = Date.now(), long = 'columns-שלום-<literal>-' + 'x'.repeat(180);
    const rows = Array.from({ length: 180 }, (_, index) => ({ timestamp: new Date(now - index).toISOString(), level: 'INFO',
        message: index === 0 ? 'Columns exact ID fixture' : `Columns row ${index}`,
        details: index === 0 ? { correlationId: long + '-correlation', flowId: long + '-flow', traceId: long + '-trace' }
            : index === 1 ? { requestId: 'columns-legacy-request' } : {} }));
    fs.appendFileSync(corpus.file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    res.json({ rows: rows.length, long });
});
app.post('/fixture/append', (_req, res) => { fs.appendFileSync(corpus.file, JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', message: 'Appended independent row', details: { type: 'REQUEST' } }) + '\n'); res.json({ appended: true }); });
// Bypass the writer only to exercise the actual reader's AWS-safe source projection.
app.post('/fixture/aws-raw', (_req, res) => {
    fs.appendFileSync(corpus.file, JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', message: 'AWS raw projection fixture', details: { AWS_SECRET_ACCESS_KEY: 'owned-synthetic-aws-secret' } }) + '\n');
    res.json({ appended: true });
});
app.post('/fixture/rotate', (_req, res) => { const replacement = corpus.file + '.replacement'; fs.writeFileSync(replacement, fs.readFileSync(corpus.file)); fs.renameSync(replacement, corpus.file); res.json({ rotated: true }); });
const server = app.listen(43188, '127.0.0.1', () => console.log(JSON.stringify({ fixture: 'structured', node: process.version, root })));
/** Tear down only this process's owned worker pool/listener/files. */
async function stop() { await app.locals.closeLogSearch(); server.closeAllConnections(); server.close(() => { fs.rmSync(runtime, { recursive: true, force: true }); process.exit(0); }); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
