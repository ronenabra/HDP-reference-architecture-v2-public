'use strict';

/** Owned synthetic files behind the real PCM log routes; no clinical transport. */
const fs = require('node:fs');
const path = require('node:path');
require('../../test-support/team-config').installTestRuntime();
const { gatewayRaw } = require('../../test-support/gateway-log-fixture');
const runtime = path.dirname(process.env.TEAM_CONFIG_PATH);
const directory = path.join(process.env.SHARED_LOGS_DIR, 'ho-b-gateway');
fs.mkdirSync(directory, { recursive: true });
const filename = path.join(directory, 'current.log');
const app = require('../../src/pcm-core/src/index').createUiApp();

/** Reset only owned fabricated files between serial browser cases. */
app.post('/fixture/reset', (_req, res) => {
    const records = Array.from({ length: 6 }, (_, index) => gatewayRaw(index));
    records.push(JSON.stringify({ timestamp: '2026-11-04T10:00:06.000Z', level: 'ERROR',
        message: 'Synthetic native gateway error', details: { type: 'GATEWAY_ERROR', correlationId: 'gateway-native-error' } }));
    records.push(JSON.stringify({ timestamp: '2026-11-04T10:00:07.000Z', level: 'ERROR',
        message: 'Synthetic harness diagnostic', details: { type: 'HARNESS_ERROR' } }));
    fs.writeFileSync(filename, records.join('\n') + '\n');
    res.json({ records: records.length });
});
// Replay immutable bytes already captured from the qualified native producer.
// This exercises the current reader/UI together; it does not rerun native transport.
app.post('/fixture/native-arrivals', (_req, res) => {
    const captured = fs.readFileSync(path.resolve(__dirname, '../../test-support/fixtures/log-viewer/native-rotation-sample.jsonl'));
    fs.writeFileSync(filename, captured);
    res.json({ bytes: captured.length });
});
app.post('/fixture/append', (_req, res) => {
    fs.appendFileSync(filename, Array.from({ length: 6 }, (_, index) => gatewayRaw(6 + index)).join('\n') + '\n');
    res.json({ appended: 6 });
});
const server = app.listen(43183, '127.0.0.1', () => console.log(JSON.stringify({
    fixture: 'gateway-derived-level', runtime, node: process.version, url: 'http://127.0.0.1:43183'
})));

/** Remove only this fixture runtime after the HTTP listener closes. */
function stop() {
    server.closeAllConnections();
    server.close(() => { fs.rmSync(runtime, { recursive: true, force: true }); process.exit(0); });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
