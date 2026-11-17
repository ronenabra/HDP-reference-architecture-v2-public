'use strict';
/** Real Admin routes/ledger with an in-process synthetic HAPI transport only.
 * No configured private endpoint is contacted. Gates expose the exact intervals
 * before upload persistence and after the background worker has accepted it.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../../test-support/team-config').installTestRuntime();
const runtime = path.dirname(process.env.TEAM_CONFIG_PATH);
const { DataOperationRegistry } = require('../../src/pcm-core/src/data-operations');
const registry = new DataOperationRegistry();
const states = new Map(config.healthOrganizations.map(ho => [ho.id, { counts: {}, posts: 0 }]));
for (const ho of config.healthOrganizations) process.env[ho.import.credentialEnv] = 'synthetic-fixture-maintenance-credential-only';

/** A test-controlled gate; releasing it never abandons or resets an operation. */
function gate() {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    return { waiting, release };
}
let gates = null;
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/fhir+json' } });
require('../../src/shared/outbound-destination').guardedFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const ho = config.healthOrganizations.find(item => parsed.origin === new URL(item.clinicalData.privateFhirBaseUrl).origin);
    if (!ho) throw new Error('fixture refuses an unknown upstream');
    const state = states.get(ho.id);
    if (parsed.pathname.endsWith('/$expunge')) { state.counts = {}; return json({ resourceType: 'Parameters' }); }
    if (init.method === 'POST') {
        state.posts++;
        if (ho.id === 'ho-b' && gates) { gates.transactionReached = true; await gates.transaction.waiting; }
        const bundle = JSON.parse(Buffer.from(init.body).toString('utf8'));
        state.counts = {};
        for (const entry of bundle.entry) state.counts[entry.resource.resourceType] = (state.counts[entry.resource.resourceType] || 0) + 1;
        return json({ resourceType: 'Bundle', type: 'transaction-response', entry: bundle.entry.map(() => ({ response: { status: '201 Created' } })) });
    }
    if (ho.id === 'ho-b' && gates && !gates.preflightReleased) {
        gates.preflightReached = true;
        await gates.preflight.waiting;
    }
    const type = parsed.pathname.split('/').at(-1);
    if (type === '_history') return json({ resourceType: 'Bundle', total: Object.keys(state.counts).length ? 1 : 0 });
    return json({ resourceType: 'Bundle', total: state.counts[type] || 0 });
};
const app = require('../../src/pcm-core/src/index').createUiApp();
app.post('/fixture/arm', (_req, res) => {
    if (registry.list().some(operation => !['succeeded', 'failed'].includes(operation.phase))) return res.status(409).json({ error: 'fixture still has active work' });
    gates = { preflight: gate(), transaction: gate(), preflightReleased: false, transactionReached: false, preflightReached: false };
    res.json({ armed: true });
});
app.post('/fixture/release/:stage', (req, res) => {
    if (gates && req.params.stage === 'preflight') { gates.preflightReleased = true; gates.preflight.release(); }
    if (gates && req.params.stage === 'transaction') gates.transaction.release();
    res.json({ released: req.params.stage });
});
app.get('/fixture/facts', (_req, res) => res.json({
    connections,
    gates: gates && { preflightReached: gates.preflightReached, transactionReached: gates.transactionReached },
    servers: Object.fromEntries(['ho-a', 'ho-b'].map(id => {
        const operation = registry.list(id)[0];
        return [id, { operation, reserved: fs.existsSync(registry.lockFile(id)),
            savedUpload: Boolean(operation && fs.existsSync(path.join(process.env.STATE_DIR, 'data-uploads', `${operation.id}.json`))),
            posts: states.get(id).posts }];
    }))
}));
const connections = [];
const server = app.listen(43182, '127.0.0.1', () => console.log('Synthetic Admin reload fixture ready on 43182'));
server.on('request', (req, res) => {
    if (req.method !== 'POST' || !/\/fhir-servers\/[^/]+\/imports$/.test(req.url)) return;
    const record = { url: req.url, finished: false, closedBeforeResponse: false };
    connections.push(record);
    res.once('finish', () => { record.finished = true; });
    res.once('close', () => { record.closedBeforeResponse = !res.writableEnded; });
});
/** Remove only the owned synthetic runtime on fixture shutdown. */
function stop() { server.close(); fs.rmSync(runtime, { recursive: true, force: true }); process.exit(0); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
