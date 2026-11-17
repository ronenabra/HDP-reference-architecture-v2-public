'use strict';

/** Explicit operator reconciliation of a still-running historical PCM, never a seed exporter. */
const fs = require('fs'), path = require('path'), https = require('https');
const checkpoint = require('../../src/pcm-core/src/migration-checkpoint');
const maintenance = require('../../src/shared/migration-maintenance');
const { RESOURCE_TYPES, FHIRStore } = require('../../src/pcm-core/src/fhir/store');

const { canonical, hash } = require('../../src/shared/migration-hash');
const read = file => JSON.parse(fs.readFileSync(file));

/** Hash exact regular files without following aliases; absent namespaces are represented too. */
function tree(directory) {
    const result = {};
    if (!fs.existsSync(directory)) return result;
    for (const name of fs.readdirSync(directory).sort()) {
        const file = path.join(directory, name), stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error(`Unsafe handoff path ${file}`);
        if (stat.isDirectory()) for (const [child, digest] of Object.entries(tree(file))) result[`${name}/${child}`] = digest;
        else result[name] = checkpoint.sha256(fs.readFileSync(file));
    }
    return result;
}

/** Verify the measured runtime source artifact, including the separately packaged bridge. */
function runtime(spec) {
    const descriptor = read(spec.runtimeDescriptor);
    if (`sha256:${hash(descriptor.artifact)}` !== spec.runtimeId || descriptor.id !== spec.runtimeId) throw new Error('Historical runtime descriptor hash mismatch');
    for (const [relative, expected] of Object.entries(descriptor.artifact.files)) {
        if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Unsafe runtime descriptor path');
        if (checkpoint.sha256(fs.readFileSync(path.join(descriptor.root, relative))) !== expected) throw new Error(`Runtime source mismatch ${relative}`);
    }
    for (const [relative, expected] of Object.entries(descriptor.artifact.bridgeSourceFiles || {})) {
        if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Unsafe bridge descriptor path');
        if (!spec.bridgeRoot || checkpoint.sha256(fs.readFileSync(path.join(spec.bridgeRoot, relative))) !== expected) throw new Error(`Bridge source mismatch ${relative}`);
    }
    return spec.runtimeId;
}

/** Capture only stable configuration, reservations and operation records; tokens are not authority backups. */
function bindings(spec) {
    maintenance.assertOperationsIdle(spec.stateDirectory); maintenance.assertConfigurationIdle(spec.stateDirectory);
    if (fs.existsSync(path.join(spec.stateDirectory, 'pcm-ig-041'))) throw new Error('Existing migration state requires its own recovery; reconciliation never overwrites it');
    const config = read(spec.configPath), catalogs = {};
    if (config.serviceCatalog?.file) {
        const root = path.dirname(spec.configPath), relative = config.serviceCatalog.file;
        if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Handoff requires a reviewed team-local catalog');
        const file = path.join(root, relative);
        if (fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file)) throw new Error('Aliased catalog cannot establish stable handoff provenance');
        catalogs[relative] = checkpoint.sha256(fs.readFileSync(file));
    }
    return { catalogs, runtimeId: runtime(spec), configHash: checkpoint.sha256(fs.readFileSync(spec.configPath)),
        reservations: Object.fromEntries(['assertion-replay', 'first-use-windows', 'data-operations'].map(name => [name, tree(path.join(spec.stateDirectory, name))])) };
}

/** Read authenticated management pages over verified TLS; credentials stay in private local files. */
function request(spec, pathname) {
    const base = new URL(spec.apiBase);
    if (base.protocol !== 'https:') throw new Error('Reconciliation requires the existing HTTPS management boundary');
    const url = new URL(pathname, base);
    if (url.origin !== base.origin) throw new Error('Cross-origin management continuation refused');
    return new Promise((resolve, reject) => {
        const req = https.get(url, { ca: fs.readFileSync(spec.caFile), ...(spec.certFile ? { cert: fs.readFileSync(spec.certFile), key: fs.readFileSync(spec.keyFile) } : {}),
            headers: { authorization: `Bearer ${fs.readFileSync(spec.tokenFile, 'utf8').trim()}`, accept: 'application/fhir+json' } }, response => {
            const chunks = []; let size = 0;
            response.on('data', chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) req.destroy(new Error('Management page exceeds capture budget')); else chunks.push(chunk); });
            response.on('end', () => { try { if (response.statusCode !== 200) throw new Error(`Management read ${url.pathname}: HTTP ${response.statusCode}; obtain a fresh authorized management token without replacing the old process`); resolve(JSON.parse(Buffer.concat(chunks))); } catch (error) { reject(error); } });
        }); req.setTimeout(10000, () => req.destroy(new Error('Management capture timeout'))); req.on('error', reject);
    });
}

