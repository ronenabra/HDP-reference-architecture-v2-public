'use strict';

/** Actual runtime readers must not select another team after a selected-file error. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');

test('all runtime entry points reject missing, malformed, partial and retired selected files', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-config-errors-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const selected = path.join(directory, 'selected.json');
    const callers = [
        "require('./src/pcm-core/src/index')",
        "require('./src/sp-client/src/team-config').loadTeamConfig()",
        "require('./src/sp-client/src/client')._test.getPcmFhirUrl()",
        "require('./src/sp-client/src/identities').getIdentities()",
        "require('./src/ds-auth-adapter/src/mapper').mapPatient({system:'urn:test',value:'1'},'ho-a')",
        "require('./src/ds-auth-adapter/src/index').readTeamConfig()",
        "require('./src/ds-fhir-server/src/index')"
    ];
    for (const contents of [null, '{malformed', JSON.stringify({ teamId: 'partial' }), JSON.stringify({ configVersion: 'pcm-team-config/2' })]) {
        if (contents !== null) fs.writeFileSync(selected, contents);
        for (const [index, caller] of callers.entries()) {
            const result = spawnSync(process.execPath, ['-e', caller], {
                cwd: root, encoding: 'utf8', timeout: 5000,
                env: { ...process.env, TEAM_CONFIG_PATH: selected, LOG_DIR: path.join(directory, `logs-${index}`), STATE_DIR: path.join(directory, `state-${index}`) }
            });
            assert.equal(result.error, undefined, result.error?.message);
            assert.notEqual(result.status, 0, caller);
            assert.match(result.stderr, /ENOENT|JSON|SyntaxError|configuration is invalid/);
        }
    }
});
