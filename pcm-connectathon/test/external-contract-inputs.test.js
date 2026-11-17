'use strict';

/** Public fetch pins fail closed on drift, unavailable inputs, redirects and filesystem escapes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install, sha256, prepare, check, validateManifest, download } = require('../../scripts/install-contract-inputs');

/** Build independent disposable roots and a public-host pin without network traffic. */
function fixture(t) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-contract-inputs-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const input = path.join(base, 'input'), output = path.join(base, 'output');
    fs.mkdirSync(path.join(input, 'docs/FHIR-examples'), { recursive: true });
    fs.mkdirSync(output);
    const bytes = Buffer.from('{"resourceType":"Consent","id":"synthetic"}\n');
    const name = 'docs/FHIR-examples/Consent-synthetic.json';
    fs.writeFileSync(path.join(input, name), bytes);
    const manifest = { schemaVersion: 'pcm-external-contract-inputs/2', files: [
        { path: name, url: 'https://simplifier.net/pcm-il/synthetic/$download?format=json', sha256: sha256(bytes), bytes: bytes.length }
    ] };
    return { input, output, manifest, name, bytes };
}

/** Simulate a successful public response and prohibit unnecessary real waits. */
function response(bytes, status = 200) { return new Response(bytes, { status }); }
const noWait = async () => {};

test('offline directory installation is exact, idempotent and ignores unrecorded files', t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.input, 'unrecorded.txt'), 'not a dependency');
    assert.deepEqual(install(f.output, f.input, f.manifest), { installed: 1, alreadyPresent: 0, validation: 'not run' });
    assert.deepEqual(fs.readFileSync(path.join(f.output, f.name)), f.bytes);
    assert.equal(fs.existsSync(path.join(f.output, 'unrecorded.txt')), false);
    assert.equal(install(f.output, f.input, f.manifest).alreadyPresent, 1);
    assert.equal(check(f.output, f.manifest).files, 1);
});

test('bad or missing source prevents every destination write', t => {
    const f = fixture(t);
    f.manifest.files.push({ ...f.manifest.files[0], path: 'docs/FHIR-examples/missing.json' });
    assert.throws(() => install(f.output, f.input, f.manifest), /ENOENT/);
    assert.deepEqual(fs.readdirSync(f.output), []);
    f.manifest.files.pop();
    fs.appendFileSync(path.join(f.input, f.name), 'drift');
    assert.throws(() => install(f.output, f.input, f.manifest), /does not match/);
    assert.deepEqual(fs.readdirSync(f.output), []);
    assert.throws(() => check(f.output, f.manifest), /prepare:contracts/);
});

test('conflicting files, escaped paths and symbolic ancestors are refused before copying', t => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.output, 'docs/FHIR-examples'), { recursive: true });
    fs.writeFileSync(path.join(f.output, f.name), 'local edits');
    assert.throws(() => install(f.output, f.input, f.manifest), /overwrite conflicting/);
    assert.equal(fs.readFileSync(path.join(f.output, f.name), 'utf8'), 'local edits');
    fs.unlinkSync(path.join(f.output, f.name));
    fs.symlinkSync(path.join(f.input, f.name), path.join(f.output, f.name));
    assert.throws(() => install(f.output, f.input, f.manifest), /Symbolic link/);
    for (const name of ['../escape', '/absolute', 'docs/FHIR-examples/../escape', 'docs\\escape', 'package.json']) {
        const manifest = structuredClone(f.manifest); manifest.files[0].path = name;
        assert.throws(() => install(f.output, f.input, manifest), /Invalid external/);
    }
});

test('manifest rejects duplicate identities, mutable GitHub branches and untrusted URLs', t => {
    const f = fixture(t);
    for (const url of ['http://simplifier.net/pcm-il/a/$download?format=json', 'https://example.org/payload',
        'https://raw.githubusercontent.com/MohGovIL/Swagger/main/docs/openapi.yaml',
        'https://user:password@simplifier.net/pcm-il/a/$download?format=json']) {
        const changed = structuredClone(f.manifest); changed.files[0].url = url;
        assert.throws(() => validateManifest(changed), /Untrusted or unpinned/);
    }
    const github = structuredClone(f.manifest);
    github.files[0].url = `https://raw.githubusercontent.com/MohGovIL/Swagger/${'a'.repeat(40)}/docs/openapi.yaml`;
    assert.equal(validateManifest(github).length, 1);
    f.manifest.files.push(f.manifest.files[0]);
    assert.throws(() => validateManifest(f.manifest), /Duplicate/);
});