/** Read visible state only; historical filters make a separate reviewed full inventory mandatory. */
async function visible(spec, get = request) {
    const resources = {};
    for (const type of RESOURCE_TYPES) {
        const rows = [], seen = new Set(); let next = `${new URL(spec.apiBase).pathname.replace(/\/$/, '')}/${type}`, total;
        for (let page = 0; next && page < 1000; page++) {
            const bundle = await get(spec, next);
            if (bundle.resourceType !== 'Bundle' || bundle.type !== 'searchset' || !Number.isSafeInteger(bundle.total)) throw new Error(`Invalid ${type} management bundle`);
            if (total !== undefined && total !== bundle.total) throw new Error(`Drifting ${type} total`);
            total = bundle.total;
            for (const entry of bundle.entry || []) {
                const resource = entry.resource;
                if (entry.search?.mode !== 'match' || resource?.resourceType !== type || !resource.id || seen.has(resource.id)) throw new Error(`Ambiguous ${type} management entry`);
                seen.add(resource.id); rows.push(resource);
            }
            const links = (bundle.link || []).filter(link => link.relation === 'next');
            if (links.length > 1) throw new Error('Ambiguous management continuation');
            if (links[0]) {
                // Logical FHIR origins differ from private transport. Preserve only this exact type's bounded path/query.
                const continuation = new URL(links[0].url, spec.apiBase), expected = `${new URL(spec.apiBase).pathname.replace(/\/$/, '')}/${type}`;
                if (continuation.pathname !== expected) throw new Error('Unexpected management continuation path');
                next = continuation.pathname + continuation.search;
            } else next = null;
        }
        if (next || rows.length !== total) throw new Error(`Incomplete ${type} visible inventory`);
        resources[type] = rows.sort((a, b) => a.id.localeCompare(b.id));
    }
    return resources;
}

/** Record repeatable reads while the original remains alive under an operator-established writer fence. */
async function observe(spec, get = request) {
    if (spec.schema !== 'pcm-handoff-observation/1' || !spec.writersIsolatedAt || !spec.isolationEvidence || !spec.processIdentity) throw new Error('Explicit stopped external writers, isolated PCM ingress and drained in-flight work evidence required');
    if (!Number.isFinite(Date.parse(spec.writersIsolatedAt)) || Date.parse(spec.writersIsolatedAt) > Date.now() - 31000) throw new Error('Drain isolated writers for at least 31 seconds before observation');
    const before = bindings(spec), first = await visible(spec, get), second = await visible(spec, get), after = bindings(spec);
    if (hash(before) !== hash(after) || hash(first) !== hash(second)) throw new Error('Authority/config/reservations changed: retain original process, re-isolate writers and capture again');
    return { schema: 'pcm-visible-observation/1', observedAt: new Date().toISOString(), bindings: before, visible: first,
        writersIsolatedAt: spec.writersIsolatedAt, isolationEvidence: spec.isolationEvidence, processIdentity: spec.processIdentity };
}

/** Import a separately reviewed authoritative inventory only after original workers have stopped. */
function importHandoff(spec, observation, resources, review, { workersStopped, stoppedAt } = {}) {
    if (!workersStopped || !Number.isFinite(Date.parse(stoppedAt)) || Date.parse(stoppedAt) < Date.parse(observation.observedAt) || Date.parse(stoppedAt) > Date.now() - 31000) throw new Error('Stop all workers after observation, retain isolation, then drain 31 seconds before importing');
    if (observation.schema !== 'pcm-visible-observation/1' || !observation.processIdentity || hash(bindings(spec)) !== hash(observation.bindings)) throw new Error('Stopped-state provenance/config/reservation mismatch; preserve original and reconcile');
    if (review.schema !== 'pcm-handoff-review/1' || review.approved !== true || !review.reviewedBy || !review.reviewedAt || review.observationHash !== hash(observation) || review.inventoryHash !== hash(resources)
        || review.completeFiveTypeInventory !== true || review.noSeedReconstruction !== true || !review.inventoryProvenance || review.processIdentity !== observation.processIdentity
        || review.isolationMaintainedUntilStopped !== true) throw new Error('Independent complete inventory approval/provenance required; filtered reads alone cannot establish completeness');
    checkpoint.hydrate(new FHIRStore(), resources);
    const omitted = [];
    for (const type of RESOURCE_TYPES) {
        const observed = new Map(observation.visible[type].map(resource => [resource.id, resource]));
        for (const resource of resources[type]) {
            if (observed.has(resource.id)) {
                if (hash(observed.get(resource.id)) !== hash(resource)) throw new Error(`Live decision mismatch ${type}/${resource.id}`);
                observed.delete(resource.id);
            } else omitted.push({ identity: `${type}/${resource.id}`, hash: hash(resource) });
        }
        if (observed.size) throw new Error(`Full inventory omits live ${type} decisions`);
    }
    if (hash(omitted.sort((a, b) => a.identity.localeCompare(b.identity))) !== hash((review.hiddenResources || []).map(({ identity, hash: digest }) => ({ identity, hash: digest })).sort((a, b) => a.identity.localeCompare(b.identity)))
        || (review.hiddenResources || []).some(resource => !resource.provenance)) throw new Error('Every hidden resource requires exact separately reviewed bytes/hash and authoritative provenance');
    const root = path.join(spec.stateDirectory, 'pcm-ig-041'), bytes = checkpoint.encode(resources);
    const manifest = { schema: 'pcm-migration/1', phase: 'rolled-back', runtimeId: spec.runtimeId, configHash: observation.bindings.configHash, checkpointHash: checkpoint.sha256(bytes),
        handoff: { schema: 'pcm-reconciled-handoff/1', reviewedBy: review.reviewedBy, inventoryHash: review.inventoryHash, observationHash: review.observationHash, reviewHash: hash(review), stoppedAt } };
    // Retain a fail-closed fence until every private provenance file has been durably published.
    fs.writeFileSync(maintenance.fencePath(spec.stateDirectory), spec.runtimeId, { flag: 'wx', mode: 0o600 });
    fs.mkdirSync(root);
    for (const [name, value] of Object.entries({ 'checkpoint.json': resources, 'handoff-observation.json': observation, 'handoff-review.json': review, 'manifest.json': manifest })) checkpoint.atomicWrite(path.join(root, name), checkpoint.encode(value));
    fs.rmSync(maintenance.fencePath(spec.stateDirectory));
    return manifest;
}

