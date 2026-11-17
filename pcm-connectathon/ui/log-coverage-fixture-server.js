'use strict';
/** Owned real reader/search fixture for Coverage tasks; never opens a retained team. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const config = require('../../test-support/team-config').installTestRuntime();
const root = process.env.SHARED_LOGS_DIR, runtime = path.dirname(process.env.TEAM_CONFIG_PATH);
const sources = require('../../src/pcm-core/src/log-ordering').configuredLogComponents(config);
const app = require('../../src/pcm-core/src/index').createUiApp();
const ids = { flowId: 'coverage+flow/&?=one', traceId: 'a'.repeat(32), correlationId: 'coverage-request-one' };
/** Write synthetic retained files with real inventory, paging, omission and failure behavior. */
function reset() {
    fs.rmSync(root, { recursive: true, force: true });
    for (const source of sources) {
        fs.mkdirSync(path.join(root, source.dir), { recursive: true });
        fs.writeFileSync(path.join(root, source.dir, 'current.log'), '');
    }
    const now = Date.now() - 60000;
    const record = (index, source, padding = '') => JSON.stringify({ timestamp: new Date(now + index).toISOString(), level: 'INFO',
        message: `Coverage ${source} ${index}`, details: { type: 'REQUEST', method: 'GET', url: '/coverage', ...ids, padding } });
    const pcm = Array.from({ length: 280 }, (_, index) => record(index, 'pcm-core', 'p'.repeat(9000)));
    pcm.push(record(281, 'pcm-core', 'oversized'.repeat(40000))); pcm.push(record(282, 'pcm-core'));
    fs.writeFileSync(path.join(root, 'pcm-core/current.log'), pcm.join('\n') + '\n');
    for (const source of ['sp-client', 'ho-a-gateway', 'ho-a-adapter', 'ho-b-adapter']) {
        fs.writeFileSync(path.join(root, source, 'current.log'), [record(400, source), record(401, source)].join('\n') + '\n');
    }
    fs.writeFileSync(path.join(root, 'ho-a-hapi/current.log'), JSON.stringify({ timestamp: new Date(now + 500).toISOString(), level: 'INFO', message: 'Coverage import-only HAPI', details: { type: 'IMPORT_COMPLETE', operationId: 'coverage-import' } }) + '\n');
    fs.rmSync(path.join(root, 'ho-c-adapter/current.log')); fs.mkdirSync(path.join(root, 'ho-c-adapter/current.log'));
    fs.rmSync(path.join(root, 'ho-b-hapi/current.log'));
    return { ids, sources, files: sources.map(source => {
        const file = path.join(root, source.dir, 'current.log');
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { source: source.dir, state: fs.existsSync(file) ? 'failed-directory' : 'missing' };
        const bytes = fs.readFileSync(file); return { source: source.dir, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    }) };
}
let manifest = reset();
app.post('/fixture/reset', (_req, res) => { manifest = reset(); res.json(manifest); });
app.get('/fixture/manifest', (_req, res) => res.json(manifest));
app.post('/fixture/heal', (_req, res) => {
    const file = path.join(root, 'ho-c-adapter/current.log'); fs.rmSync(file, { recursive: true }); fs.writeFileSync(file, '');
    res.json({ healed: 'ho-c-adapter' });
});
app.post('/fixture/append', (_req, res) => {
    fs.appendFileSync(path.join(root, 'ho-a-adapter/current.log'), JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', message: 'Coverage live append', details: { type: 'REQUEST', method: 'GET', url: '/coverage', ...ids } }) + '\n');
    res.json({ appended: true });
});
const server = app.listen(43189, '127.0.0.1', () => console.log(JSON.stringify({ fixture: 'coverage', node: process.version })));
/** Close only the owned listener/workers and remove its temporary runtime. */
async function stop() { await app.locals.closeLogSearch(); server.closeAllConnections(); server.close(() => { fs.rmSync(runtime, { recursive: true, force: true }); process.exit(0); }); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
