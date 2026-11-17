#!/usr/bin/env node
'use strict';

/** Public-only source and offline-image packaging. Never publishes or changes Git refs. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

/** Execute an argument vector and preserve failures without shell interpretation. */
function execute(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
    if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.status}`);
    return result.stdout;
}

/** Return a stable SHA-256 for source bytes. */
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

/** Read a single blob from the explicitly resolved immutable tree. */
function blob(root, tree, name) {
    return execute('git', ['cat-file', 'blob', `${tree}:${name}`], { cwd: root, encoding: null });
}

/** Apply the public allowlist; exclusions and restricted-subtree closure always win. */
function eligible(name, policy) {
    const included = [...policy.includeFiles, ...policy.includeScripts].includes(name)
        || [...policy.includeDirectories, ...policy.includeAdditionalDirectories].some(prefix => name.startsWith(prefix));
    if (!included) return false;
    if (policy.excludeFiles.includes(name) || policy.excludeBasenames.includes(path.posix.basename(name))) return false;
    if (policy.excludeDirectories.some(prefix => name.startsWith(prefix))) return false;
    if (name.split('/').some(segment => policy.excludePathSegments.includes(segment))) return false;
    // Only named, maintained regression fixtures may bypass the gzip exclusion.
    // Directory, secret-file and all other suffix exclusions still take precedence.
    if (policy.excludeSuffixes.some(suffix => name.endsWith(suffix)
        && !(suffix === '.gz' && (policy.includeCompressedFixtures || []).includes(name)))) return false;
    for (const [prefix, allowed] of Object.entries(policy.restrictedDirectories || {})) {
        if (name.startsWith(prefix) && !allowed.includes(name)) return false;
    }
    return true;
}

/** Replace links to intentionally omitted development-only files with readable plain text. */
function projectLinks(text, file, selected) {
    let changes = 0;
    const projected = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g, (whole, label, target) => {
        if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return whole;
        const withoutFragment = target.split('#')[0];
        let decoded;
        try { decoded = decodeURIComponent(withoutFragment); } catch (_) { return whole; }
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), decoded));
        if (selected.has(resolved) || [...selected].some(name => name.startsWith(`${resolved}/`))) return whole;
        changes += 1;
        return `${label} (development-only reference omitted)`;
    });
    return { text: projected, changes };
}

/** Export only regular Git blobs, recording every original and projected byte hash. */
function exportSource({ root, ref, output }) {
    if (!ref || !output) throw new Error('export requires --ref <commit-or-tree> and --output <new-directory>');
    const tree = execute('git', ['rev-parse', '--verify', `${ref}^{tree}`], { cwd: root }).trim();
    const policyBytes = blob(root, tree, 'docs/public-release-scope.json');
    const policy = JSON.parse(policyBytes);
    const entries = execute('git', ['ls-tree', '-r', '-z', tree], { cwd: root }).split('\0').filter(Boolean).map(row => {
        const match = row.match(/^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/);
        if (!match) throw new Error('invalid Git tree entry');
        return { mode: match[1], type: match[2], oid: match[3], name: match[4] };
    }).filter(entry => eligible(entry.name, policy));
    for (const entry of entries) {
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`public source refuses links/submodules/special entries: ${entry.name}`);
        if (path.posix.isAbsolute(entry.name) || entry.name.split('/').includes('..')) throw new Error('unsafe Git path');
    }
    const destination = path.resolve(output);
    if (fs.existsSync(destination)) throw new Error('export output must not already exist');
    fs.mkdirSync(destination, { recursive: true });
    const selected = new Set(entries.map(entry => entry.name));
    const files = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const original = blob(root, tree, entry.name);
        const immutable = entry.name.startsWith('vendor/') || entry.name === 'docs/pcm_process_flow.md';
        const projection = entry.name.endsWith('.md') && !immutable ? projectLinks(original.toString('utf8'), entry.name, selected) : null;
        const bytes = projection ? Buffer.from(projection.text) : original;
        const target = path.join(destination, entry.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
        files.push({ path: entry.name, bytes: bytes.length, sha256: digest(bytes), sourceSha256: digest(original), mode: entry.mode, omittedLinks: projection?.changes || 0 });
    }
    const manifest = { schemaVersion: 'pcm-public-source/1', sourceRef: ref, sourceTree: tree,
        policySha256: digest(policyBytes), platform: 'linux/amd64', pcmIgRelease: policy.pcmIgRelease,
        publication: 'Source inventory. See the repository release tags for publication status.', files };
    fs.writeFileSync(path.join(destination, 'PUBLIC_SOURCE_MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
}

/** Verify exact staged bytes and reject unrecorded files or filesystem links. */
function verifySource(root, { allowGenerated = false } = {}) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'PUBLIC_SOURCE_MANIFEST.json')));
    const expected = new Set(['PUBLIC_SOURCE_MANIFEST.json', ...manifest.files.map(file => file.path)]);
    function walk(directory) {
        for (const name of fs.readdirSync(directory)) {
            const target = path.join(directory, name), stat = fs.lstatSync(target), relative = path.relative(root, target).split(path.sep).join('/');
            if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`unsafe staged entry: ${relative}`);
            if (stat.isDirectory()) walk(target);
            else if (!expected.has(relative)) throw new Error(`unrecorded staged file: ${relative}`);
        }
    }
    if (!allowGenerated) walk(root);
    for (const file of manifest.files) {
        const absolute = path.resolve(root, file.path);
        if (!absolute.startsWith(path.resolve(root) + path.sep) || fs.lstatSync(absolute).isSymbolicLink()
            || !fs.realpathSync(absolute).startsWith(fs.realpathSync(root) + path.sep)) throw new Error('unsafe source manifest path');
        if (fs.statSync(absolute).mode & 0o7000) throw new Error(`unsafe source permission bits: ${file.path}`);
        if (digest(fs.readFileSync(path.join(root, file.path))) !== file.sha256) throw new Error(`source hash mismatch: ${file.path}`);
    }
    return manifest;
}

/** Make a byte-reproducible source archive using only the pristine verified export. */
function archiveSource(source, output) {
    const manifest = verifySource(source);
    if (fs.existsSync(output)) throw new Error('archive output already exists');
    execute('tar', ['--sort=name', '--format=gnu', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
        '--use-compress-program=gzip -n', '--create', '--file', path.resolve(output), '--directory', path.resolve(source), '.']);
    return { schemaVersion: 'pcm-public-source-archive/1', sourceTree: manifest.sourceTree, sha256: fileDigest(output), bytes: fs.statSync(output).size };
}

/** Stream a file checksum without buffering an image archive in memory. */
function fileDigest(file) {
    const hash = crypto.createHash('sha256'), descriptor = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
    try { let size; while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size)); }
    finally { fs.closeSync(descriptor); }
    return hash.digest('hex');
}

/** Require the exact complete image-role specification and source-manifest binding. */
function verifyImageManifest(source, manifest) {
    const sourceManifest = JSON.parse(fs.readFileSync(path.join(source, 'PUBLIC_SOURCE_MANIFEST.json')));
    const spec = JSON.parse(fs.readFileSync(path.join(source, 'docs/public-image-spec.json')));
    if (manifest.schemaVersion !== 'pcm-public-images/1' || manifest.sourceTree !== sourceManifest.sourceTree
        || manifest.sourceManifestSha256 !== fileDigest(path.join(source, 'PUBLIC_SOURCE_MANIFEST.json'))) throw new Error('image package does not match this source tree');
    for (const version of [manifest.version, manifest.hapiVersion]) {
        if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(version)) throw new Error('invalid packaged image version');
    }
    if (!Array.isArray(manifest.images) || manifest.images.length !== spec.images.length) throw new Error('incomplete packaged image roles');
    for (const entry of spec.images) {
        const expected = entry.reference.replaceAll('${VERSION}', manifest.version).replaceAll('${HAPI_VERSION}', manifest.hapiVersion);
        const found = manifest.images.filter(image => image.reference === expected);
        if (found.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(found[0].id)
            || JSON.stringify(found[0].roles) !== JSON.stringify(entry.roles)) throw new Error(`missing or mismatched packaged image: ${expected}`);
    }
    return manifest;
}

/** Preserve immutable OCI index identities; the classic store rewrites them on load. */
function assertSupportedImageStore(info) {
    if (!info.DriverStatus?.some(row => row[0] === 'driver-type' && row[1] === 'io.containerd.snapshotter.v1')) {
        throw new Error('prepared image archives require the qualified Docker containerd image store; classic image-store installation is not qualified (do not change a retained daemon automatically)');
    }
}

/** Build or collect complete local images, preserving immutable platform/layer identities. */
function packageImages({ source, output, version, hapiVersion, build = false }) {
    if (!source || !output || !version) throw new Error('images requires --source, --output and --version');
    const sourceManifest = verifySource(source);
    assertSupportedImageStore(JSON.parse(execute('docker', ['info', '--format', '{{json .}}'])));
    const spec = JSON.parse(fs.readFileSync(path.join(source, 'docs/public-image-spec.json')));
    const records = [];
    fs.mkdirSync(output, { recursive: true });
    if (fs.existsSync(path.join(output, 'images.tar'))) throw new Error('images.tar already exists; use a new output directory');
    for (const entry of spec.images) {
        const reference = entry.reference.replaceAll('${VERSION}', version).replaceAll('${HAPI_VERSION}', hapiVersion || version);
        if (build && entry.context) execute('docker', ['build', '--tag', reference, path.join(source, entry.context)], { stdio: 'inherit' });
        const inspected = JSON.parse(execute('docker', ['image', 'inspect', reference]))[0];
        if (inspected.Os !== 'linux' || inspected.Architecture !== 'amd64') throw new Error(`unsupported image platform: ${reference}`);
        // A digest-only save has no RepoTags; Docker load then cannot resolve
        // the repository@digest used by Compose. Include its canonical tag,
        // pointing at the exact same immutable index, without overwriting one.
        const archiveReference = reference.split('@')[0];
        if (archiveReference !== reference) {
            const existing = spawnSync('docker', ['image', 'inspect', archiveReference], { encoding: 'utf8' });
            if (existing.status === 0 && JSON.parse(existing.stdout)[0].Id !== inspected.Id) throw new Error(`refusing to replace an unrelated local tag: ${archiveReference}`);
            execute('docker', ['image', 'tag', inspected.Id, archiveReference]);
        }
        records.push({ roles: entry.roles, reference, id: inspected.Id, repoDigests: inspected.RepoDigests || [],
            archiveReference, platform: `${inspected.Os}/${inspected.Architecture}`, layers: inspected.RootFS.Layers, context: entry.context || null });
    }
    const archive = path.join(output, 'images.tar');
    if (fs.existsSync(archive)) throw new Error('images.tar already exists; use a new output directory');
    execute('docker', ['image', 'save', '--output', archive, ...records.map(record => record.archiveReference)], { stdio: 'inherit' });
    const manifest = { schemaVersion: 'pcm-public-images/1', sourceTree: sourceManifest.sourceTree,
        sourceManifestSha256: fileDigest(path.join(source, 'PUBLIC_SOURCE_MANIFEST.json')),
        version, hapiVersion: hapiVersion || version, platform: 'linux/amd64', imageStore: 'containerd', archive: 'images.tar',
        archiveSha256: fileDigest(archive), archiveBytes: fs.statSync(archive).size, images: records,
        publication: 'LOCAL ONLY; no registry or Git push performed' };
    fs.writeFileSync(path.join(output, 'image-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
}

/** Verify/load only the package archive; never builds or pulls missing images. */
function loadImages(directory) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'image-manifest.json')));
    assertSupportedImageStore(JSON.parse(execute('docker', ['info', '--format', '{{json .}}'])));
    if (manifest.archive !== 'images.tar') throw new Error('unexpected image archive path');
    const archive = path.join(directory, manifest.archive);
    if (fileDigest(archive) !== manifest.archiveSha256) throw new Error('image archive checksum mismatch');
    for (const image of manifest.images) {
        const existing = spawnSync('docker', ['image', 'inspect', image.archiveReference || image.reference], { encoding: 'utf8' });
        if (existing.status === 0 && JSON.parse(existing.stdout)[0].Id !== image.id) throw new Error(`refusing to replace an unrelated local tag: ${image.archiveReference || image.reference}`);
    }
    execute('docker', ['image', 'load', '--input', archive], { stdio: 'inherit' });
    for (const image of manifest.images) {
        const actual = JSON.parse(execute('docker', ['image', 'inspect', image.reference]))[0];
        if (actual.Id !== image.id) throw new Error(`loaded image identity mismatch: ${image.reference}`);
    }
    return manifest;
}

/** Parse simple named CLI arguments without evaluating shell text. */
function argumentsMap(args) {
    const result = {};
    for (let index = 0; index < args.length; index += 1) {
        if (!args[index].startsWith('--')) throw new Error(`unexpected argument: ${args[index]}`);
        const key = args[index].slice(2);
        result[key] = args[index + 1] && !args[index + 1].startsWith('--') ? args[++index] : true;
    }
    return result;
}

/** Public packaging CLI. */
function main(argv = process.argv.slice(2)) {
    const [command, ...rest] = argv, args = argumentsMap(rest);
    const root = path.resolve(__dirname, '..');
    let result;
    if (command === 'export') result = exportSource({ root, ref: args.ref, output: args.output });
    else if (command === 'verify-source') result = verifySource(path.resolve(args.source));
    else if (command === 'archive') result = archiveSource(path.resolve(args.source), path.resolve(args.output));
    else if (command === 'images') result = packageImages({ source: path.resolve(args.source), output: path.resolve(args.output), version: args.version, hapiVersion: args['hapi-version'], build: args.build === true });
    else if (command === 'load') result = loadImages(path.resolve(args.package));
    else throw new Error('usage: public-release.js export|verify-source|images|load [named options]; see docs/public-quickstart.md');
    console.log(JSON.stringify({ status: 'pass', schemaVersion: result.schemaVersion, sourceTree: result.sourceTree, files: result.files?.length, images: result.images?.length }));
    return result;
}

if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { archiveSource, argumentsMap, assertSupportedImageStore, blob, digest, eligible, execute, exportSource, fileDigest, loadImages, main, packageImages, projectLinks, verifyImageManifest, verifySource };
