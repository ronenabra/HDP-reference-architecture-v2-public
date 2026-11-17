'use strict';
/** Snapshot only sprint 36's actual owned protocol files; browser faults never touch their producers. */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../../test-support/team-config').installTestRuntime();
const root = process.env.SHARED_LOGS_DIR;
const owned = process.env.PCM_OBS_PLATFORM_OWNED;
if (!owned) throw Error('An explicit owned actual-source directory is required');

/** Copy exact source bytes into this disposable viewer root. */
function snapshot() {
    for (const letter of 'abc') {
        for (const suffix of ['hapi', 'hapi-runtime']) fs.cpSync(path.join(owned, 'logs', letter, suffix), path.join(root, `ho-${letter}-${suffix}`), { recursive: true });
        for (const [base, folder] of [['node-logs', `ho-${letter}-adapter`], ['gateway-logs', `ho-${letter}-gateway`]]) {
            fs.cpSync(path.join(owned, base, folder), path.join(root, folder), { recursive: true });
        }
    }
    for (const [folder, target] of [['ho-a-pcm', 'pcm-core'], ['sp-client', 'sp-client']]) fs.cpSync(path.join(owned, 'node-logs', folder), path.join(root, target), { recursive: true });
}
snapshot();
const records = fs.readFileSync(path.join(root, 'ho-a-hapi-runtime/current.log'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const selected = records.filter(row => row.details?.type === 'HAPI_RESPONSE' && row.details.flowId === 'obs36-doctor-allow').at(-1);
if (!selected) throw Error('An actual current Doctor/native trace is required');
const manifest = { traceId: selected.details.traceId, flowId: selected.details.flowId, requestId: selected.details.requestId,
    timestamp: selected.timestamp, source: 'ho-a-hapi-runtime', snapshot: true, coverage: 'Exact actual sprint 36 protocol snapshots; no synthetic span or permission records.' };
const app = require('../../src/pcm-core/src/index').createUiApp();
app.get('/fixture/manifest', (_req, res) => res.json(manifest));
app.post('/fixture/reset', (_req, res) => { fs.rmSync(root, { recursive: true, force: true }); snapshot(); res.json({ snapshot: true }); });
app.post('/fixture/source/:mode', (req, res) => {
    const target = path.join(root, 'ho-b-gateway');
    if (req.params.mode === 'missing') fs.renameSync(target, target + '.held');
    else fs.renameSync(target + '.held', target);
    res.json({ snapshotOnly: true });
});
const server = app.listen(43186, '127.0.0.1', () => console.log(JSON.stringify(manifest)));
/** Close owned search workers and snapshot files with the fixture process. */
async function close() {
    await app.locals.closeLogSearch(); server.closeAllConnections();
    server.close(() => { fs.rmSync(path.dirname(process.env.TEAM_CONFIG_PATH), { recursive: true, force: true }); process.exit(0); });
}
process.on('SIGTERM', close); process.on('SIGINT', close);
