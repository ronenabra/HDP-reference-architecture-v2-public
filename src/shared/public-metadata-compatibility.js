'use strict';

/** Measured source artifacts for coordinated metadata cutover; never an image/deployment attestation. */
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('./migration-hash');
const crypto = require('node:crypto');
const COMPONENT_PATHS = Object.freeze({
    pcm: ['src/pcm-core', 'src/shared', 'config'],
    doctor: ['src/sp-client', 'src/shared', 'config'],
    adapter: ['src/ds-auth-adapter', 'src/ds-gateway', 'src/shared', 'config'],
    native: ['src/ho-fhir-server', 'src/shared', 'config'],
    cli: ['pcm-connectathon/scripts', 'src/shared', 'src/pcm-core/src', 'config']
});
const EXCLUDED = new Set(['node_modules', 'target', '.git']);
/** Inventory all regular source/state files, refusing aliases and recording empty directories. */
function inventory(directory, capture = file => fs.readFileSync(file), { source = false } = {}) {
    const result = {};
    if (!fs.existsSync(directory)) return result;
    const visit = (file, relative) => {
        const stat = fs.lstatSync(file);
        if (fs.realpathSync(file) !== path.resolve(file) || stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error(`Unsafe migration inventory path ${file}`);
        if (stat.isDirectory()) {
            result[`${relative}/`] = null;
            for (const name of fs.readdirSync(file).sort()) if (!source || !EXCLUDED.has(name)) visit(path.join(file, name), relative ? `${relative}/${name}` : name);
        } else result[relative] = crypto.createHash('sha256').update(capture(file)).digest('hex');
    };
    visit(path.resolve(directory), '');
    return result;
}
/** Measure the complete fixed component source roots, including package/lock files and native sources. */
function artifacts(repositoryRoot, capture) {
    const result = {};
    for (const [component, roots] of Object.entries(COMPONENT_PATHS)) {
        const files = {};
        for (const relative of roots) {
            const directory = path.join(repositoryRoot, relative);
            if (!fs.existsSync(directory)) throw new Error(`Missing ${component} source root ${relative}`);
            for (const [name, digest] of Object.entries(inventory(directory, capture, { source: true }))) files[`${relative}/${name}`] = digest;
        }
        result[component] = `sha256:${hash({ schema: 'pcm-component-source/1', component, files })}`;
    }
    return result;
}
/** Refuse mixed component source versions before checkpoint hydration or recovery. */
function assertArtifacts(boundary) {
    require('./scope-model-versions').assertScopeVersions(boundary?.scopeVersions);
    if (boundary?.schema !== 'pcm-public-metadata-boundary/1' || boundary.publicProjectionSchema !== 'pcm-public-fhir/1'
        || boundary.privateSchema !== 'pcm-private-state/1' || hash(artifacts(boundary.repositoryRoot)) !== hash(boundary.components)) throw new Error('Metadata component/schema mismatch; keep workers stopped and review a complete compatible artifact set');
}
module.exports = { COMPONENT_PATHS, inventory, artifacts, assertArtifacts };
