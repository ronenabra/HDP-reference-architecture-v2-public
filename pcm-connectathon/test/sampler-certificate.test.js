 'use strict';
/** Ordinary application credentials replace retired sampler artifacts. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
test('provisioning omits sampler keys/mounts and preserves retained retired files', t => {
    const team = fs.mkdtempSync(path.join(os.tmpdir(), 'sampling-certificate-'));
    t.after(() => fs.rmSync(team, { recursive: true, force: true }));
    const certs = path.join(team, 'certs');
    const generate = () => execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/generate-team-certs.js'), '--team-id', 'sampling-cert-test', '--out', certs], { stdio: 'ignore', timeout: 60000 });
    generate();
    assert.ok(fs.existsSync(path.join(certs, 'sp-client.key')));
    assert.ok(fs.existsSync(path.join(certs, 'hospital-b-sp.key')));
    assert.equal(fs.existsSync(path.join(team, 'pcm-private')), false);
    assert.equal(fs.existsSync(path.join(certs, 'sandbox-sampler.crt')), false);
    fs.writeFileSync(path.join(certs, 'sandbox-sampler.key'), 'retained-inert-file');
    generate();
    assert.equal(fs.readFileSync(path.join(certs, 'sandbox-sampler.key'), 'utf8'), 'retained-inert-file');
});