/** Finish only an operator-reviewed uncertain store publication with every worker stopped. */
function recoverMutation({ stateDirectory, configPath, certsDirectory, runtimeId, workersStopped, expectedDigest }) {
    if (fs.existsSync(path.join(stateDirectory, 'configuration-mutation', 'source-publication.json'))) return require('../../src/pcm-core/src/source-publication-recovery').recover({
        stateDirectory, configPath, certsDirectory: certsDirectory || read(configPath).runtime.certsDir, workersStopped, expectedDigest });
    const root = path.join(stateDirectory, 'pcm-ig-041'), journalPath = path.join(root, 'checkpoint-mutation.json');
    const journal = read(journalPath);
    if (!workersStopped || hash(journal) !== expectedDigest || journal.schema !== 'pcm-checkpoint-mutation/1') throw new Error('Stop workers and explicitly review the exact checkpoint-mutation journal digest before recovery');
    const before = Buffer.from(journal.before, 'base64'), after = Buffer.from(journal.after, 'base64'), manifest = journal.manifest;
    const currentHash = checkpoint.sha256(fs.readFileSync(path.join(root, 'checkpoint.json')));
    const nextManifest = { ...manifest, checkpointHash: checkpoint.sha256(after) }, currentManifest = read(path.join(root, 'manifest.json'));
    if (runtimeId !== manifest.runtimeId || checkpoint.sha256(fs.readFileSync(configPath)) !== manifest.configHash
        || ![checkpoint.sha256(before), checkpoint.sha256(after)].includes(currentHash)
        || ![hash(manifest), hash(nextManifest)].includes(hash(currentManifest))) throw new Error('Conflicting uncertain publication; keep stopped and preserve all bytes for independent reconciliation');
    maintenance.assertOperationsIdle(stateDirectory); maintenance.assertConfigurationIdle(stateDirectory);
    checkpoint.hydrate(new FHIRStore(), JSON.parse(after));
    checkpoint.atomicWrite(path.join(root, 'checkpoint.json'), after);
    checkpoint.atomicWrite(path.join(root, 'manifest.json'), checkpoint.encode(nextManifest));
    fs.rmSync(journalPath); fs.rmSync(maintenance.fencePath(stateDirectory), { force: true });
    return { status: 'recovered-reviewed-mutation', checkpointHash: nextManifest.checkpointHash };
}

/** CLI accepts private JSON files, keeping credentials and approval out of command-line process listings. */
async function main(argv) {
    const mode = argv.shift(), options = {};
    while (argv.length) { const key = argv.shift(); if (key === '--workers-stopped') options.workersStopped = true; else { if (!key.startsWith('--') || !argv.length) throw new Error('Expected --name value'); options[key.slice(2)] = argv.shift(); } }
    const spec = read(options.spec);
    if (mode === 'observe') {
        const observation = await observe(spec); fs.writeFileSync(options.output, checkpoint.encode(observation), { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ status: 'visible-only-needs-independent-inventory-review', observationHash: hash(observation) }));
    } else if (mode === 'recover-mutation') console.log(JSON.stringify(recoverMutation({ ...spec, workersStopped: options.workersStopped, expectedDigest: options['expected-digest'] })));
    else if (mode === 'import') console.log(JSON.stringify(importHandoff(spec, read(options.observation), read(options.inventory), read(options.review), { workersStopped: options.workersStopped, stoppedAt: options['stopped-at'] })));
    else throw new Error('Use observe --spec PRIVATE.json --output OBSERVATION.json, or import --spec PRIVATE.json --observation FILE --inventory FILE --review FILE --workers-stopped --stopped-at UTC');
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { bindings, canonical, hash, importHandoff, observe, runtime, tree, visible, recoverMutation };
