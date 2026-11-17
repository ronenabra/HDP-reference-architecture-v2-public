'use strict';

/** Validate only the selected team's native import-log mounts before startup. */
const fs = require('node:fs');
const path = require('node:path');

/** Whether a service UID/GID has the required POSIX permission bits on a path. */
function permits(stat, uid, gid, bits) {
    if (uid === 0) return true;
    const mode = stat.uid === uid ? stat.mode >> 6 : stat.gid === gid ? stat.mode >> 3 : stat.mode;
    return (mode & bits) === bits;
}

/** Prepare fresh mounts and fail early on reused paths inaccessible to the HAPI identity.
 * Only per-HO diagnostic paths are considered; data, keys and operation locks are untouched.
 */
function prepareHapiLogMounts(teamDir, healthOrganizations, uid, gid, io = fs) {
    if (![uid, gid].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('LOCAL_UID and LOCAL_GID must be nonnegative integers');
    const logRoot = path.join(teamDir, 'logs');
    io.mkdirSync(logRoot, { recursive: true });
    // Validate the shared parent before creating a per-HO path through it.
    const rootStat = io.lstatSync(logRoot);
    if (rootStat.isSymbolicLink()) throw new Error(`HAPI log root must not be a symlink: ${logRoot}`);
    if (!permits(rootStat, uid, gid, 1)) {
        throw new Error(`HAPI log preflight: ${logRoot} is owned by ${rootStat.uid}:${rootStat.gid} mode ${(rootStat.mode & 0o777).toString(8)} and is not traversable by service ${uid}:${gid}. Stop this team and correct ownership/permissions only on this named log path, then retry start-local-team.js.`);
    }
    const checked = [];
    for (const ho of healthOrganizations) {
      for (const suffix of ['hapi', 'hapi-runtime']) {
        if (!/^ho-[a-z0-9-]+$/.test(ho.id)) throw new Error('Unsafe HAPI log source identity');
        const directory = path.join(teamDir, 'logs', `${ho.id}-${suffix}`);
        io.mkdirSync(directory, { recursive: true });
        const paths = [directory];
        const walk = current => {
            for (const entry of io.readdirSync(current, { withFileTypes: true })) {
                const target = path.join(current, entry.name);
                if (entry.isSymbolicLink()) throw new Error(`HAPI log path must not be a symlink: ${target}`);
                paths.push(target);
                if (entry.isDirectory()) walk(target);
            }
        };
        if (io.lstatSync(directory).isSymbolicLink()) throw new Error(`HAPI log mount must not be a symlink: ${directory}`);
        walk(directory);
        for (const target of paths) {
            const stat = io.statSync(target);
            const bits = stat.isDirectory() ? 7 : 6;
            if (!permits(stat, uid, gid, bits)) {
                throw new Error(`HAPI log preflight: ${target} is owned by ${stat.uid}:${stat.gid} mode ${(stat.mode & 0o777).toString(8)} and is not writable by service ${uid}:${gid}. Stop this team and correct ownership/permissions only on this named log path, then retry start-local-team.js.`);
            }
            // Where the service and host identity agree, include ACL/filesystem checks.
            if (uid === process.getuid?.() && gid === process.getgid?.()) io.accessSync(target, fs.constants.R_OK | fs.constants.W_OK | (stat.isDirectory() ? fs.constants.X_OK : 0));
            checked.push(target);
        }
    }
      }
    return checked;
}

module.exports = { permits, prepareHapiLogMounts };
