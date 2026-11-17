#!/usr/bin/env node
'use strict';

/** Fetch the public contract pins into ignored local paths without changing runtime contracts. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const SCHEMA = 'pcm-external-contract-inputs/2';
const MAX_BYTES = 10 * 1024 * 1024;

/** Return the byte identity recorded in the public input lock. */
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

/** Resolve a portable path, refusing traversal and existing symbolic ancestors. */
function safePath(root, name) {
    if (typeof name !== 'string' || !name || name.includes('\\') || path.posix.isAbsolute(name)
        || name.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Invalid external contract input path');
    }
    let current = root;
    for (const part of name.split('/')) {
        current = path.join(current, part);
        try {
            if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic link refused: ${name}`);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return current;
}

/** Accept only the public hosts and ignored destinations owned by this installer. */
function validateManifest(manifest) {
    if (manifest.schemaVersion !== SCHEMA || !Array.isArray(manifest.files) || !manifest.files.length) {
        throw new Error('Unsupported external contract input manifest');
    }
    const seen = new Set();
    for (const file of manifest.files) {
        if (seen.has(file.path)) throw new Error('Duplicate external contract input');
        seen.add(file.path);
        if (!/^(?:docs\/FHIR-examples\/[^/]+\.json|\.contract-inputs\/profiles\/[^/]+\.json|docs\/openapi(?:-fhir|-oauth)?\.yaml)$/.test(file.path)) {
            throw new Error('Invalid external contract input path');
        }
        if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > MAX_BYTES) {
            throw new Error('Invalid external contract input identity');
        }
        const url = new URL(file.url);
        const github = url.hostname === 'raw.githubusercontent.com'
            && /^\/MohGovIL\/Swagger\/[a-f0-9]{40}\/docs\/openapi(?:-fhir|-oauth)?\.yaml$/.test(url.pathname) && !url.search;
        const simplifier = url.hostname === 'simplifier.net' && /^\/pcm-il\/[^/]+\/\$download$/.test(url.pathname)
            && url.search === '?format=json';
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || (!github && !simplifier)) {
            throw new Error('Untrusted or unpinned external contract input URL');
        }
    }
    return manifest.files;
}

/** Reject a bad source identity before any destination writes. */
function assertIdentity(bytes, file) {
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
        throw new Error(`External contract input does not match the recorded pin: ${file.path}`);
    }
    return bytes;
}

/** Read only regular files; missing files are distinct from conflicts and links. */
function readRegular(root, name) {
    const file = safePath(root, name);
    if (!fs.statSync(file).isFile()) throw new Error(`Input is not a regular file: ${name}`);
    return fs.readFileSync(file);
}

/** Check every destination first so a conflicting local file prevents the entire install. */
function destinationPlan(root, files) {
    const destination = fs.realpathSync(root);
    return files.map(file => {
        const target = safePath(destination, file.path);
        try {
            const bytes = readRegular(destination, file.path);
            if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
                throw new Error(`Refusing to overwrite conflicting local content: ${file.path}`);
            }
            return { ...file, target, exists: true };
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            return { ...file, target, exists: false };
        }
    });
}

/** Plan a complete offline directory copy after checking all source and target identities. */
function planInstall(root, input, manifest) {
    const plan = destinationPlan(root, validateManifest(manifest));
    const source = fs.realpathSync(input);
    return plan.map(file => ({ ...file, content: assertIdentity(readRegular(source, file.path), file) }));
}

/** Install a fully prepared plan; existing exact inputs make retries idempotent. */
function writePlan(root, plan) {
    let installed = 0;
    for (const entry of plan) {
        if (entry.exists) continue;
        const target = safePath(fs.realpathSync(root), entry.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.content, { flag: 'wx', mode: 0o644 });
        installed += 1;
    }
    return { installed, alreadyPresent: plan.length - installed, validation: 'not run' };
}

/** Copy an independently downloaded layout with the same public byte pins. */
function install(root, input, manifest) { return writePlan(root, planInstall(root, input, manifest)); }

/** Check installed inputs offline; missing dependencies fail with preparation instructions. */
function check(root, manifest) {
    for (const file of validateManifest(manifest)) {
        try { assertIdentity(readRegular(fs.realpathSync(root), file.path), file); }
        catch (error) {
            if (error.code === 'ENOENT') throw new Error(`Missing ${file.path}; run npm run prepare:contracts first`);
            throw error;
        }
    }
    return { files: manifest.files.length, status: 'pass', scope: 'public input byte identities; no private guide build verification' };
}

/** Download one bounded body, with finite retries for public-host throttling/outages. */
async function download(file, { fetchImpl = fetch, sleep = delay } = {}) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await fetchImpl(file.url, { redirect: 'error', signal: AbortSignal.timeout(45000) });
        if ((response.status === 429 || response.status >= 500) && attempt < 4) {
            const retry = Number(response.headers.get('retry-after'));
            await response.body?.cancel();
            await sleep(Number.isFinite(retry) && retry > 0 ? Math.min(retry, 60) * 1000 : (attempt + 1) * 10000);
            continue;
        }
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Public input download failed (${response.status}): ${file.path}`);
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > file.bytes) throw new Error(`Public input exceeds pinned size: ${file.path}`);
            chunks.push(Buffer.from(chunk));
        }
        return assertIdentity(Buffer.concat(chunks), file);
    }
    throw new Error(`Public input unavailable: ${file.path}`);
}

/** Fetch serially, caching verified bytes; install only after every missing pin is available. */
async function prepare(root, manifest, { offline = false, fetchImpl = fetch, sleep = delay } = {}) {
    const files = validateManifest(manifest);
    const plan = destinationPlan(root, files);
    const cacheName = '.contract-inputs/cache';
    const cache = safePath(fs.realpathSync(root), cacheName);
    let downloaded = false;
    for (const file of plan) {
        if (file.exists) continue;
        const name = `${cacheName}/${file.sha256}`;
        try { file.content = assertIdentity(readRegular(fs.realpathSync(root), name), file); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            if (offline) throw new Error(`Public input missing from offline cache: ${file.path}`);
            // Simplifier has a shared anonymous request limit. Reuse hashes and avoid concurrent downloads.
            if (downloaded) await sleep(4000);
            file.content = await download(file, { fetchImpl, sleep });
            downloaded = true;
            fs.mkdirSync(cache, { recursive: true });
            fs.writeFileSync(safePath(fs.realpathSync(root), name), file.content, { flag: 'wx', mode: 0o644 });
        }
    }
    return writePlan(root, plan);
}

/** Prepare public inputs by default; --check never uses the network. */
async function main(argv = process.argv.slice(2)) {
    const root = path.resolve(__dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs/external-contract-inputs.json')));
    let result;
    if (!argv.length) result = await prepare(root, manifest);
    else if (argv.length === 1 && argv[0] === '--offline') result = await prepare(root, manifest, { offline: true });
    else if (argv.length === 1 && argv[0] === '--check') result = check(root, manifest);
    else if (argv.length === 2 && argv[0] === '--from') result = install(root, path.resolve(argv[1]), manifest);
    else throw new Error('Usage: node scripts/install-contract-inputs.js [--offline | --check | --from DIRECTORY]');
    console.log(JSON.stringify(result));
    return result;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { install, main, planInstall, safePath, sha256, validateManifest, prepare, check, download };
