'use strict';
/** Browser setup gates reject missing, stale, failed and cross-team facts independently of application grants. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { selectedFixtureFacts } = require('../ui/tests/fixture-facts');
test('required fixture facts fail closed and optional unselected setup is explicitly empty', t => {
    const previous = { ...process.env };
    t.after(() => { for (const key of ['PCM_UI_FIXTURE_FACTS', 'PCM_UI_REQUIRE_CLINICAL', 'PCM_UI_TEAM_ID']) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    } });
    delete process.env.PCM_UI_FIXTURE_FACTS; process.env.PCM_UI_REQUIRE_CLINICAL = 'true';
    assert.throws(selectedFixtureFacts, /required private fixture/);
    process.env.PCM_UI_REQUIRE_CLINICAL = 'false'; assert.deepEqual(selectedFixtureFacts(), { patients: [] });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-facts-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    process.env.PCM_UI_FIXTURE_FACTS = path.join(directory, 'facts.json'); process.env.PCM_UI_TEAM_ID = 'owned-test';
    const facts = { method: 'private-named-fixture-read', teamId: 'owned-test', observedAt: new Date().toISOString(), sources: [{ state: 'verified' }], patients: [{ idValue: '18' }] };
    fs.writeFileSync(process.env.PCM_UI_FIXTURE_FACTS, JSON.stringify(facts)); assert.deepEqual(selectedFixtureFacts(), facts);
    for (const change of [{ teamId: 'other' }, { observedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() }, { observedAt: 'invalid' }, { sources: [{ state: 'failed' }] }, { patients: Array(31).fill({ idValue: '18' }) }]) {
        fs.writeFileSync(process.env.PCM_UI_FIXTURE_FACTS, JSON.stringify({ ...facts, ...change }));
        assert.throws(selectedFixtureFacts, /stale, failed|another team/);
    }
});

test('browser artifact scanning rejects exact source credentials without printing them', t => {
    const { secretScan } = require('../ui/run-playwright');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-secret-scan-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'facts.json'), secret = 'qualification-source-secret-'.repeat(2);
    fs.writeFileSync(file, JSON.stringify({ patients: [] })); assert.doesNotThrow(() => secretScan(directory, [secret]));
    fs.writeFileSync(file, JSON.stringify({ header: secret }));
    assert.throws(() => secretScan(directory, [secret]), error => /prohibited secret material/.test(error.message) && !error.message.includes(secret));
});