test('public fetching caches verified bytes and supports offline rehydration without network', async t => {
    const f = fixture(t); let calls = 0;
    const fetchImpl = async (url, options) => {
        calls += 1; assert.equal(url, f.manifest.files[0].url); assert.equal(options.redirect, 'error');
        return response(f.bytes);
    };
    assert.equal((await prepare(f.output, f.manifest, { fetchImpl, sleep: noWait })).installed, 1);
    assert.equal(calls, 1);
    await prepare(f.output, f.manifest, { fetchImpl, sleep: noWait });
    assert.equal(calls, 1);
    fs.rmSync(path.join(f.output, 'docs'), { recursive: true });
    const prohibitFetch = async () => { throw new Error('Unexpected network'); };
    assert.equal((await prepare(f.output, f.manifest, { offline: true, fetchImpl: prohibitFetch })).installed, 1);
    assert.deepEqual(fs.readFileSync(path.join(f.output, f.name)), f.bytes);
});

test('a later failed download leaves destinations untouched and keeps verified cache bytes', async t => {
    const f = fixture(t);
    f.manifest.files.push({ ...f.manifest.files[0], path: 'docs/FHIR-examples/second.json', sha256: 'b'.repeat(64) });
    let calls = 0;
    await assert.rejects(prepare(f.output, f.manifest, { sleep: noWait,
        fetchImpl: async () => ++calls === 1 ? response(f.bytes) : response('missing', 404) }), /download failed \(404\)/);
    assert.equal(fs.existsSync(path.join(f.output, 'docs')), false);
    assert.deepEqual(fs.readdirSync(path.join(f.output, '.contract-inputs/cache')), [sha256(f.bytes)]);
});

test('hash/size changes and HTML login responses cannot become contract inputs', async t => {
    const f = fixture(t), file = f.manifest.files[0];
    await assert.rejects(download(file, { fetchImpl: async () => response(Buffer.alloc(file.bytes, 120)) }), /does not match/);
    await assert.rejects(download(file, { fetchImpl: async () => response(Buffer.alloc(file.bytes + 1)) }), /exceeds pinned size/);
    await assert.rejects(download(file, { fetchImpl: async () => response('<html>login</html>') }), /does not match/);
    await assert.rejects(prepare(f.output, f.manifest, { offline: true }), /offline cache/);
});

test('throttling retries are finite and never accept an exhausted response', async t => {
    const f = fixture(t); let calls = 0; const waits = [];
    assert.deepEqual(await download(f.manifest.files[0], { sleep: async ms => waits.push(ms),
        fetchImpl: async () => ++calls < 3 ? response('rate limit', 429) : response(f.bytes) }), f.bytes);
    assert.deepEqual(waits, [10000, 20000]);
    calls = 0;
    await assert.rejects(download(f.manifest.files[0], { sleep: noWait,
        fetchImpl: async () => { calls += 1; return response('outage', 503); } }), /download failed \(503\)/);
    assert.equal(calls, 5);
});

test('corrupt cache and a symlinked cache directory fail visibly', async t => {
    const f = fixture(t), directory = path.join(f.output, '.contract-inputs/cache');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, sha256(f.bytes)), 'bad cache');
    await assert.rejects(prepare(f.output, f.manifest, { offline: true }), /does not match/);
    fs.rmSync(directory, { recursive: true }); fs.symlinkSync(f.input, directory);
    await assert.rejects(prepare(f.output, f.manifest), /Symbolic link/);
});


test('committed public input lock stays external and covers the required runtime fixture families', () => {
    const lock = require('../../docs/external-contract-inputs.json');
    const policy = require('../../docs/public-release-scope.json');
    const { eligible } = require('../../scripts/public-release');
    const files = validateManifest(lock);
    assert.equal(lock.activeRelease, require('../../src/shared/pcm-contract').PCM_IG.version);
    assert.equal(files.filter(file => file.path.startsWith('docs/FHIR-examples/')).length, 60);
    for (const name of ['StructureDefinition-pcm-system-authorization-contract.json',
        'StructureDefinition-pcm-data-access-authorization-contract.json', 'ValueSet-pcm-authorization-status.json']) {
        assert.ok(files.some(file => file.path === `.contract-inputs/profiles/${name}`));
    }
    for (const file of files) assert.equal(eligible(file.path, policy), false, file.path);
    assert.ok(files.filter(file => file.url.includes('raw.githubusercontent.com')).every(file => file.url.includes(lock.swagger.commit)));
});
