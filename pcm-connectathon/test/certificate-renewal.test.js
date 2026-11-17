'use strict';
/** Inventory, same-key renewal, key rotation and controlled recreation failure recovery. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { certificates } = require('../../test-support/certificates');
const { buildTeamConfig } = require('../../test-support/team-config');
const { certificateInventory, prepareRenewal } = require('../../src/shared/certificate-renewal');
const { applyRenewal } = require('../scripts/rotate-team-certificates');

/** Copy only an owned test certificate tree; returned files model one stopped disposable team. */
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-leaf-renewal-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.cpSync(certificates(), path.join(directory, 'certs'), { recursive: true });
    const config = buildTeamConfig(); config.runtime.stateDir = path.join(directory, 'state');
    fs.mkdirSync(config.runtime.stateDir); fs.writeFileSync(path.join(config.runtime.stateDir, 'clinical-sentinel'), 'retained-clinical-content');
    const configPath = path.join(directory, 'team-config.json'); fs.writeFileSync(configPath, JSON.stringify(config));
    fs.writeFileSync(path.join(directory, '.env'), `LOCAL_UID=${process.getuid()}\nLOCAL_GID=${process.getgid()}\nTEAM_ADMIN_PASSWORD=owned-only\n`);
    return { directory, config, configPath, originalConfig: fs.readFileSync(configPath), certs: path.join(directory, 'certs') };
}

test('inventory covers actual registered roles, deduplicates shared pairs and preserves unknown custom ownership', t => {
    const f = fixture(t);
    f.config.certificateRoles.serviceProvider.mtls = f.config.certificateRoles.serviceProvider.assertion;
    f.config.organizations.dataSources = [{ id: 'uploaded-source', pcmClientAuth: { cert: 'participant.crt', key: 'participant.key', managedBy: 'participant' } }];
    const inventory = certificateInventory(f.config);
    assert.equal(inventory.pairs.filter(pair => pair.cert === 'sp-client-assertion.crt').length, 1);
    for (const ho of ['ho-a', 'ho-b', 'ho-c']) for (const purpose of ['gatewayServer', 'gatewayMtls', 'gatewayAssertion', 'hapiServer']) {
        assert.ok(inventory.pairs.some(pair => pair.roles.includes(`${ho}.${purpose}`)));
    }
    assert.ok(inventory.preserved.some(item => item.role === 'uploaded-source'));
    assert.ok(inventory.preserved.some(item => item.role === 'untrustedClient'));
});
test('same-key renewal preserves issuer/private identity; explicit key rotation changes kid', t => {
    const f = fixture(t), root = fs.readFileSync(path.join(f.certs, 'rootCA.crt'));
    f.config.organizations.serviceProvider.assertionCertificates = { ES384: 'sp-client-assertion-es384.crt' };
    const renewed = prepareRenewal(f.config, f.certs);
    assert.equal(renewed.rootChanged, false); assert.equal(renewed.material['rootCA.crt'], undefined);
    assert.ok(renewed.entries.length > 20);
    for (const entry of renewed.entries) { assert.notEqual(entry.before, entry.after); assert.equal(entry.oldKid, entry.newKid); }
    const rotated = prepareRenewal(f.config, f.certs, { rotateKeys: true });
    for (const entry of rotated.entries) assert.notEqual(entry.oldKid, entry.newKid);
    assert.deepEqual(fs.readFileSync(path.join(f.certs, 'rootCA.crt')), root);
    assert.equal(renewed.material['untrusted-client.crt'], undefined);
    assert.ok(renewed.entries.some(entry => entry.roles.includes('serviceProvider.ES384')));
});
for (const uncertain of [false, true]) test(`recreation failure ${uncertain ? 'retains new graph when stop fails' : 'restores credentials/config after a successful stop'}`, t => {
    const f = fixture(t), prepared = prepareRenewal(f.config, f.certs), before = fs.readFileSync(path.join(f.certs, 'sp-client-assertion.crt'));
    let downs = 0;
    const execute = (_command, args) => {
        assert.equal(args.includes('--volumes'), false);
        if (args.includes('down')) { downs++; if (uncertain && downs === 2) throw Error('injected stop failure'); }
        if (args.includes('up')) throw Error('injected recreation failure');
    };
    assert.throws(() => applyRenewal({ teamId: 'owned-renewal', teamDir: f.directory, prepared, originalConfig: f.originalConfig, execute }), uncertain ? /uncertain/ : /restored/);
    if (uncertain) {
        assert.notDeepEqual(fs.readFileSync(f.configPath), f.originalConfig);
        assert.deepEqual(fs.readFileSync(path.join(f.certs, 'sp-client-assertion.crt')), prepared.material['sp-client-assertion.crt']);
    } else {
        assert.deepEqual(fs.readFileSync(f.configPath), f.originalConfig);
        assert.deepEqual(fs.readFileSync(path.join(f.certs, 'sp-client-assertion.crt')), before);
    }
    assert.equal(fs.readFileSync(path.join(f.config.runtime.stateDir, 'clinical-sentinel'), 'utf8'), 'retained-clinical-content');
    assert.equal(fs.readdirSync(path.join(f.directory, 'credential-backups')).length, 1);
});
test('generation or stale preparation failure cannot partially publish live credentials', t => {
    const f = fixture(t), before = fs.readFileSync(path.join(f.certs, 'pcm-core.crt'));
    fs.renameSync(path.join(f.certs, 'ho-c-hapi.key'), path.join(f.certs, 'missing.key'));
    assert.throws(() => prepareRenewal(f.config, f.certs), /ENOENT/);
    assert.deepEqual(fs.readFileSync(path.join(f.certs, 'pcm-core.crt')), before);
    fs.renameSync(path.join(f.certs, 'missing.key'), path.join(f.certs, 'ho-c-hapi.key'));
    const prepared = prepareRenewal(f.config, f.certs);
    fs.appendFileSync(f.configPath, ' ');
    assert.throws(() => applyRenewal({ teamId: 'owned-renewal', teamDir: f.directory, prepared, originalConfig: f.originalConfig, execute() {} }), /changed after preparation/);
    assert.deepEqual(fs.readFileSync(path.join(f.certs, 'pcm-core.crt')), before);
});

