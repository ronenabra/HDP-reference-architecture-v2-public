'use strict';

/** Scoped retained-log/state validation and explicit offline ownership repair. */
const fs = require('node:fs');
const path = require('node:path');
const { permits } = require('./hapi-log-preflight');
const REPAIR_IMAGE = 'node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53';

/** Collect an entire tree before mutation; links and special files are never repaired.
 * @param {string} root Tree root.
 * @param {object} io Filesystem implementation.
 * @returns {Array<{target: string, stat: object}>} Validated entries.
 */
function collectTree(root, io = fs) {
    const paths = [];
    /** Inspect each descendant without following filesystem links. */
    function visit(target) {
        const stat = io.lstatSync(target);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink > 1)) {
            throw new Error(`Runtime preflight: unsafe link or special file: ${target}; resolve it manually before retrying`);
        }
        paths.push({ target, stat });
        if (stat.isDirectory()) for (const name of io.readdirSync(target)) visit(path.join(target, name));
    }
    visit(root);
    return paths;
}

/** Reject aliased ancestors before creating or mounting any selected-team directory.
 * @param {string} teamDir Selected team directory.
 * @returns {void}
 */
function assertSafeTeamPath(teamDir) {
    let current = path.resolve(teamDir);
    while (true) {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Runtime preflight: symlink ancestor: ${current}`);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
}

/** Mark only access failures as eligible for automatic ownership repair. */
function accessFailure(message) {
    const error = new Error(message);
    error.code = 'PCM_RUNTIME_ACCESS';
    return error;
}

/** Validate service identity and report the exact access failure without changing contents.
 * @param {string} teamDir Selected team directory.
 * @param {number} uid Service user ID.
 * @param {number} gid Service group ID.
 * @returns {void}
 */
function checkRuntimeMounts(teamDir, uid, gid) {
    if (![uid, gid].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('LOCAL_UID and LOCAL_GID must be nonnegative integers');
    assertSafeTeamPath(teamDir);
    for (const name of ['logs', 'state']) {
        const root = path.join(teamDir, name);
        if (!fs.existsSync(root)) fs.mkdirSync(root);
        if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error(`Runtime preflight: unsafe directory ${root}`);
        let entries;
        try { entries = collectTree(root); }
        catch (error) {
            if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
            const stat = fs.lstatSync(error.path || root);
            throw accessFailure(`Runtime preflight: cannot inspect ${error.path} (${error.code}), owner=${stat.uid}:${stat.gid} mode=${(stat.mode & 0o777).toString(8)}, service ${uid}:${gid}; retry start-local-team.js with --force to repair retained logs/state`);
        }
        for (const { target, stat } of entries) {
            const bits = stat.isDirectory() ? 7 : 6;
            let accessible = permits(stat, uid, gid, bits);
            if (accessible && uid === process.getuid?.() && gid === process.getgid?.()) {
                try { fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK | (stat.isDirectory() ? fs.constants.X_OK : 0)); }
                catch { accessible = false; }
            }
            if (!accessible) throw accessFailure(`Runtime preflight: ${target} owner=${stat.uid}:${stat.gid} mode=${(stat.mode & 0o777).toString(8)} is inaccessible to service ${uid}:${gid}; retry start-local-team.js with --force (stops this team and repairs retained logs/state without deleting them)`);
        }
    }
}

/** Repair prevalidated trees, retaining bytes and existing group/other permission bits.
 * @param {string[]} roots Explicit writable mount roots.
 * @param {number} uid Intended service user ID.
 * @param {number} gid Intended service group ID.
 * @param {object} io Filesystem implementation.
 * @returns {number} Number of repaired entries.
 */
function repairTrees(roots, uid, gid, io = fs) {
    if (![uid, gid].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid runtime repair identity');
    const entries = roots.flatMap(root => collectTree(root, io));
    for (const { target, stat } of entries) {
        io.chownSync(target, uid, gid);
        io.chmodSync(target, (stat.mode & 0o777) | (stat.isDirectory() ? 0o700 : 0o600));
    }
    return entries.length;
}

/** Use a pinned local utility image with only logs/state writable after the caller stops the team.
 * @param {string} teamDir Selected stopped team directory.
 * @param {number} uid Intended service user ID.
 * @param {number} gid Intended service group ID.
 * @param {Function} run Synchronous command runner; must throw on failure.
 * @returns {void}
 */
function repairRuntimeMounts(teamDir, uid, gid, run) {
    if (![uid, gid].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid runtime repair identity');
    // A healthy retained team needs no privileged helper or utility image.
    try { checkRuntimeMounts(teamDir, uid, gid); return; }
    catch (error) { if (error.code !== 'PCM_RUNTIME_ACCESS') throw error; }
    assertSafeTeamPath(teamDir);
    for (const name of ['logs', 'state']) {
        const root = path.join(teamDir, name);
        if (!fs.existsSync(root)) fs.mkdirSync(root);
        if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error(`Runtime preflight: unsafe mount ${root}`);
    }
    try {
        run('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--user', '0:0',
            '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE',
            '--mount', `type=bind,src=${path.resolve(teamDir, 'logs')},dst=/repair/logs`,
            '--mount', `type=bind,src=${path.resolve(teamDir, 'state')},dst=/repair/state`,
            '--mount', `type=bind,src=${__dirname},dst=/helper,readonly`,
            REPAIR_IMAGE, 'node', '/helper/runtime-mount-preflight.js', String(uid), String(gid)]);
        checkRuntimeMounts(teamDir, uid, gid);
    } catch (error) {
        throw new Error(`Runtime ownership repair failed for ${teamDir}: ${error.message}. Team remains stopped; correct ownership/permissions on its logs/state manually, then retry. No files were deleted.`);
    }
}

if (require.main === module) {
    try { console.log(JSON.stringify({ phase: 'runtime-mount-repair', paths: repairTrees(['/repair/logs', '/repair/state'], Number(process.argv[2]), Number(process.argv[3])) })); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { checkRuntimeMounts, repairRuntimeMounts, repairTrees, collectTree, assertSafeTeamPath, REPAIR_IMAGE };
