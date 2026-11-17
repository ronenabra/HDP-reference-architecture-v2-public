'use strict';

/** Export the real candidate Admin HTML from one disposable runtime for the focused popup proof. */
const fs = require('fs'), assert = require('assert/strict');
const { fixture } = require('./pcm-ig-041-migration-fixture');
const { start, request, prepareFixture } = require('./pcm-ig-041-runtime');
const migration = require('../scripts/pcm-ig-041-migration');
const checkpoint = require('../../src/pcm-core/src/migration-checkpoint');

/** Start no historical worker or credentials, then render the actual migrated Admin route. */
async function main() {
    const artifacts = JSON.parse(fs.readFileSync(process.env.PCM04108_ARTIFACTS));
    const f = fixture(null, { preset: 'connectathon-balanced' }); let runtime;
    try {
        prepareFixture(f, artifacts);
        const store = new (require('../../src/pcm-core/src/fhir/store').FHIRStore)();
        checkpoint.restore({ store, ...f.options, runtimeId: artifacts.before.id });
        checkpoint.prepare({ store, ...f.options, runtimeId: artifacts.before.id });
        const preview = migration.plan(f.options); assert.deepEqual(preview.errors, []); migration.apply({ ...f.options, expectedDigest: preview.digest });
        runtime = await start(f, artifacts.after.root, artifacts.after.id, false);
        const response = await request(runtime.ui, '/admin', { plain: true, admin: true, accept: 'text/html' });
        assert.equal(response.status, 200); assert.match(response.text, /Freeze migration checkpoint/);
        fs.writeFileSync(process.env.PCM04108_UI_ARTIFACT, response.text);
        console.log(JSON.stringify({ status: response.status, runtimeId: artifacts.after.id, htmlHash: checkpoint.sha256(Buffer.from(response.text)) }));
        await runtime.stop(); runtime = null;
    } finally { runtime?.processChild.kill('SIGKILL'); fs.rmSync(f.directory, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