test('unknown participant aliases to selected team files refuse before any credential changes', t => {
    const f = fixture(t);
    f.config.organizations.dataSources = [{ id: 'participant', pcmClientAuth: { cert: 'sp-client-assertion.crt', key: 'sp-client-assertion.key' } }];
    assert.throws(() => prepareRenewal(f.config, f.certs), /resolve ownership/);
});

test('filesystem publication failure restores the complete previous credential graph before config rollback', t => {
    const f = fixture(t), prepared = prepareRenewal(f.config, f.certs);
    const previous = Object.fromEntries(Object.keys(prepared.material).map(name => [name, fs.readFileSync(path.join(f.certs, name))]));
    // The durable publisher writes through an opened descriptor. Inject at its
    // selected-path open rather than assuming writeFileSync receives a pathname.
    const open = fs.openSync; let injected = false;
    fs.openSync = function (filename, ...args) {
        if (!injected && filename === path.join(f.certs, 'sp-client-assertion.key') && args[0] === 'w') { injected = true; throw Error('injected credential publication failure'); }
        return open.call(this, filename, ...args);
    };
    try {
        assert.throws(() => applyRenewal({ teamId: 'owned-renewal', teamDir: f.directory, prepared, originalConfig: f.originalConfig, execute() {} }), /publication failure/);
    } finally { fs.openSync = open; }
    assert.equal(injected, true);
    assert.deepEqual(fs.readFileSync(f.configPath), f.originalConfig);
    for (const [name, bytes] of Object.entries(previous)) assert.deepEqual(fs.readFileSync(path.join(f.certs, name)), bytes, name);
});

 test('explicit private JWT key ID refuses key rotation before stopping listeners', t => {
    const f = fixture(t), prepared = prepareRenewal(f.config, f.certs, { rotateKeys: true });
    fs.appendFileSync(path.join(f.directory, '.env'), 'LOCAL_JWT_KEY_ID=explicit-private-key-id\n');
    let executed = false;
    assert.throws(() => applyRenewal({ teamId: 'owned-renewal', teamDir: f.directory, prepared, originalConfig: f.originalConfig, execute() { executed = true; } }), /Explicit LOCAL_JWT_KEY_ID/);
    assert.equal(executed, false); assert.deepEqual(fs.readFileSync(f.configPath), f.originalConfig);
});
