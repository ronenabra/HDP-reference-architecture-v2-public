'use strict';
/** Owned real gateway/auth/upstream fixture behind the real PCM UI/log APIs.
 * Gateway and browser containers share only this disposable network namespace.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const assert = require('node:assert/strict');
const { installTestRuntime, buildTeamConfig } = require('../../test-support/team-config');
installTestRuntime();
const runtime = path.dirname(process.env.TEAM_CONFIG_PATH);
const directory = process.env.ARRIVAL_FIXTURE_DIR || '/fixture';
process.env.SHARED_LOGS_DIR = path.join(directory, 'logs');
const log = path.join(process.env.SHARED_LOGS_DIR, 'ho-b-gateway/current.log');
fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(log, '');
const app = require('../../src/pcm-core/src/index').createUiApp();
const state = { pending: [], requests: [], outcomes: [], targetPort: 8443, scenario: 'success', sequence: 0 };
const creds = { key: fs.readFileSync(path.join(directory, 'certs/client.key')), cert: fs.readFileSync(path.join(directory, 'certs/client.crt')) };

/** Read exact emitted native JSON; unfinished writes are reported, never repaired. */
function records() { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse); }
/** Complete one owned delayed auth/upstream response after the observer releases it. */
function respond(res, isAuth, scenario) {
    if (res.destroyed) return;
    res.statusCode = isAuth ? scenario === 'rejected' ? 401 : 204 : scenario === 'upstream-error' ? 502 : 200;
    if (isAuth && res.statusCode === 204) res.setHeader('X-Local-Token', 'fixture-private-token');
    res.end(isAuth ? '' : JSON.stringify({ resourceType: 'Bundle', fixture: scenario }));
}
/** Stub only the private transport endpoints; NGINX performs real auth_request/proxy handling. */
function upstream(req, res) {
    const scenario = new URL(req.headers['x-original-uri'] || req.url, 'http://fixture').searchParams.get('scenario') || state.scenario;
    const isAuth = req.url.startsWith('/auth-check');
    state.requests.push({ url: req.url, headers: req.headers, isAuth, scenario });
    if (scenario === (isAuth ? 'delayed-auth' : 'delayed-upstream')) state.pending.push({ res, isAuth, scenario });
    else respond(res, isAuth, scenario);
}
const upstreamServers = [43187, 3000].map(port => http.createServer(upstream).listen(port, '127.0.0.1'));

/** Fire an actual TLS client request without waiting for its completion. */
app.post('/fixture/start', (req, res) => {
    const scenario = String(req.query.scenario || 'success'); state.scenario = scenario;
    const sequence = ++state.sequence;
    const correlationId = String(req.query.correlationId || `arrival-${sequence}`);
    const uri = String(req.query.url || `/fhir/Observation?scenario=${scenario}&sequence=${sequence}`);
    const outgoing = https.request({ hostname: '127.0.0.1', port: state.targetPort, path: uri,
        rejectUnauthorized: false, ...creds, method: 'GET', headers: {
            'X-Correlation-Id': correlationId, 'X-Flow-Id': 'arrival-flow',
            Authorization: 'Bearer fixture-public-token', 'X-Local-Token': 'spoofed-private-token',
            'X-PCM-Import-Credential': 'spoofed-import-credential', 'X-PCM-Request-URI': '/spoofed'
        } }, response => {
        response.resume(); response.on('end', () => state.outcomes.push({ sequence, correlationId, status: response.statusCode, headers: response.headers }));
    });
    outgoing.on('error', error => state.outcomes.push({ sequence, correlationId, error: error.code })); outgoing.end();
    res.json({ sequence, correlationId, uri });
});
app.get('/fixture/state', (_req, res) => res.json({ records: records(), pending: state.pending.length, requests: state.requests, outcomes: state.outcomes }));
app.post('/fixture/release', (_req, res) => {
    const pending = state.pending.splice(0); pending.forEach(item => respond(item.res, item.isAuth, item.scenario)); res.json({ released: pending.length });
});
app.post('/fixture/reset', (_req, res) => {
    assert.equal(state.pending.length, 0, 'release pending requests before resetting');
    fs.writeFileSync(log, ''); state.requests = []; state.outcomes = []; res.json({ reset: true });
});
app.post('/fixture/preset', (req, res) => {
    const preset = String(req.query.preset || 'connectathon-easy');
    const configuration = buildTeamConfig({}, preset);
    configuration.runtime.revision = Date.now();
    fs.writeFileSync(path.join(directory, 'team-config.json'), JSON.stringify(configuration));
    res.json({ preset, configuration });
});
app.post('/fixture/target', (req, res) => { state.targetPort = Number(req.query.port); res.json({ port: state.targetPort }); });
/** Kill only a worker descended from this fixture's explicitly shared NGINX master. */
app.post('/fixture/interrupt', (_req, res) => {
    const master = Number(fs.readFileSync(path.join(directory, 'gateway.pid'), 'utf8'));
    const children = fs.readFileSync(`/proc/${master}/task/${master}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
    assert.equal(children.length, 1, 'one owned gateway worker');
    const pid = children[0];
    assert.match(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'), /nginx: worker process/);
    process.kill(pid, 'SIGKILL'); res.json({ interrupted: pid, master });
});
const server = app.listen(43186, '127.0.0.1', () => console.log(JSON.stringify({ fixture: 'real-gateway-arrival', node: process.version })));
/** Close only owned listeners, requests and search workers. */
async function stop() {
    await app.locals.closeLogSearch(); server.closeAllConnections();
    for (const listener of upstreamServers) { listener.closeAllConnections(); listener.close(); }
    server.close(() => { fs.rmSync(runtime, { recursive: true, force: true }); process.exit(0); });
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
