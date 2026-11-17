'use strict';
/** Disposable local HTTP fixture with real operator routes and 10,000 fabricated log records. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { installTestRuntime } = require('../../test-support/team-config');
const config = installTestRuntime();
const runtime = path.dirname(process.env.TEAM_CONFIG_PATH);
const { configuredLogComponents } = require('../../src/pcm-core/src/log-ordering');
const inventory = configuredLogComponents(config);
const payload = 'Fabricated Patient/000000018 non-AWS token <script>literal</script> '.repeat(55);
for (let component = 0; component < inventory.length; component++) {
    const dir = path.join(process.env.SHARED_LOGS_DIR, inventory[component].dir);
    fs.mkdirSync(path.join(dir, 'history', '2026-10-03'), { recursive: true });
    const records = Array.from({ length: 750 }, (_, index) => JSON.stringify({
        timestamp: new Date(Date.UTC(2026, 9, 4) + index * 1000 + component * 10).toISOString(),
        level: ['INFO', 'WARN', 'ERROR', 'DEBUG'][index % 4], message: `Synthetic ${inventory[component].label} event ${index}`,
        details: { type: 'REQUEST', category: index % 3 === 0 ? 'uncategorized' : 'system',
            visibility: 'default', method: 'GET', url: '/fhir/Patient', payload }
    }));
    fs.writeFileSync(path.join(dir, 'current.log'), records.slice(300).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'history', '2026-10-03', 'app.log'), records.slice(0, 300).join('\n') + '\n');
}
const { createUiApp } = require('../../src/pcm-core/src/index');
// Fixture-only pages precede the real application's terminal HTML error wrapper.
const app = require('express')();
app.set('view engine', 'ejs');
// Doctor fixtures use the real authored template and complete configured identity inventory.
const { isTestAutoApproved } = require('../../src/shared/consent-presentation');
const { IDENTIFIER_SYSTEMS, SECURITY } = require('../../src/shared/pcm-contract');
const synthetic = { id: 'test-auto', status: 'active', patient: { identifier: { system: IDENTIFIER_SYSTEMS.syntheticTest, value: '1' } },
    meta: { security: [{ system: SECURITY.system, code: SECURITY.syntheticTestCode }] }, provision: { period: { start: new Date().toISOString() } } };
app.get('/fixture/doctor', (_req, res) => res.render(path.resolve(__dirname, '../../src/sp-client/src/views/index.ejs'), {
    teamId: config.teamId, identities: require('../../src/sp-client/src/identities').getIdentities(),
    currentIdentity: 'hospital-a', patients: [], patientInventory: { state: 'empty' }, selectedPatientId: '000000018',
    consents: [{ id: synthetic.id, consent: synthetic, testAutoApproved: isTestAutoApproved(synthetic) },
        { id: 'ordinary-pending', consent: { id: 'ordinary-pending', status: 'proposed' } }],
    relaxedSources: require('../../src/shared/consent-presentation').relaxedConsentSources({ simulation: { controls: { consentState: false } } }), publicBaseUrls: config.publicBaseUrls, flash: null,
    conformance: require('../../src/sp-client/src/client').getConformanceInfo()
}));
app.use(createUiApp());
const server = app.listen(43180, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://127.0.0.1:43180',
    runtime, records: inventory.length * 750, hardware: { platform: os.platform(), cpu: os.cpus()[0].model,
        memoryBytes: os.totalmem() }, components: inventory.length })));
/** Clean only this fixture on termination; it never touches another team. */
function stop() { server.close(); fs.rmSync(runtime, { recursive: true, force: true }); process.exit(0); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
