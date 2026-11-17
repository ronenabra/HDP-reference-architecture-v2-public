'use strict';
/** Owned real-view/API fixture; no retained teams or clinical runtime is contacted. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const config = require('../../test-support/team-config').installTestRuntime();
const runtime = path.dirname(process.env.TEAM_CONFIG_PATH);
const components = require('../../src/pcm-core/src/log-ordering').configuredLogComponents(config);
const { createSearchCorpus } = require('../../test-support/log-search-corpus');
let manifest = createSearchCorpus(process.env.SHARED_LOGS_DIR, components, Number(process.env.PCM_SEARCH_CORPUS_MIB || 8));
if (process.env.PCM_INSPECT_FIXTURE === 'true') manifest = require('../../test-support/log-inspection-corpus').extendInspectionCorpus(process.env.SHARED_LOGS_DIR, manifest);
// Optional exact native snapshot supports the focused budget-cause viewer journey.
if (process.env.PCM_BUDGET_NATIVE_LOG) {
    const native = components.find(source => source.dir === 'ho-a-hapi-runtime');
    const bytes = fs.readFileSync(process.env.PCM_BUDGET_NATIVE_LOG);
    const target = path.join(process.env.SHARED_LOGS_DIR, native.dir, 'current.log');
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
    manifest.budgetSnapshot = { source: native.dir, exactBytes: bytes.length };
}
const app = require('../../src/pcm-core/src/index').createUiApp();
const writerFile = path.join(process.env.SHARED_LOGS_DIR, manifest.earlySource, 'current.log');
fs.mkdirSync(path.dirname(writerFile), { recursive: true });
let writer = null, writes = 0;
// These mutations are available only in this owned test process, never product routes.
if (process.env.PCM_INSPECT_FIXTURE === 'true') app.post('/fixture/inspection-rotate', (_req, res) => {
    const file = manifest.files.findLast(file => file.sourceId === manifest.lateSource);
    const filename = path.join(process.env.SHARED_LOGS_DIR, file.sourceId, file.logFile);
    const bytes = fs.readFileSync(filename), replacement = filename + '.fixture-replacement';
    // Allocate the replacement before rename so the old inode cannot be reused.
    fs.writeFileSync(replacement, bytes); fs.renameSync(replacement, filename);
    res.json({ rotated: file.sourceId });
});
if (process.env.PCM_INSPECT_FIXTURE === 'true') app.post('/fixture/inspection-source/:state', (req, res) => {
    const file = manifest.files.find(file => file.sourceId === 'ho-b-adapter');
    const filename = path.join(process.env.SHARED_LOGS_DIR, file.sourceId, file.logFile), held = filename + '.fixture-held';
    if (req.params.state === 'fail') { fs.renameSync(filename, held); fs.mkdirSync(filename); }
    else { fs.rmdirSync(filename); fs.renameSync(held, filename); }
    res.json({ source: file.sourceId, state: req.params.state });
});
app.get('/fixture/manifest', (_req, res) => res.json(manifest));
app.get('/fixture/metrics', (_req, res) => res.json({ memory: process.memoryUsage(), cpu: process.cpuUsage(), threads: fs.readdirSync('/proc/self/task').length,
    resource: process.resourceUsage(), io: fs.readFileSync('/proc/self/io', 'utf8'), node: process.version, writes }));
app.post('/fixture/writer/:state', (req, res) => {
    clearInterval(writer); writer = null;
    if (req.params.state === 'on') writer = setInterval(() => {
        fs.appendFileSync(writerFile, JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO',
            message: `Synthetic concurrent writer ${++writes}`, details: { type: 'REQUEST', body: 'live writer' } }) + '\n');
    }, 5);
    res.json({ writes, active: Boolean(writer) });
});
app.post('/fixture/evict-owned-cache', (_req, res) => {
    // Only this disposable root is traversed. This is never a host-wide cache drop.
    const code = 'import os,sys\nn=0\nfor root,dirs,files in os.walk(sys.argv[1]):\n for name in files:\n  p=os.path.join(root,name)\n  f=os.open(p,os.O_RDONLY)\n  os.fsync(f)\n  os.posix_fadvise(f,0,0,os.POSIX_FADV_DONTNEED)\n  os.close(f)\n  n+=1\nprint(n)';
    try { res.json({ method: 'owned-file POSIX_FADV_DONTNEED', files: Number(execFileSync('python3', ['-c', code, process.env.SHARED_LOGS_DIR], { encoding: 'utf8' }).trim()) }); }
    catch (_) { res.status(501).json({ method: 'unsupported', note: 'Cold-equivalent eviction is not available; do not claim cold evidence.' }); }
});
const server = app.listen(43184, '127.0.0.1', () => console.log(JSON.stringify({ fixture: 'log-search', bytes: manifest.bytes, files: manifest.files.length, node: process.version })));
/** Close owned threads/listener/files, including on failed browser qualification. */
async function stop() {
    clearInterval(writer); await app.locals.closeLogSearch(); server.closeAllConnections();
    server.close(() => { fs.rmSync(runtime, { recursive: true, force: true }); process.exit(0); });
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
