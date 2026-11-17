'use strict';

/** Admin cannot publish a file-only strict/connectathon mode transition. */
const { installTestRuntime, buildTeamConfig } = require('../../../test-support/team-config');
installTestRuntime();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const router = require('../src/routes/ui');

for (const [current, next] of [['connectathon-balanced', 'strict'], ['strict', 'connectathon-easy']]) {
    test(`${current} to ${next} names recreation and preserves configuration`, () => {
        const before = JSON.stringify(buildTeamConfig({}, current));
        fs.writeFileSync(process.env.TEAM_CONFIG_PATH, before);
        const handler = router.stack.find(item => item.route?.path === '/admin/config/simulation').route.stack[0].handle;
        let status;
        let body;
        handler({ body: { preset: next }, get: () => 'application/json' }, {
            status(value) { status = value; return this; }, json(value) { body = value; }
        });
        assert.equal(status, 409);
        assert.equal(body.code, 'restart-required');
        assert.match(body.nextAction, /reconfigure-local-team.js/);
        assert.equal(fs.readFileSync(process.env.TEAM_CONFIG_PATH, 'utf8'), before);
    });
}
