'use strict';
/** Explicit preview/backup migration changes only the selected team and its catalog. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { buildTeamConfig } = require('../../test-support/team-config');
const { migrate, main } = require('../scripts/migrate-team-config');
test('retained private configuration is inert until explicit app entitlement migration', () => {
    const config = buildTeamConfig({ serviceCatalog: { file: 'catalog/demo-services.json', bindings: [{ application: 'doctor', providerRole: 'serviceProvider', serviceKey: 'lab-follow-up', instanceId: 'migration-service', instanceIdentifier: 'MIGRATION' }] }, sandboxSampler: { clientId: 'pcm-retired-private-client-0001', sourceIds: ['ho-a'], mtlsCert: 'sandbox-sampler.crt', mtlsKey: 'sandbox-sampler.key' } });
    const bytes = JSON.stringify(config); assert.deepEqual(migrate(config), config);
    assert.equal(require('../../src/shared/sandbox-patients').sampleSources(config).length, 0);
    const next = migrate(config, { standardSampling: true });
    assert.equal(JSON.stringify(config), bytes); assert.equal(next.sandboxSampler, undefined);
    assert.deepEqual(next.systemAuthorization.clientEntitlements[next.organizations.serviceProvider.clientId], ['sandbox-patient-sample']);
    assert.equal(next.systemAuthorization.clientEntitlements[next.organizations.serviceProvider.clientId].includes('patient-authentication'), false);
});
test('preview is read-only; explicit write creates byte-exact config/catalog backups and is idempotent', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sampling-migrate-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const catalogPath = path.join(directory, 'catalog/demo-services.json'), configPath = path.join(directory, 'team-config.json'); fs.mkdirSync(path.dirname(catalogPath));
    const catalog = structuredClone(require('../../config/demo-services.json')); catalog.sandboxSampler = catalog.sandboxSampling; delete catalog.sandboxSampling;
    fs.writeFileSync(catalogPath, JSON.stringify(catalog));
    const config = buildTeamConfig({ serviceCatalog: { file: 'catalog/demo-services.json', bindings: [{ application: 'doctor', providerRole: 'serviceProvider', serviceKey: 'lab-follow-up', instanceId: 'migration-service', instanceIdentifier: 'MIGRATION' }] } });
    fs.writeFileSync(configPath, JSON.stringify(config)); const before = fs.readFileSync(configPath), catalogBefore = fs.readFileSync(catalogPath);
    const output = console.log; let preview; console.log = value => { preview = JSON.parse(value); };
    try { main(['node', 'migration', '--config', configPath, '--standard-sampling']); } finally { console.log = output; }
    assert.ok(preview.catalog.sandboxSampling); assert.deepEqual(fs.readFileSync(configPath), before); assert.deepEqual(fs.readFileSync(catalogPath), catalogBefore);
    main(['node', 'migration', '--config', configPath, '--standard-sampling', '--write']);
    assert.deepEqual(fs.readFileSync(`${configPath}.pre-standard-sampling.json`), before);
    assert.deepEqual(fs.readFileSync(`${catalogPath}.pre-standard-sampling.json`), catalogBefore);
    main(['node', 'migration', '--config', configPath, '--standard-sampling', '--write']);
    assert.ok(JSON.parse(fs.readFileSync(catalogPath)).sandboxSampling); assert.equal(JSON.parse(fs.readFileSync(catalogPath)).sandboxSampler, undefined);
});
