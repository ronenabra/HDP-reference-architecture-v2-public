#!/usr/bin/env node
'use strict';

/** One explicit focused proof over real EJS, pinned DOM preparation and the existing approval controller. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { parseArgs, repoRoot } = require('../../scripts/lib');
const { startApprovalFixture } = require('../../../test-support/approval-scope-fixture');
const { DEFAULT_SCOPE, MANUAL_SCOPE } = require('../../ui/tests/helpers/demo-access-approval');
(async () => {
    const args = parseArgs(process.argv), root = repoRoot(); assert.ok(args.image && args.output); const output = path.resolve(args.output);
    assert.ok(!fs.existsSync(output), 'refuse to overwrite approval proof'); fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    const html = path.join(output, 'html'); fs.mkdirSync(html, { mode: 0o755 });
    const f = await startApprovalFixture();
    try {
        const consents = [f.create('sandbox-full-access'), f.create('sandbox-full-access')];
        for (const [index, consent] of consents.entries()) fs.writeFileSync(path.join(html, index ? 'manual.html' : 'default.html'), await (await fetch(`${f.base}/ui/approve/${consent.id}`)).text(), { mode: 0o644 });
        const command = ['run', '--rm', '--init', '--network', 'none', '--entrypoint', 'node',
            '-v', `${html}:/fixtures:ro`, '-v', `${root}/pcm-connectathon/test/fixtures/demo-access-approval-browser.js:/proof/browser.js:ro`,
            '-v', `${root}/pcm-connectathon/ui/tests/helpers/demo-access-approval.js:/suite/tests/helpers/demo-access-approval.js:ro`,
            '-v', `${root}/src/shared/ui/approval-scopes.js:/proof/approval-scopes.js:ro`, args.image, '/proof/browser.js'];
        const result = await new Promise((resolve, reject) => execFile('docker', command, { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 60000 }, (error, stdout, stderr) => {
            fs.writeFileSync(path.join(output, 'browser.stdout'), stdout || ''); fs.writeFileSync(path.join(output, 'browser.stderr'), stderr || '');
            fs.writeFileSync(path.join(output, 'browser-command.json'), JSON.stringify({ command: ['docker', ...command], exitCode: error?.code || 0 }, null, 2));
            if (error) reject(error); else resolve(JSON.parse(stdout));
        }));
        const saved = [];
        for (const [index, form] of result.forms.entries()) {
            assert.equal(form.authoredDefaultUnchanged, true);
            const response = await fetch(`${f.base}/ui/approve/${consents[index].id}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form.fields) });
            assert.equal(response.status, 302, await response.text());
            const consent = f.store.get('Consent', consents[index].id), snapshot = f.store.privateRecords.approvals.getDecision(consent.id).snapshot;
            assert.equal(consent.status, 'active'); assert.equal(snapshot.scope, index ? MANUAL_SCOPE : DEFAULT_SCOPE);
            assert.equal(snapshot.choice, index ? 'custom' : 'service-provided'); assert.equal(snapshot.usable, true); saved.push(structuredClone(consent));
        }
        assert.deepEqual(f.store.get('Consent', saved[0].id), saved[0]); assert.notEqual(saved[0].id, saved[1].id);
        const report = { isolatedUnitProof: true, ownedClinicalRuntime: false, liveClinicalRequests: 0, browser: result.browser, playwright: result.playwright,
            authoredDefault: DEFAULT_SCOPE, manualDecision: MANUAL_SCOPE, decisions: saved.map(consent => ({ id: consent.id, status: consent.status, snapshot: f.store.privateRecords.approvals.getDecision(consent.id).snapshot })),
            originalDefaultDecisionUnchanged: true, realEjsControllerAndDomPreparation: true };
        fs.writeFileSync(path.join(output, 'outcome.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ status: 'pass', decisions: 2, liveClinicalRequests: 0 }));
    } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
