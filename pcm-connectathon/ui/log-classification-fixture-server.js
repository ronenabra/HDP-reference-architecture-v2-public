'use strict';
/** Disposable real log APIs and shared Doctor middleware; never contacts a retained team. */
const fs = require('node:fs');
const path = require('node:path');
require('../../test-support/team-config').installTestRuntime();
const { writeCorpus, writeSanityCorpus } = require('../../test-support/log-classification-corpus');
const runtime = path.dirname(process.env.TEAM_CONFIG_PATH);
const root = process.env.SHARED_LOGS_DIR;
const app = require('../../src/pcm-core/src/index').createUiApp();
const previous = process.env.LOG_DIR;
process.env.LOG_DIR = path.join(root, 'sp-client');
const doctor = require('../../src/shared/logger').createLogger({ service: 'sp-client', onFinished: require('on-finished') });
process.env.LOG_DIR = previous;
app.post('/selection', doctor.requestLogger, (_req, res) => res.status(200).send('selection cleared'));
app.post('/fixture/sanity', (_req, res) => {
    const manifest = writeCorpus(root);
    for (const source of manifest.sources) fs.writeFileSync(path.join(root, source, 'current.log'), '');
    res.json(writeSanityCorpus(root));
});
app.post('/fixture/reset', (_req, res) => res.json(writeCorpus(root, { repeats: 12, padding: 900 })));
app.post('/fixture/routine', (_req, res) => {
    const manifest = writeCorpus(root);
    for (const source of manifest.sources) fs.writeFileSync(path.join(root, source, 'current.log'), '');
    fs.writeFileSync(path.join(root, 'pcm-core/current.log'), JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', message: 'routine protocol', details: { type: 'REQUEST', url: '/token' } }) + '\n');
    res.json({ routine: true });
});
app.post('/fixture/diagnostic-only', (_req, res) => {
    fs.appendFileSync(path.join(root, 'ds-fhir-server/current.log'), JSON.stringify({ timestamp: new Date().toISOString(), level: 'ERROR', message: 'DS FHIR config reload rejected', details: { type: 'PROCESS_RELOAD_FAILED', stage: 'config', error: 'synthetic rejected revision' } }) + '\n');
    res.json({ diagnostic: true });
});
app.post('/fixture/rotate', (_req, res) => {
    for (const source of ['ds-fhir-server', 'sp-client', 'pcm-core']) {
        const file = path.join(root, source, 'current.log');
        fs.writeFileSync(file + '.replacement', fs.readFileSync(file)); fs.renameSync(file + '.replacement', file);
    }
    res.json({ rotated: true });
});
app.post('/fixture/truncate', (_req, res) => {
    for (const source of ['ds-fhir-server', 'sp-client', 'pcm-core']) fs.writeFileSync(path.join(root, source, 'current.log'), '');
    res.json({ truncated: true });
});
app.post('/fixture/append', (_req, res) => {
    fs.appendFileSync(path.join(root, 'ho-b-gateway/current.log'), JSON.stringify({ timestamp: new Date().toISOString(), level: 'ERROR', message: 'Live wrong-path request', details: { type: 'GATEWAY_ERROR', method: 'GET', url: '/live-wrong-path' } }) + '\n');
    res.json({ appended: true });
});
const server = app.listen(43185, '127.0.0.1', () => console.log(JSON.stringify({ fixture: 'classification', node: process.version })));
/** Stop owned workers/listener and remove owned fixture files. */
async function stop() { await app.locals.closeLogSearch(); server.closeAllConnections(); server.close(() => { fs.rmSync(runtime, { recursive: true, force: true }); process.exit(0); }); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
