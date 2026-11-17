'use strict';
/** Child helpers must retain the parent's target, config and queued bundle identity. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { operationOwner } = require('../operation-owner');
const { runTransactionBundleImport } = require('../loader');

test('child ownership rejects another target and changed configuration', t => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-child-owner-'));
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const target = { id: 'ho-a', endpoint: 'https://participant.test/fhir' };
    const configPath = path.join(stateDir, 'team-config.json');
    fs.writeFileSync(configPath, JSON.stringify({ healthOrganizations: [target] }));
    const parent = operationOwner({ stateDir, serverId: 'ho-a', kind: 'import', details: { targetIdentity: JSON.stringify(target) }, env: { TEAM_CONFIG_PATH: configPath } });
    assert.equal(operationOwner({ stateDir, serverId: 'ho-a', kind: 'import', env: parent.env }).operation.id, parent.operation.id);
    assert.throws(() => operationOwner({ stateDir, serverId: 'ho-b', kind: 'reset', env: parent.env }), /target differs/);
    fs.writeFileSync(configPath, JSON.stringify({ healthOrganizations: [{ ...target, endpoint: 'https://changed.test/fhir' }] }));
    assert.throws(() => operationOwner({ stateDir, serverId: 'ho-a', kind: 'import', env: parent.env }), /configuration changed/);
    assert.equal(parent.registry.get(parent.operation.id).phase, 'queued');
});

test('a changed queued bundle is rejected before any loader network operation', async t => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-child-checksum-'));
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    let requests = 0;
    await assert.rejects(runTransactionBundleImport({
        owner: operationOwner({ stateDir, serverId: 'ho-a', kind: 'import', details: { sha256: '0'.repeat(64) }, env: {} }),
        bundlePath: path.resolve(__dirname, '../ci/ho-a.source.transaction.json'), expectedHo: 'ho-a',
        endpoint: 'https://participant.test/fhir', credential: 'synthetic-credential'.repeat(3), stateDir,
        expectedSha256: '0'.repeat(64), fetchImpl: async () => { requests++; throw new Error('unexpected request'); }
    }), /checksum changed/);
    assert.equal(requests, 0);
});
