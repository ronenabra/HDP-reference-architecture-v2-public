'use strict';

/** Execute the retained seed and real certificate helper against disposable state. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');

test('runtime seed generates config/certificates and preserves them on the second run', t => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-seed-'));
    t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
    const env = { ...process.env, RUNTIME_DIR: runtime, TEAM_ID: 'seed-smoke',
        TEAM_CONFIG_PATH: path.join(runtime, 'team-config.json'), CERTS_DIR: path.join(runtime, 'certs'),
        EXAMPLE_TEAM_CONFIG_PATH: path.join(root, 'pcm-connectathon/example-team-config.json'),
        GENERATE_TEAM_CERTS_SCRIPT: path.join(root, 'pcm-connectathon/scripts/generate-team-certs.js'),
        SEED_UPDATE_PUBLIC_URLS: 'false' };
    const runSeed = () => {
        const result = spawnSync(process.execPath, ['pcm-connectathon/aws/scripts/seed-runtime.js'], { cwd: root, env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        return result.stdout;
    };
    assert.match(runSeed(), /Runtime initialization complete/);
    const config = JSON.parse(fs.readFileSync(env.TEAM_CONFIG_PATH));
    assert.equal(config.teamId, 'seed-smoke');
    const files = ['rootCA.crt', 'pcm-core.key', 'sp-client-assertion.crt', 'ho-a-hapi.crt'];
    const before = files.map(name => fs.readFileSync(path.join(env.CERTS_DIR, name), 'utf8'));
    assert.ok(before.every(contents => contents.includes('-----BEGIN')));
    assert.match(runSeed(), /Certificate directory already initialized/);
    assert.deepEqual(files.map(name => fs.readFileSync(path.join(env.CERTS_DIR, name), 'utf8')), before);
    assert.deepEqual(JSON.parse(fs.readFileSync(env.TEAM_CONFIG_PATH)), config);
});
